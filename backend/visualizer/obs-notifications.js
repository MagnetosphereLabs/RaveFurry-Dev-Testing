/* OBS-only DOM overlay. No WebGL calls, animation frame loop, or message queue. */
(() => {
  'use strict';
  const root = document.getElementById('vote-notice');
  if (!root) return;
  const options = new URLSearchParams(location.search);
  if (options.has('demo')) return;
  const port = Number(options.get('port') || ((location.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(location.hostname)) ? location.port : 8766));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  const endpoint = `http://127.0.0.1:${port}/vote-notification.json`;
  const fields = {};
  for (const name of ['eyebrow', 'headline', 'title', 'artist', 'detail', 'footer', 'badge']) {
    fields[name] = document.getElementById(`vote-notice-${name}`);
  }
  const storageKey = 'furatic.obs.vote-notice.v1';
  let seen = '', lastShown = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    seen = typeof saved.id === 'string' ? saved.id : '';
    lastShown = Number(saved.at) || 0;
  } catch (_) { /* Storage can be disabled in OBS; server cooldowns still apply. */ }
  let stopped = false, obsVisible = true, contextReady = true;
  let pollTimer = 0, hideTimer = 0, releaseTimer = 0, requestTimer = 0;
  let controller = null, active = '', generation = 0;
  const visible = () => !stopped && obsVisible && contextReady && !document.hidden;

  function hide(immediate = false) {
    clearTimeout(hideTimer); clearTimeout(releaseTimer);
    hideTimer = releaseTimer = 0;
    active = '';
    root.classList.remove('is-visible');
    root.setAttribute('aria-hidden', 'true');
    if (immediate) root.hidden = true;
    else releaseTimer = setTimeout(() => {
      releaseTimer = 0;
      root.hidden = true; // Releases the blurred compositor surface after exit.
    }, 650);
  }

  function receive(value) {
    const message = value && value.version === 1 && value.message;
    const now = Date.now() / 1000;
    if (!message || !Number.isFinite(value.updatedAt) || now - value.updatedAt > 10 ||
        now < value.updatedAt || !Number.isFinite(message.expiresAt) ||
        message.expiresAt <= now) {
      if (active) hide();
      return;
    }
    if (message.id === active) return;
    if (active || !visible() || typeof message.id !== 'string' || message.id === seen ||
        !Number.isFinite(message.createdAt) || now < message.createdAt || now - message.createdAt > 6 ||
        message.expiresAt - message.createdAt > 14.1 ||
        (lastShown && now - lastShown < 180) ||
        !['rank', 'risk', 'reminder'].includes(message.kind)) return;
    const rank = message.kind === 'rank' ? message.rank : 0;
    if (message.kind === 'rank' && ![1, 2, 3].includes(rank)) return;
    for (const name of ['eyebrow', 'headline', 'detail', 'footer']) {
      if (typeof message[name] !== 'string' || message[name].length > 240) return;
    }
    clearTimeout(releaseTimer); releaseTimer = 0;
    for (const name of ['eyebrow', 'headline', 'title', 'artist', 'detail', 'footer']) {
      // Metadata is text, never HTML. One fixed card is reused for every notice.
      fields[name].textContent = typeof message[name] === 'string' ? message[name].slice(0, 240) : '';
    }
    fields.badge.textContent = rank ? `0${rank}` : '↑';
    root.dataset.rank = String(rank);
    root.dataset.kind = message.kind;
    root.classList.remove('is-visible');
    root.hidden = false;
    void root.offsetWidth; // One layout on entry, never work in the render loop.
    root.classList.add('is-visible');
    root.setAttribute('aria-hidden', 'false');
    active = seen = message.id;
    lastShown = now;
    try { localStorage.setItem(storageKey, JSON.stringify({id: seen, at: now})); } catch (_) { /* optional */ }
    hideTimer = setTimeout(() => hide(), Math.min(14, message.expiresAt - now) * 1000);
  }

  async function poll() {
    pollTimer = 0;
    if (!visible() || controller) return;
    const request = new AbortController(), ticket = generation;
    controller = request;
    requestTimer = setTimeout(() => request.abort(), 1500);
    try {
      const response = await fetch(endpoint, {cache: 'no-store', credentials: 'omit', signal: request.signal});
      if (!response.ok) throw new Error('Notification unavailable');
      const body = await response.text();
      if (body.length > 8192) throw new Error('Oversized notification');
      if (visible() && ticket === generation) receive(JSON.parse(body));
    } catch (_) {
      // An interrupted web restart must not replay or extend an old notice.
    } finally {
      if (controller === request) {
        clearTimeout(requestTimer); requestTimer = 0;
        controller = null;
        if (visible()) pollTimer = setTimeout(poll, 2000);
      }
    }
  }

  function suspend() {
    generation++;
    clearTimeout(pollTimer); clearTimeout(requestTimer);
    pollTimer = requestTimer = 0;
    if (controller) { controller.abort(); controller = null; }
    hide(true);
  }
  function visibilityChanged() {
    if (!visible()) suspend();
    else if (!pollTimer && !controller) poll();
  }
  function obsChanged(event) {
    if (typeof event.detail?.visible === 'boolean') {
      obsVisible = event.detail.visible;
      visibilityChanged();
    }
  }
  function contextLost() { contextReady = false; visibilityChanged(); }
  function contextRestored() { contextReady = true; visibilityChanged(); }
  const canvas = document.getElementById('background');
  function cleanup() {
    if (stopped) return;
    stopped = true;
    suspend();
    window.removeEventListener('pagehide', cleanup);
    window.removeEventListener('obsSourceVisibleChanged', obsChanged);
    document.removeEventListener('visibilitychange', visibilityChanged);
    canvas.removeEventListener('webglcontextlost', contextLost);
    canvas.removeEventListener('webglcontextrestored', contextRestored);
  }
  window.addEventListener('pagehide', cleanup, {once: true});
  window.addEventListener('obsSourceVisibleChanged', obsChanged);
  document.addEventListener('visibilitychange', visibilityChanged);
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  visibilityChanged();
})();
