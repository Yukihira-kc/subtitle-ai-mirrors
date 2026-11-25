(() => {
  'use strict';

  const readyUrl = 'http://127.0.0.1:39462/ready';
  const publishedOrigins = new Set([
    'https://subtitle-ai-mirrors.vercel.app',
    'https://subtitle-ai-mirrors-th6k36zl5ltja.azurewebsites.net',
    'https://subtitle-ai-complete-test.onrender.com',
  ]);
  const canLaunch = publishedOrigins.has(location.origin) && /^Win/i.test(navigator.platform);
  const retryMessage = 'Vosk に接続できません。「Voskの設定・更新」から最新版を展開し、Register-Vosk.cmd を実行してください。Firefox でアプリの起動やローカルネットワークへのアクセスの確認が出たら、許可してください。';
  let lastReady = -Infinity;
  let probePending;
  let monitorTimer;
  let protocolFrame;

  function probe() {
    if (!probePending) {
      probePending = fetch(readyUrl, {cache:'no-store', signal:AbortSignal.timeout(1000)})
        .then(async response => response.ok && (await response.json()).ready === true)
        .catch(() => false)
        .then(ready => {
          lastReady = ready ? performance.now() : -Infinity;
          probePending = undefined;
          return ready;
        });
    }
    return probePending;
  }

  function monitorReady() {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(async () => {
      if (await probe()) monitorReady();
    }, 2500);
  }

  function openLauncher() {
    protocolFrame?.remove();
    protocolFrame = document.createElement('iframe');
    protocolFrame.hidden = true;
    protocolFrame.title = 'Vosk を起動';
    protocolFrame.src = 'caption-vosk://start';
    document.body.append(protocolFrame);
  }

  async function waitForReady(timeout) {
    const deadline = performance.now() + timeout;
    do {
      if (await probe()) {
        if (canLaunch) monitorReady();
        return;
      }
      if (performance.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 350));
    } while (true);
    throw new Error(retryMessage);
  }

  function ensureReady(updateStatus) {
    const running = performance.now() - lastReady < 3700;
    function launch() {
      if (navigator.userActivation?.isActive === false) throw new Error(retryMessage);
      updateStatus('Vosk を起動しています。Firefox に確認が出たら、アプリを開いてください。');
      // Dispatch the external protocol while Firefox still has the click gesture.
      openLauncher();
      return waitForReady(35000);
    }
    if (!canLaunch) return waitForReady(3000);
    if (!running) return launch();
    return probe().then(ready => {
      if (!ready) return launch();
      monitorReady();
    });
  }

  if (canLaunch) probe().then(ready => { if (ready) monitorReady(); });
  window.VoskLauncher = {ensureReady};
})();
