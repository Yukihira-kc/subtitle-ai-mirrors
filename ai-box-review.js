'use strict';

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

function createAiBoxReview({schedule, clip, notify, deliver, retainReplay}) {
  const entries = new Map();
  const lifetime = new AbortController();
  let next = 1;

  function card(entry) {
    const {id, version, approx, state, corrected, error, delivered} = entry;
    return {id, version, approx, text:corrected, audio:!!clip(id,version), aiStatus:state, aiError:error, delivered};
  }
  function update(entry) { notify(card(entry)); }

  // Boxes may finish out of order, but the reviewer draft follows desk order.
  function advance() {
    let entry;
    while ((entry = entries.get(next)) && (entry.state === 'ready' || entry.state === 'skipped')) {
      next++;
      if (entry.state === 'ready') {
        deliver(entry.id,entry.corrected);
        entry.delivered = true;
        update(entry);
      }
      retainReplay(entry.id);
    }
  }

  function enqueue(entry) {
    entry.state = 'queued';
    entry.error = '';
    update(entry);
    schedule(async review => {
      if (lifetime.signal.aborted) return;
      entry.state = 'processing';
      update(entry);
      const timeout = AbortSignal.timeout(12000);
      const signal = AbortSignal.any([lifetime.signal,timeout]);
      try {
        const corrected = await review({audio:clip(entry.id,entry.version),text:entry.original,signal});
        if (lifetime.signal.aborted) return;
        signal.throwIfAborted();
        if (typeof corrected !== 'string' || !corrected.trim()) throw new Error('Empty Gemini result');
        entry.corrected = corrected.trim();
        entry.state = 'ready';
        if (entry.id !== next) update(entry);
        advance();
      } catch (error) {
        if (lifetime.signal.aborted) return;
        entry.state = 'failed';
        if (timeout.aborted) entry.error = 'Geminiの応答が時間内に届きませんでした。';
        else if (error?.status === 429) entry.error = 'Geminiの利用上限に達したか、混み合っています。';
        else entry.error = 'Geminiで聞き直しができませんでした。';
        update(entry);
      }
    });
  }

  return {
    available:!!schedule,
    accept({id,version,approx,text}) {
      const entry = {id,version,approx,original:text,corrected:'',error:'',delivered:false};
      entries.set(id,entry);
      enqueue(entry);
    },
    list() { return [...entries.values()].map(card); },
    status(id) {
      const entry = entries.get(id);
      return entry && {aiStatus:entry.state,aiError:entry.error};
    },
    refresh(id) { const entry=entries.get(id);if(entry)update(entry); },
    retry(id) {
      const entry = entries.get(id);
      if (entry?.state !== 'failed') return {ok:false,error:'再試行できる箱がありません。'};
      enqueue(entry);
      return {ok:true};
    },
    skip(id) {
      const entry = entries.get(id);
      if (entry?.state !== 'failed') return {ok:false,error:'後続へ進める箱がありません。'};
      entry.state = 'skipped';
      entry.error = '';
      update(entry);
      advance();
      return {ok:true};
    },
    dispose() { lifetime.abort();entries.clear(); },
  };
}

module.exports = {createAiQueue,createAiBoxReview};
