// The monitor shows box history. Only reviewItem feeds the editable draft.
window.ReviewerBoxes = {
  create(connection, actions) {
    const get = id => document.getElementById(id);
    const list = get('ai-review-list');
    const empty = get('ai-review-empty');
    const title = get('monitor-title');
    const help = get('editor-help');
    const editor = get('edit');
    const standardHelp = help.textContent;
    const standardPlaceholder = editor.dataset.placeholder;
    const cards = new Map();
    const workingLabel = document.createElement('strong');
    workingLabel.className = 'ai-working-label';
    workingLabel.textContent = '作業中';
    const labels = {
      'awaiting-audio':'音声待ち', queued:'校正待ち', processing:'校正中',
      retrying:'自動再試行中', ready:'校正済み', 'audio-only':'音声のみ',
    };
    let enabled = false, lastId = null, taking = null;
    let tailSpace = 0, alignedScroll = null;
    const takeButton = get('ai-take');
    const replayButton = get('ai-replay');
    const acquired = get('ai-acquired');
    const autoplay = get('ai-auto-play');
    const autoplayKey = connection.storageKey('reviewer-autoplay-on-take');
    try { autoplay.checked = localStorage.getItem(autoplayKey)==='true'; } catch (_) {}
    autoplay.onchange = () => {
      try { localStorage.setItem(autoplayKey,String(autoplay.checked)); } catch (_) {}
    };
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

    function openOutput() {
      context ||= new AudioContext({latencyHint:'interactive'});
      return context.resume();
    }

    async function playClip(card, toggle = true) {
      const toggleOff = toggle && active?.card === card;
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
        await openOutput();
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
      const card = {row,top,state,play,text,note,feedback};
      // Keep F12 available when a reviewer clicks replay while editing.
      play.addEventListener('mousedown',event => {
        if (event.button===0 && document.activeElement===editor) event.preventDefault();
      });
      play.addEventListener('click',() => playClip(card));
      return card;
    }

    function update(box, fromSnapshot = false) {
      if (!enabled || !Number.isSafeInteger(box?.id) || !Number.isSafeInteger(box.version)) return;
      let card = cards.get(box.id);
      if (card && box.version < card.box.version) return;
      const followTail = !fromSnapshot && !lastId && list.scrollHeight-list.clientHeight-list.scrollTop < 4;
      if (!card) {
        card = newCard(box.id);
        cards.set(box.id,card);
        const next = Number(list.lastElementChild?.dataset.boxId) > box.id
          ? Array.from(list.children).find(row => Number(row.dataset.boxId) > box.id) : null;
        list.insertBefore(card.row,next||null);
      }
      if (active?.card===card && (card.box.version!==box.version || !box.audio)) stopAudio();
      card.box = box;
      const released = box.delivered === true;
      const final = box.aiStatus === 'ready' || box.aiStatus === 'audio-only';
      let state = labels[box.aiStatus] || '校正待ち';
      if (final) state += released ? (box.acquired ? '・取得済み' : '・取得可能') : '・先行する箱の処理待ち';
      card.state.textContent = state;
      card.text.textContent = released && box.aiStatus === 'ready' ? box.text || '' : '';
      const notes = [];
      if (released && box.aiStatus === 'audio-only') notes.push('原音を聞いて、必要な字幕を編集欄に入力してください。');
      if (box.approx && box.audio) notes.push('原音には前後の発話を含む場合があります。');
      card.note.textContent = notes.join(' ');
      card.play.disabled = !released || !box.audio;
      empty.hidden = true;
      if (followTail) list.scrollTop = list.scrollHeight;
      if (!fromSnapshot && lastId && tailSpace) positionWorkingBox(false);
      if (!fromSnapshot) refreshControls();
    }

    function nextBox() {
      const box = cards.get((lastId || 0)+1)?.box;
      return box?.delivered && !box.acquired && (box.aiStatus==='ready' || box.aiStatus==='audio-only') ? box : null;
    }

    function refreshControls() {
      if (!enabled) return;
      takeButton.disabled = !!taking || !actions.available() || !nextBox();
      replayButton.disabled = !actions.available() || !cards.get(lastId)?.box.audio;
    }

    function positionWorkingBox(align) {
      const card = cards.get(lastId);
      if (!card || !list.clientHeight) return;
      const viewportTop = list.getBoundingClientRect().top + list.clientTop;
      const currentTop = card.row.getBoundingClientRect().top;
      const previous = card.row.previousElementSibling;
      let target = previous ? previous.getBoundingClientRect().top : currentTop;
      // If the preceding box fills the viewport, retain its tail above the current heading.
      if (card.top.getBoundingClientRect().bottom - target > list.clientHeight) {
        target = Math.max(target,currentTop - Math.max(0,(list.clientHeight-card.top.offsetHeight)/2));
      }
      const scroll = Math.max(0,list.scrollTop + target - viewportTop);
      // Reserve only the space missing below the last actual box, even after a reload.
      const lastBottom = list.lastElementChild.getBoundingClientRect().bottom;
      const needed = Math.max(0,Math.ceil(target + list.clientHeight - lastBottom));
      if (needed !== tailSpace) {
        tailSpace = needed;
        list.style.setProperty('--review-tail-space',needed+'px');
      }
      if (align) {
        list.scrollTop = scroll;
        alignedScroll = list.scrollTop;
      }
    }

    new ResizeObserver(() => {
      // Preserve manual scrolling if the operator is looking at another box.
      positionWorkingBox(alignedScroll !== null && Math.abs(list.scrollTop-alignedScroll) < 2);
    }).observe(list);

    function setWorkingBox(id) {
      cards.get(lastId)?.row.removeAttribute('aria-current');
      workingLabel.remove();
      const card = cards.get(id);
      lastId = card?.box.id ?? null;
      if (!card) {
        tailSpace = 0;
        alignedScroll = null;
        list.style.removeProperty('--review-tail-space');
        acquired.textContent = '';
        return;
      }
      card.row.setAttribute('aria-current','true');
      card.top.prepend(workingLabel);
      acquired.textContent = '直近の取得：箱 '+id+(card.box.aiStatus==='audio-only'?'（音声のみ）':'');

      positionWorkingBox(true);
    }

    function disconnect() {
      stopAudio();
      if (taking) clearTimeout(taking.timer);
      taking = null;
      setWorkingBox(null);
    }

    function replay() {
      if (enabled && !replayButton.disabled) playClip(cards.get(lastId),false);
    }

    function takeNext() {
      if (!enabled || takeButton.disabled) return;
      const box = nextBox();
      if (!box) return;
      const request = {id:box.id,autoplay:autoplay.checked && box.audio,focus:document.activeElement};
      if (request.autoplay) {
        // Unlock Firefox playback while the key or button gesture is active.
        try { openOutput().catch(()=>{}); } catch (_) {}
      }
      taking = request;
      refreshControls();
      acquired.textContent = '箱 '+box.id+' を取得中…';
      // Retrying exactly this ID also covers a lost acknowledgement after acquisition.
      async function send() {
        if (taking !== request) return;
        let result;
        try { result = await actions.take(request.id); }
        catch (_) {
          if (taking===request) {
            acquired.textContent = '箱 '+request.id+' の受付を再確認しています。';
            request.timer = setTimeout(send,800);
          }
          return;
        }
        if (taking !== request) return;
        taking = null;
        if (result?.ok && result.box?.id===request.id) {
          stopAudio();
          update(result.box);
          setWorkingBox(request.id);
          if (document.activeElement===request.focus && document.activeElement!==editor) {
            editor.focus({preventScroll:true});
            const range=document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            const selection=window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
          if (request.autoplay && result.box.audio) playClip(cards.get(lastId));
        } else acquired.textContent = result?.error || '取得できませんでした。';
        refreshControls();
      }
      send();
    }

    for (const button of [takeButton,replayButton]) {
      button.addEventListener('mousedown',event=>{
        if (event.button===0 && document.activeElement===editor) event.preventDefault();
      });
    }
    takeButton.addEventListener('click',takeNext);
    replayButton.addEventListener('click',replay);

    function load(mode, boxes, acquiredId) {
      disconnect();
      cards.clear();
      list.replaceChildren();
      enabled = mode === 'complete-ai';
      title.textContent = enabled ? 'Gemini校正・原音' : 'A・B・C 入力レビュー';
      get('monitors').hidden = enabled;
      list.hidden = !enabled;
      get('ai-review-tools').hidden = acquired.hidden = !enabled;
      empty.hidden = !enabled;
      editor.dataset.placeholder = enabled ? 'F1で取得した校正文が末尾に追加されます' : standardPlaceholder;
      help.textContent = enabled
        ? 'F1で次の箱を取得し、F2で取得した箱の原音を再生します。' : standardHelp;
      title.closest('section').hidden = false;
      if (enabled) {
        for (const box of boxes) update(box,true);
        setWorkingBox(acquiredId);
        if (!lastId) list.scrollTop = list.scrollHeight;
        refreshControls();
      }
    }
    return {load,update,disconnect,takeNext,replay,refreshControls,get enabled(){return enabled;}};
  },
};
