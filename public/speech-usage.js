'use strict';

window.SpeechUsage = (() => {
  const tiers = ['F0', 'S0'];
  const slots = new Map();
  const refreshButton = document.getElementById('usage-refresh');
  const azureOrigin = 'https://subtitle-ai-mirrors-th6k36zl5ltja.azurewebsites.net';
  const endpointOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    ? location.origin : azureOrigin;
  const freeAllowanceSeconds = 5 * 60 * 60;
  const pollInterval = 5 * 60 * 1000;
  const jpDate = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric'
  });
  const jpTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function show(tier, value, period = '', limitReached = false) {
    const output = document.getElementById('usage-' + tier);
    output.textContent = value;
    output.classList.toggle('usage-limit-reached', limitReached);
    document.getElementById('usage-' + tier + '-period').textContent = period;
  }

  function updateButton() {
    refreshButton.disabled = !Array.from(slots.values()).some(slot => slot.token && !slot.controller);
  }

  function reset(tier, hasKey) {
    slots.get(tier)?.controller?.abort();
    slots.delete(tier);
    show(tier, hasKey ? 'キー・料金レベルを確認' : 'キー未入力');
    updateButton();
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error();
    const whole = Math.floor(seconds);
    return Math.floor(whole / 3600) + '時間' + Math.floor(whole % 3600 / 60) + '分' + whole % 60 + '秒';
  }

  function date(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error();
    return new Date(value);
  }

  const errors = {
    not_configured: '使用時間の照会設定が必要',
    invalid_key: '照会用の登録キーと不一致',
    unavailable: 'Azure 使用時間を取得できません'
  };

  async function refresh(tier) {
    const slot = slots.get(tier);
    if (!slot?.token || slot.controller) return;
    const controller = new AbortController();
    slot.controller = controller;
    slot.attemptedAt = Date.now();
    updateButton();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpointOrigin + '/ai/api/speech-usage/' + tier, {
        headers: {Authorization: 'Bearer ' + slot.token},
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal
      });
      const data = await response.json();
      if (slots.get(tier) !== slot) return;
      if (!response.ok || data.error) {
        show(tier, errors[data.error] || errors.unavailable);
        return;
      }
      const value = duration(data.usedSeconds);
      const period = jpDate.format(date(data.periodStart)) + 'から';
      const checked = jpTime.format(date(data.checkedAt)) + ' 確認（日本時間）';
      const reached = tier === 'F0' && data.usedSeconds >= freeAllowanceSeconds;
      const threshold = reached ? '5時間到達（集計上）・' : '';
      show(tier, value, threshold + period + '・' + checked, reached);
    } catch {
      if (slots.get(tier) === slot) show(tier, errors.unavailable);
    } finally {
      clearTimeout(timeout);
      slot.controller = null;
      updateButton();
    }
  }

  async function verify(tier, key) {
    reset(tier, true);
    const slot = {token: '', controller: null, attemptedAt: 0};
    slots.set(tier, slot);
    show(tier, '照会中…');
    try {
      const bytes = new TextEncoder().encode('subtitle-mirror-usage:v1:' + key.trim());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      if (slots.get(tier) !== slot) return;
      slot.token = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      await refresh(tier);
    } catch {
      if (slots.get(tier) === slot) show(tier, '照会にはHTTPS接続が必要です');
    }
  }

  function refreshDue() {
    if (document.hidden) return;
    for (const tier of tiers) {
      const slot = slots.get(tier);
      if (slot && Date.now() - slot.attemptedAt >= pollInterval) refresh(tier);
    }
  }

  refreshButton.addEventListener('click', () => tiers.forEach(refresh));
  setInterval(refreshDue, pollInterval);
  document.addEventListener('visibilitychange', refreshDue);
  return {verify, reset};
})();
