import {getState, reconnect} from './base.js';

const STATE_POLL_INTERVAL_MS = 4000;

let shuttingDown = false;
let pollTimer: number | null = null;

function pollState() {
  if (shuttingDown || document.hidden) {
    return;
  }

  getState();
}

function startStatePolling() {
  if (pollTimer !== null) {
    return;
  }

  pollTimer = window.setInterval(pollState, STATE_POLL_INTERVAL_MS);
}

function stopStatePolling() {
  if (pollTimer === null) {
    return;
  }

  window.clearInterval(pollTimer);
  pollTimer = null;
}

function shutdownStatePolling() {
  shuttingDown = true;
  stopStatePolling();
}

document.addEventListener('visibilitychange', () => {
  if (shuttingDown) {
    return;
  }

  if (document.hidden) {
    stopStatePolling();
    return;
  }

  reconnect();
  startStatePolling();
});

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) {
    return;
  }

  if (event.data && event.data.type === 'furatic:shutdown-state-socket') {
    shutdownStatePolling();
  }
});

addEventListener('pagehide', () => {
  shutdownStatePolling();
}, {capture: true});

addEventListener('beforeunload', () => {
  shutdownStatePolling();
}, {capture: true});

reconnect();
startStatePolling();
