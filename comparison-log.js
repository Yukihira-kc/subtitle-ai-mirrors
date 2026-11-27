'use strict';

const engines = new Set(['F0','S0','vosk']);

function boxRecognition(value) {
  if (!value || typeof value.text !== 'string' || value.text.length > 128000 ||
      !engines.has(value.engine) || typeof value.partial !== 'boolean' ||
      typeof value.approximate !== 'boolean') return null;
  return {text:value.text,engine:value.engine,partial:value.partial,approximate:value.approximate};
}

function createComparisonLog() {
  const recognition = new Map(), completed = [], acquisitions = [];
  let firstPending = 0, sends = [], edited = false;

  function recordRecognition(value) {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 256 ||
        typeof value.text !== 'string' || !value.text.trim() || value.text.length > 128000 ||
        !engines.has(value.engine) || !Number.isSafeInteger(value.at) || value.at < 0)
      return {ok:false,retryable:false,error:'音声認識の記録内容を確認してください。'};
    if (!recognition.has(value.id)) {
      const {id,text,engine,at} = value;
      recognition.set(id,{id,text,engine,at});
    }
    return {ok:true};
  }

  function closeGroup(draft, afterSend) {
    // F1 can race with an earlier editor snapshot. Ready boxes have a raw
    // input ID; audio-only boxes instead use the reviewer’s acquired-box cursor.
    const start = firstPending;
    let end = start;
    let hasTextBox = false;
    while (end < acquisitions.length) {
      const box = acquisitions[end];
      if (box.anchor > draft.inputId) break;
      if (box.audioOnly && box.anchor === draft.inputId &&
          Number.isSafeInteger(draft.comparisonAcquiredId) && box.id > draft.comparisonAcquiredId) break;
      if (!box.audioOnly) hasTextBox = true;
      end++;
    }
    if (!afterSend && !edited && !hasTextBox && !sends.length) return;
    if (end > start || sends.length) {
      completed.push({boxIds:acquisitions.slice(start,end).map(box=>box.id),sends,complete:true});
    }
    firstPending = end;
    sends = [];
    edited = false;
  }

  return {
    recordRecognition,
    acquire(id,anchor,audioOnly) { acquisitions.push({id,anchor,audioOnly}); },
    save(draft) {
      if (draft.text.length) edited = true;
      else closeGroup(draft,false);
    },
    send(request,lines,at) {
      sends.push({id:request.id,text:lines.join('\n'),automatic:request.automatic === true,at});
      if (!request.draft) return; // Older clients did not report their editor contents.
      const source = request.draft.text.replace(/\r\n?/g,'\n');
      if (request.kind === 'send-all' || request.consumed === source.length) closeGroup(request.draft,true);
    },
    snapshot(session,boxes,pendingText) {
      const groups = completed.slice();
      const boxIds = acquisitions.slice(firstPending).map(box=>box.id);
      if (boxIds.length || sends.length || pendingText.length) groups.push({boxIds,sends:sends.slice(),complete:false});
      return {session,recognition:[...recognition.values()],boxes,groups,pendingText};
    },
  };
}

module.exports = {createComparisonLog,boxRecognition};
