'use strict';

window.GeminiDictionary = {
  create(socket) {
    const details = document.getElementById('gemini-dictionary');
    details.innerHTML = `
      <summary>Gemini校正辞書</summary>
      <div class="dictionary-form">
        <p id="dictionary-active" role="status"></p>
        <label>辞書ファイル（TXT・TSV、8 MiBまで）
          <input id="dictionary-file" type="file" accept=".txt,.tsv" aria-describedby="dictionary-format">
        </label>
        <p id="dictionary-format">1行につき、よみと語句をタブで区切ります。</p>
        <button id="dictionary-register" type="button" disabled>辞書を登録</button>
        <p id="dictionary-status" role="status"></p>
      </div>`;
    const fileInput = details.querySelector('input');
    const button = details.querySelector('button');
    const active = details.querySelector('#dictionary-active');
    const status = details.querySelector('#dictionary-status');
    const maxSize = 8 * 1024 * 1024;
    const jpTime = new Intl.DateTimeFormat('ja-JP', {
      year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit',
      hourCycle:'h23', timeZone:'Asia/Tokyo'
    });
    let joined = false, busy = false, session = 0, change = 0, expiryTimer;

    function controls() {
      const file = fileInput.files[0];
      fileInput.disabled = !joined || busy;
      button.disabled = !joined || busy || !file || file.size > maxSize;
    }

    function display(dictionary) {
      clearTimeout(expiryTimer);
      if (!dictionary) {
        active.textContent = '登録中の辞書はありません。';
        return;
      }
      const expires = new Date(dictionary.expiresAt);
      const untilExpiry = expires.getTime() - Date.now();
      if (!Number.isFinite(untilExpiry) || untilExpiry <= 0) {
        active.textContent = '有効な辞書はありません。';
        return;
      }
      active.textContent = dictionary.name + '（' + dictionary.count + '件）　有効期限 ' + jpTime.format(expires) + '（日本時間）';
      expiryTimer = setTimeout(() => {
        if (!joined) return;
        active.textContent = '有効期限を確認中…';
        sync();
      }, Math.min(untilExpiry + 100, 2147483647));
    }

    async function sync() {
      const requestSession = session, revision = change;
      try {
        const reply = await socket.timeout(8000).emitWithAck('getGeminiDictionary', {});
        if (requestSession !== session || revision !== change) return;
        if (!reply?.ok) throw Error(reply?.error || '登録状況を取得できませんでした。');
        display(reply.dictionary);
      } catch (error) {
        if (requestSession === session && revision === change) active.textContent = '辞書の登録状況を確認できません。';
      }
    }

    fileInput.addEventListener('change', () => {
      status.textContent = fileInput.files[0]?.size > maxSize ? '8 MiB以下のファイルを選んでください。' : '';
      controls();
    });
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const file = fileInput.files[0], requestSession = session;
      busy = true;
      controls();
      status.textContent = '登録中…';
      try {
        const bytes = await file.arrayBuffer();
        if (requestSession !== session) return;
        const revision = change;
        const reply = await socket.timeout(45000).emitWithAck('registerGeminiDictionary', {name:file.name, file:bytes});
        if (requestSession !== session) return;
        if (!reply?.ok) {
          status.textContent = reply?.error || '辞書を登録できませんでした。';
          return;
        }
        if (revision === change) { change++; display(reply.dictionary); }
        fileInput.value = '';
        status.textContent = '辞書を登録しました。';
      } catch {
        if (requestSession === session) {
          status.textContent = '登録の完了を確認できませんでした。現在の辞書を確認してください。';
          sync();
        }
      } finally {
        if (requestSession === session) { busy = false; controls(); }
      }
    });
    socket.on('geminiDictionary', dictionary => {
      if (!joined) return;
      change++;
      display(dictionary);
      if (!busy) status.textContent = '';
    });
    socket.on('disconnect', () => {
      session++;
      joined = false;
      busy = false;
      clearTimeout(expiryTimer);
      controls();
      if (!details.hidden) status.textContent = '切断中です。再接続後に登録状況を確認します。';
    });
    return {
      join(mode) {
        session++;
        joined = mode === 'complete-ai';
        details.hidden = !joined;
        busy = false;
        status.textContent = '';
        controls();
        if (joined) {
          active.textContent = '辞書の登録状況を確認中…';
          sync();
        }
      }
    };
  }
};
