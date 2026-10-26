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
  for (const name of ['headline', 'title', 'artist', 'detail', 'footer', 'badge', 'ordinal']) {
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
  let controller = null, active = '', generation = 0, pendingMessage = null;
  const visible = () => !stopped && obsVisible && contextReady && !document.hidden;
  const motion = new Set();
  const sheen = root.querySelector('.vote-notice-sheen');
  const easing = 'cubic-bezier(.16,1,.3,1)';

  function cancelMotion() {
    for (const animation of motion) {
      animation.onfinish = animation.oncancel = null;
      animation.cancel();
    }
    motion.clear();
  }

  function animate(element, frames, timing) {
    // Finite, explicitly owned broadcast animations. OBS can inherit Windows'
    // reduced-motion preference; it must not silently remove the stream effects.
    // Only transforms/opacity animate; blur and geometry stay fixed.
    if (!element || typeof element.animate !== 'function') return;
    const animation = element.animate(frames, {...timing, fill: 'backwards'});
    motion.add(animation);
    const release = () => {
      motion.delete(animation);
      animation.onfinish = animation.oncancel = null;
      animation.cancel();
    };
    animation.onfinish = animation.oncancel = release;
  }

  function enter(rank) {
    cancelMotion();
    animate(root, [
      {opacity: 0, transform: 'translate(1.5em,-.25em) scale(.97)'},
      {opacity: 1, transform: 'translate(0,0) scale(1)'},
    ], {duration: rank === 1 ? 1050 : rank ? 900 : 820, easing});
    if (rank === 1) {
      animate(fields.badge, [
        {opacity: 0, transform: 'translateY(18%) rotate(-8deg) scale(.76)', offset: 0},
        {opacity: 1, transform: 'translateY(0) rotate(2deg) scale(1.04)', offset: .72},
        {opacity: 1, transform: 'translateY(0) rotate(0) scale(1)', offset: 1},
      ], {duration: 1150, delay: 100, easing});
      animate(sheen, [
        {opacity: 0, transform: 'translateX(-120%)', offset: 0},
        {opacity: 1, transform: 'translateX(-75%)', offset: .25},
        {opacity: 0, transform: 'translateX(120%)', offset: 1},
      ], {duration: 1450, delay: 250, easing: 'ease-out'});
    } else if (rank === 2) {
      animate(fields.badge, [
        {opacity: 0, transform: 'translateX(-18%) scale(.88)'},
        {opacity: 1, transform: 'translateX(0) scale(1)'},
      ], {duration: 900, delay: 100, easing});
    } else if (rank === 3) {
      animate(fields.badge, [
        {opacity: 0, transform: 'translateY(16%) scale(.92)'},
        {opacity: 1, transform: 'translateY(0) scale(1)'},
      ], {duration: 800, delay: 100, easing});
    }
  }

  function hide(immediate = false) {
    clearTimeout(hideTimer); clearTimeout(releaseTimer);
    hideTimer = releaseTimer = 0;
    const showing = !root.hidden;
    // Read the actual in-flight pose before cancelling an interrupted entrance.
    const style = showing && !immediate ? getComputedStyle(root) : null;
    const from = style ? {opacity: style.opacity, transform: style.transform} : null;
    cancelMotion();
    active = '';
    root.classList.remove('is-visible');
    root.setAttribute('aria-hidden', 'true');
    if (immediate || !showing) root.hidden = true;
    else {
      animate(root, [from, {opacity: 0, transform: 'translate(.9em,-.15em) scale(.985)'}],
        {duration: 650, easing: 'cubic-bezier(.4,0,.6,1)'});
      releaseTimer = setTimeout(() => {
        releaseTimer = 0;
        cancelMotion();
        root.hidden = true; // Releases the blurred compositor surface after exit.
        const next = pendingMessage;
        pendingMessage = null;
        if (next) show(next);
      }, 650);
    }
  }

  function show(message) {
    if (!visible()) return;
    const now = Date.now() / 1000;
    if (!message.persistent && message.expiresAt <= now) return;
    const rank = message.kind === 'rank' ? message.rank : 0;
    const restoring = message.id === seen;
    clearTimeout(releaseTimer); releaseTimer = 0;
    for (const name of ['headline', 'title', 'artist', 'detail', 'footer']) {
      // Metadata is text, never HTML. One fixed card is reused for every notice.
      fields[name].textContent = typeof message[name] === 'string' ? message[name].slice(0, 240) : '';
    }
    fields.ordinal.textContent = rank ? ['', '1st', '2nd', '3rd'][rank] : '';
    root.dataset.rank = String(rank);
    root.dataset.kind = message.kind;
    root.hidden = false;
    root.classList.add('is-visible');
    root.setAttribute('aria-hidden', 'false');
    if (!restoring) enter(rank);
    active = seen = message.id;
    if (!restoring) {
      lastShown = now;
      try { localStorage.setItem(storageKey, JSON.stringify({id: seen, at: now})); } catch (_) { /* optional */ }
    }
    if (!message.persistent) hideTimer = setTimeout(() => hide(), Math.min(14, message.expiresAt - now) * 1000);
  }

  function receive(value) {
    const now = Date.now() / 1000;
    // A short server restart must not erase a retained achievement. A fresh
    // explicit null is the authoritative event-end / expired-warning clear.
    if (!value || value.version !== 1 || !Number.isFinite(value.updatedAt) ||
        now - value.updatedAt > 10 || now < value.updatedAt) return;
    const message = value.message;
    if (!message) {
      pendingMessage = null;
      if (active) hide();
      return;
    }
    const persistent = message.persistent === true && ['rank', 'reminder'].includes(message.kind);
    if (!Number.isFinite(message.expiresAt) || !Number.isFinite(message.createdAt) ||
        now < message.createdAt || message.expiresAt - message.createdAt > 14.1 ||
        (!persistent && (message.expiresAt <= now || now - message.createdAt > 6)) ||
        typeof message.id !== 'string' || !['rank', 'risk', 'reminder'].includes(message.kind)) return;
    const rank = message.kind === 'rank' ? message.rank : 0;
    if (message.kind === 'rank' && ![1, 2, 3].includes(rank)) return;
    for (const name of ['headline', 'detail', 'footer']) {
      if (typeof message[name] !== 'string' || message[name].length > 240) return;
    }
    if (message.id === active || message.id === pendingMessage?.id || !visible()) return;
    if (message.id === seen && !persistent ||
        message.id !== seen && lastShown && now - lastShown < 60) return;
    const next = {...message, persistent};
    if (active || releaseTimer) {
      // One replacement slot, never a queue. Keep the old text until its exit
      // finishes, then reuse the same DOM card for the newest accepted message.
      pendingMessage = next;
      if (active) hide();
    } else show(next);
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
      // Keep the current card through a brief interruption; fresh messages replace it.
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
    pendingMessage = null;
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
