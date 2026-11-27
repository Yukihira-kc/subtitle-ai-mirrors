'use strict';

const defaultDeadlineMs = 4500;

// Limit simultaneous requests across all rooms. Desk publication does not wait
// for inference, and a slow request does not prevent the next one from starting.
function createAiQueue() {
  const pending = [];
  let running = 0;
  function drain() {
    while (running < 3 && pending.length) {
      const job = pending.shift();
      running++;
      Promise.resolve().then(job).finally(() => { running--; drain(); });
    }
  }
  return job => { pending.push(job); drain(); };
}

async function reviewUntilAbort(review, request) {
  const {signal} = request;
  signal.throwIfAborted();
  let abort;
  const canceled = new Promise((_,reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
  });
  try {
    return await Promise.race([review(request),canceled]);
  } finally {
    signal.removeEventListener('abort',abort);
  }
}

function createAiBoxReview({schedule, provider, clip, notify, appendToDraft, onTake, retainReplay, dictionary, timeoutMs=defaultDeadlineMs}) {
  const entries = new Map();
  const lifetime = new AbortController();
  const deadlineMs = Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000
    ? timeoutMs : defaultDeadlineMs;
  let nextToRelease = 1;
  let acquiredId = 0;

  function status(entry) {
    return {aiStatus:entry.state, aiError:entry.error, attempt:entry.attempt,
      delivered:entry.delivered, acquired:entry.id <= acquiredId};
  }

  function card(entry) {
    const {id, version, approx, delivered, corrected} = entry;
    return {id, version, approx, text:delivered ? corrected : '', audio:!!clip(id,version), ...status(entry)};
  }

  function update(entry) { notify(card(entry)); }

  function releaseInOrder(completed) {
    if (completed.id !== nextToRelease) update(completed);
    let entry;
    while ((entry = entries.get(nextToRelease)) && (entry.state === 'ready' || entry.state === 'audio-only')) {
      nextToRelease++;
      entry.delivered = true;
      update(entry);
    }
  }

  async function run(entry, review) {
    if (lifetime.signal.aborted) return;
    const audio = clip(entry.id,entry.version);
    for (let attempt = 1; attempt <= 2; attempt++) {
      entry.attempt = attempt;
      entry.state = attempt === 1 ? 'processing' : 'retrying';
      update(entry);
      const deadline = AbortSignal.timeout(attempt === 1 ? deadlineMs : Math.min(60_000,deadlineMs * 2));
      const signal = AbortSignal.any([lifetime.signal,deadline]);
      try {
        const activeDictionary = entry.dictionary?.expiresAt > Date.now() ? entry.dictionary : undefined;
        const corrected = await reviewUntilAbort(review,{audio,text:entry.original,signal,dictionary:activeDictionary});
        signal.throwIfAborted();
        if (typeof corrected !== 'string' || !corrected.trim()) throw new Error('Empty Gemini result');
        entry.corrected = corrected.trim();
        entry.state = 'ready';
        entry.error = '';
        break;
      } catch (error) {
        if (lifetime.signal.aborted) return;
        entry.error = deadline.aborted ? 'Geminiの応答が時間内に届きませんでした。'
          : error?.status === 429 ? 'Geminiの利用上限に達したか、混み合っています。'
          : 'Geminiで聞き直しができませんでした。';
        if (attempt === 2) entry.state = 'audio-only';
      }
    }
    entry.dictionary = undefined;
    releaseInOrder(entry);
  }

  return {
    get available() { return !!provider(); },
    get acquiredId() { return acquiredId; },
    accept({id,version,approx,text,recognition=null}) {
      const entry = {id,version,approx,original:text,recognition,corrected:'',error:'',state:'queued',attempt:0,delivered:false,
        dictionary:dictionary?.()};
      entries.set(id,entry);
      update(entry);
      const review = provider();
      schedule(() => run(entry,review));
    },
    comparisonBoxes() {
      return [...entries.values()].map(({id,original,corrected,recognition,state})=>
        ({id,original,corrected:corrected || null,recognition,state}));
    },
    list() { return [...entries.values()].map(card); },
    status(id) { const entry = entries.get(id); return entry && status(entry); },
    refresh(id) { const entry = entries.get(id); if (entry) update(entry); },
    take(id) {
      const entry = entries.get(id);
      if (!entry?.delivered || (id !== acquiredId && id !== acquiredId + 1))
        return {ok:false,error:'デスクが送った順に、次の箱を取得してください。'};
      if (id !== acquiredId) {
        if (entry.state === 'ready') appendToDraft(id,entry.corrected);
        if (acquiredId) retainReplay(acquiredId);
        acquiredId = id;
        onTake?.(id,entry.state === 'audio-only');
        update(entry);
      }
      return {ok:true,box:card(entry)};
    },
    dispose() { lifetime.abort(); entries.clear(); },
  };
}

module.exports = {createAiQueue,createAiBoxReview};
