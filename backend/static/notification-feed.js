/* One notification cursor per landing page, shared with its same-origin queue. */
(() => {
  'use strict';
  if (window.FuraticNotificationFeed) return;
  const subscribers = new Set(), children = new Set();
  const buffer = new Map();
  let cursor = 0, epoch = 0, parentEpoch = null, timer = 0, request = null, stopped = false;
  let parentReader = false, fallback = 0, lastRead = 0;
  const child = window.parent !== window;
  function deliver(items) {
    for (const item of items) buffer.set(Number(item.id), item);
    while (buffer.size > 80) buffer.delete(buffer.keys().next().value);
    for (const subscriber of subscribers) {
      try { subscriber(items); } catch (error) { console.error('Notification subscriber failed', error); }
    }
    for (const target of children) target.postMessage({type: 'furatic:notification-batch', items, cursor, epoch}, location.origin);
  }
  function stopRequest() {
    clearTimeout(timer); timer = 0;
    request?.abort();
  }
  async function poll() {
    clearTimeout(timer); timer = 0;
    if (stopped || document.hidden || parentReader || request || !subscribers.size && !children.size) return;
    if (Date.now() - lastRead < 1000) { timer = setTimeout(poll, 1000); return; }
    const controller = new AbortController(); request = controller; lastRead = Date.now();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/notifications/?after=' + cursor, {credentials: 'same-origin', cache: 'no-store', signal: controller.signal});
      if (!response.ok) return;
      const data = await response.json();
      if (data.siteMode === 'afterhours') return;
      if (Number.isFinite(data.sequence) && data.sequence < cursor) { cursor = 0; epoch++; buffer.clear(); }
      const items = (data.notifications || []).filter(item => Number(item.id) > cursor);
      // Every mounted reader receives the batch before this cursor advances.
      deliver(items);
      cursor = Math.max(cursor, Number(data.latest || 0));
    } catch (_) { /* Preserve cursor and pending download state through reconnects. */ }
    finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
      if (!stopped && !parentReader && !document.hidden) timer = setTimeout(poll, 4000);
    }
  }
  window.FuraticNotificationFeed = {
    subscribe(handler) {
      subscribers.add(handler);
      if (buffer.size) handler(Array.from(buffer.values()));
      if (child) {
        window.parent.postMessage({type: 'furatic:notification-subscribe'}, location.origin);
        if (!parentReader && !fallback) fallback = setTimeout(() => { fallback = 0; poll(); }, 700);
      } else poll();
      return () => subscribers.delete(handler);
    },
    refresh() {
      if (parentReader) window.parent.postMessage({type: 'furatic:notification-refresh'}, location.origin);
      else poll();
    },
  };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data) return;
    if (child && event.source === window.parent && event.data.type === 'furatic:notification-batch') {
      parentReader = true; clearTimeout(fallback); fallback = 0; stopRequest();
      if (parentEpoch !== null && parentEpoch !== event.data.epoch) { buffer.clear(); cursor = 0; }
      parentEpoch = event.data.epoch;
      const items = (event.data.items || []).filter(item => !buffer.has(Number(item.id)));
      deliver(items);
      cursor = Math.max(cursor, Number(event.data.cursor || 0), ...items.map(item => Number(item.id)));
    } else if (!child && Array.from(document.querySelectorAll('iframe')).some(frame => frame.contentWindow === event.source)) {
      if (event.data.type === 'furatic:notification-subscribe') {
        children.add(event.source);
        event.source.postMessage({type: 'furatic:notification-batch', items: Array.from(buffer.values()), cursor, epoch}, location.origin);
        poll();
      } else if (event.data.type === 'furatic:notification-refresh') poll();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRequest();
    else window.FuraticNotificationFeed.refresh();
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(fallback); stopRequest(); });
})();
