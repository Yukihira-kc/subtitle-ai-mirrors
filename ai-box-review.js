'use strict';

const defaultDeadlineMs = 4500;

// Limit simultaneous requests across all rooms. Desk publication does not wait
// for inference, and a slow request does not prevent the next one from starting.
function createAiQueue(review) {
  const pending = [];
  let running = 0;
  function drain() {
    while (running < 3 && pending.length) {
      const job = pending.shift();
      running++;
      Promise.resolve().then(() => job(review)).finally(() => { running--; drain(); });
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

function createAiBoxReview({schedule, clip, notify, deliver, retainReplay, timeoutMs=defaultDeadlineMs}) {
  const entries = new Map();
  const lifetime = new AbortController();
  const deadlineMs = Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000
    ? timeoutMs : defaultDeadlineMs;
  let next = 1;

  function card(entry) {
    const {id, version, approx, state, corrected, error, delivered, outOfSequence, original} = entry;
    return {id, version, approx, text:corrected, audio:!!clip(id,version), aiStatus:state, aiError:error,
      delivered, outOfSequence, ...(outOfSequence && {original})};
  }
  function update(entry) { notify(card(entry)); }

  // Successful first attempts enter the draft in desk order. A failure is a
  // completed decision, and a manual retry never takes its queue position back.
  function advance() {
    let entry;
    while ((entry = entries.get(next)) && (entry.state === 'ready' || entry.outOfSequence)) {
      next++;
      if (!entry.outOfSequence) {
        deliver(entry.id,entry.corrected);
        entry.delivered = true;
        update(entry);
      }
      retainReplay(entry.id);
    }
  }

  function fail(entry, error) {
    entry.state = 'failed';
    entry.error = error;
    entry.outOfSequence = true;
    update(entry);
    advance();
  }

  function enqueue(entry) {
    // Count the queue wait as part of a box's deadline. Even an SDK that does
    // not promptly stop after abort must not hold later boxes or a worker slot.
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = AbortSignal.any([lifetime.signal,deadline]);
    const expire = () => {
      if (!lifetime.signal.aborted) fail(entry,'Geminiの応答が時間内に届きませんでした。');
    };
    deadline.addEventListener('abort',expire,{once:true});
    entry.state = 'queued';
    entry.error = '';
    update(entry);
    schedule(async review => {
      try {
        if (signal.aborted) return;
        entry.state = 'processing';
        update(entry);
        const corrected = await reviewUntilAbort(review,{audio:clip(entry.id,entry.version),text:entry.original,signal});
        signal.throwIfAborted();
        if (typeof corrected !== 'string' || !corrected.trim()) throw new Error('Empty Gemini result');
        entry.corrected = corrected.trim();
        entry.state = 'ready';
        if (entry.outOfSequence || entry.id !== next) update(entry);
        advance();
      } catch (error) {
        if (signal.aborted) return;
        fail(entry,error?.status === 429
          ? 'Geminiの利用上限に達したか、混み合っています。'
          : 'Geminiで聞き直しができませんでした。');
      } finally {
        deadline.removeEventListener('abort',expire);
      }
    });
  }

  return {
    available:!!schedule,
    accept({id,version,approx,text}) {
      const entry = {id,version,approx,original:text,corrected:'',error:'',delivered:false,outOfSequence:false};
      entries.set(id,entry);
      enqueue(entry);
    },
    list() { return [...entries.values()].map(card); },
    status(id) {
      const entry = entries.get(id);
      return entry && {aiStatus:entry.state,aiError:entry.error,outOfSequence:entry.outOfSequence};
    },
    refresh(id) { const entry=entries.get(id);if(entry)update(entry); },
    retry(id) {
      const entry = entries.get(id);
      if (entry?.state !== 'failed') return {ok:false,error:'再試行できる箱がありません。'};
      if (!clip(entry.id,entry.version)) return {ok:false,error:'再試行できる原音がありません。'};
      enqueue(entry);
      return {ok:true};
    },
    dispose() { lifetime.abort();entries.clear(); },
  };
}

module.exports = {createAiQueue,createAiBoxReview};
