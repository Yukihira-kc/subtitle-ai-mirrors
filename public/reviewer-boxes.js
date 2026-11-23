// The monitor shows box history. Only reviewItem feeds the editable draft.
window.ReviewerBoxes = {
  create(connection) {
    const get = id => document.getElementById(id);
    const list = get('ai-review-list');
    const empty = get('ai-review-empty');
    const title = get('monitor-title');
    const help = get('editor-help');
    const editor = get('edit');
    const standardHelp = help.textContent;
    const standardPlaceholder = editor.dataset.placeholder;
    const cards = new Map();
    const labels = {
      'awaiting-audio':'音声待ち', queued:'校正待ち', processing:'校正中',
      ready:'校正済み', failed:'校正失敗', skipped:'デスクがスキップ',
    };
    let enabled = false;
    let context, active = null;

    function stopAudio() {
      const previous = active;
      if (!previous) return;
      active = null;
      previous.controller.abort();
      if (previous.source) {
        previous.source.onended = null;
        previous.source.stop();
        previous.source.disconnect();
      }
      previous.card.play.textContent = '原音再生';
      previous.card.play.setAttribute('aria-pressed','false');
    }

    async function playClip(card) {
      const toggleOff = active?.card === card;
      stopAudio();
      if (toggleOff || !card.box.audio) return;
      const {id, version} = card.box;
      const current = {card, controller:new AbortController()};
      active = current;
      card.play.textContent = '読込中・停止';
      card.play.setAttribute('aria-pressed','true');
      card.feedback.textContent = '';
      try {
        // Open the output within the user gesture, including in Firefox.
        context ||= new AudioContext({latencyHint:'interactive'});
        await context.resume();
        if (active !== current) return;
        const room = encodeURIComponent(connection.roomId);
        const token = connection.token();
        const response = await fetch(connection.url+'/ai/api/rooms/'+room+'/clips/'+id+'?version='+version, {
          headers:token ? {Authorization:'Bearer '+token} : {},
          cache:'no-store', signal:current.controller.signal,
        });
        if (!response.ok) throw new Error('clip unavailable');
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        if (active !== current) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => { if (active === current) stopAudio(); };
        source.start();
        current.source = source;
        card.play.textContent = '再生停止';
      } catch (_) {
        if (active !== current) return;
        stopAudio();
        card.feedback.textContent = '原音を再生できませんでした。再生ボタンで再試行できます。';
      }
    }

    function newCard(id) {
      const row = document.createElement('li');
      row.className = 'ai-review-box';
      row.dataset.boxId = id;
      const top = document.createElement('div');
      top.className = 'ai-review-top';
      const number = document.createElement('strong');
      number.textContent = '箱 '+id;
      const state = document.createElement('span');
      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = '原音再生';
      play.title = '箱 '+id+'の原音を再生・停止';
      play.setAttribute('aria-pressed','false');
      top.append(number,state,play);
      const text = document.createElement('p');
      text.className = 'ai-review-text';
      const note = document.createElement('p');
      note.className = 'ai-review-note';
      const feedback = document.createElement('p');
      feedback.className = 'ai-review-note';
      feedback.setAttribute('role','status');
      row.append(top,text,note,feedback);
      const card = {row,state,play,text,note,feedback};
      // Keep F12 available when a reviewer clicks replay while editing.
      play.addEventListener('mousedown',event => {
        if (event.button===0 && document.activeElement===editor) event.preventDefault();
      });
      play.addEventListener('click',() => playClip(card));
      return card;
    }

    function update(box) {
      if (!enabled || !Number.isSafeInteger(box?.id) || !Number.isSafeInteger(box.version)) return;
      let card = cards.get(box.id);
      if (card && box.version < card.box.version) return;
      const atEnd = list.scrollHeight-list.clientHeight-list.scrollTop < 4;
      if (!card) {
        card = newCard(box.id);
        cards.set(box.id,card);
        const next = Number(list.lastElementChild?.dataset.boxId) > box.id
          ? Array.from(list.children).find(row => Number(row.dataset.boxId) > box.id) : null;
        list.insertBefore(card.row,next||null);
      }
      if (active?.card===card && (card.box.version!==box.version || !box.audio)) stopAudio();
      card.box = box;
      card.state.textContent = box.aiStatus==='ready' && box.delivered===false
        ? '校正済み・先行する箱の処理待ち' : labels[box.aiStatus] || '';
      card.text.textContent = box.aiStatus === 'ready' ? box.text || '' : '';
      const notes = [];
      if (box.aiStatus === 'failed') notes.push(box.aiError || '校正結果を取得できませんでした。');
      if (box.approx && box.audio) notes.push('原音には前後の発話を含む場合があります。');
      card.note.textContent = notes.join(' ');
      card.play.disabled = !box.audio;
      empty.hidden = true;
      if (atEnd) list.scrollTop = list.scrollHeight;
    }

    function load(mode, boxes) {
      stopAudio();
      cards.clear();
      list.replaceChildren();
      enabled = mode === 'complete-ai';
      title.textContent = enabled ? 'Gemini校正・原音' : 'A・B・C 入力レビュー';
      get('monitors').hidden = enabled;
      list.hidden = !enabled;
      empty.hidden = !enabled;
      editor.dataset.placeholder = enabled ? 'Geminiの校正結果が発話順に追加されます' : standardPlaceholder;
      help.textContent = enabled
        ? '校正済みの文章が発話順に追加されます。編集して先頭から送出します。' : standardHelp;
      title.closest('section').hidden = false;
      if (enabled) boxes.forEach(update);
    }
    return {load,update,stopAudio};
  },
};
