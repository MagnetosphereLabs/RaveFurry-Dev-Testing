import {keyOfElement} from './buttons';
import {state} from './update';
import {warningToastWithBar, errorToast} from '../base';
import {getVoteState, acceptVote, setVotePending, paintVotes} from './vote-state';
import {getState} from '../base';

/** Adds handlers to buttons that are visible when voting is enabled. */
export function onReady() {
  // Use a token bucket implementation to allow 10 Votes per minute.
  const maxTokens = 10;
  let currentTokens = maxTokens;
  const bucketLifetime = 30000; // half a minute
  let currentBucket = $.now();

  let lastActivationAt = 0;
  let lastActivationSignature = '';

  function canVote() {
    const now = $.now();
    const timePassed = now - currentBucket;

    if (timePassed > bucketLifetime) {
      currentBucket = now;
      currentTokens = maxTokens - 1;
      return true;
    }

    if (currentTokens > 0) {
      currentTokens--;
      return true;
    }

    const ratio = (bucketLifetime - timePassed) / bucketLifetime;
    warningToastWithBar('You\'re doing that too often');
    $('#vote-timeout-bar').css('transition', 'none');
    $('#vote-timeout-bar').css('width', ratio * 100 + '%');
    $('#vote-timeout-bar')[0].offsetHeight;
    $('#vote-timeout-bar').css({
      'transition': 'width ' + ratio * bucketLifetime / 1000 + 's linear',
      'width': '0%',
    });
    return false;
  }

  function triggerVoteAnimation(buttonElement) {
    if (
      !buttonElement ||
      !(buttonElement instanceof HTMLElement) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    buttonElement.classList.remove('furatic-vote-bump');
    void buttonElement.offsetWidth;
    buttonElement.classList.add('furatic-vote-bump');

    window.setTimeout(function() {
      buttonElement.classList.remove('furatic-vote-bump');
    }, 560);
  }

  function findVoteButton(event) {
    const target = event && event.target instanceof Element ? event.target : null;
    if (!target) {
      return null;
    }

    return target.closest('.vote-up, .vote-down');
  }

  function activationSignature(buttonElement) {
    const button = $(buttonElement).closest('.vote-up, .vote-down');
    const keyedElement = button.closest('[data-queue-key]');
    const key = keyedElement.attr('data-queue-key') || button.closest('[data-history-id]').attr('data-history-id') || '';
    const id = button.attr('id') || '';
    const direction = button.hasClass('vote-up') ? 'up' : 'down';

    return direction + ':' + String(button.closest('[data-occurrence-id]').attr('data-occurrence-id') || '') + ':' + key + ':' + id;
  }

  function markActivationHandled(event, buttonElement) {
    const originalEvent = event;

    const now = Date.now();
    const signature = activationSignature(buttonElement);

    if (signature === lastActivationSignature && now - lastActivationAt < 650) {
      if (originalEvent.cancelable) {
        originalEvent.preventDefault();
      }
      originalEvent.stopImmediatePropagation();
      return false;
    }

    lastActivationSignature = signature;
    lastActivationAt = now;

    if (originalEvent.cancelable) {
      originalEvent.preventDefault();
    }
    originalEvent.stopImmediatePropagation();

    return true;
  }

  function resolveVoteKey(button) {
    const historyRow = button.closest('[data-history-id]');
    if (historyRow.length) return Number(historyRow.attr('data-history-id'));
    if (button.closest('#current-song-card').length > 0) {
      if (state == null || state.currentSong == null) {
        return -1;
      }

      return state.currentSong.queueKey;
    }

    return keyOfElement(button);
  }

  // A slow/reconnecting phone can render the shared queue before its personal
  // vote snapshot arrives. Preserve that tap, share one bounded read, then use
  // the server's choice/revision. Never assume an unknown choice is zero.
  let personalRead: Promise<void> | null = null;
  const awaitingState = new Set<string>();
  function loadPersonalVotes(): Promise<void> {
    if (personalRead) return personalRead;
    const endpoint = urls['musiq']['own-song-state'];
    if (!endpoint) return Promise.reject(new Error('Voting is reconnecting. Please try again.'));
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 9000);
    personalRead = (async () => {
      const response = await fetch(endpoint, {credentials: 'same-origin', cache: 'no-store', signal: abort.signal});
      if (!response.ok) throw new Error('Voting is reconnecting. Please try again.');
      const result = await response.json();
      if (!Array.isArray(result.myVotes)) throw new Error('Voting is reconnecting. Please try again.');
      document.dispatchEvent(new CustomEvent('furatic:personal-votes', {detail: result.myVotes}));
    })().finally(() => { window.clearTimeout(timeout); personalRead = null; });
    return personalRead;
  }

  async function handleVotePress(buttonElement) {
    const button = $(buttonElement);
    const row = button.closest('[data-occurrence-id]');
    const occurrence = row.attr('data-occurrence-id');
    if (!occurrence || buttonElement.closest('[inert]')) return false;
    const blocked = () => button.attr('data-furatic-own-vote-blocked') === 'true' ||
      row.attr('data-priority-tier') === 'extra' || row.attr('data-history-pending') === 'true' ||
      button.attr('data-vote-pending') === 'true';
    if (blocked() || awaitingState.has(occurrence)) return false;
    let previous = getVoteState(occurrence);
    if (!previous) {
      awaitingState.add(occurrence);
      try { await loadPersonalVotes(); }
      catch (_error) { errorToast('Voting is reconnecting. Please try again.'); return false; }
      finally { awaitingState.delete(occurrence); }
      // Do not transfer an old tap to a different song after a playing handoff.
      if (!buttonElement.isConnected || row.attr('data-occurrence-id') !== occurrence ||
          document.hidden || buttonElement.closest('[inert]')) return false;
      previous = getVoteState(occurrence);
      if (!previous) { errorToast('This song has changed. Please try your vote again.'); return false; }
    }
    if (blocked() || previous.eligible === false) return false;
    const key = resolveVoteKey(button);
    if (key === -1 || !canVote()) return false;
    const direction = button.hasClass('vote-up') ? 1 : -1;
    const desired = previous.choice === direction ? 0 : direction;
    const voteCount = row.find('.queue-vote-count, #current-song-votes');
    const originalCount = Number(voteCount.text()) || 0;
    const mutation = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() :
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
    acceptVote({...previous, choice: desired}, true);
    setVotePending(occurrence, true);
    voteCount.text(String(originalCount + desired - previous.choice));
    triggerVoteAnimation(buttonElement);
    const form = new URLSearchParams();
    form.set('key', String(key));
    form.set('occurrence', occurrence);
    form.set('choice', String(desired));
    form.set('revision', String(previous.voteRevision));
    form.set('mutation', mutation);
    if (row.is('[data-history-id]')) form.set('history', '1');
    form.set('csrfmiddlewaretoken', CSRF_TOKEN);
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 9000);
    try {
      const response = await fetch(urls['musiq']['vote'], {
        method: 'POST', credentials: 'same-origin', signal: abort.signal,
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-CSRFToken': CSRF_TOKEN},
        body: form.toString(),
      });
      const result = await response.json();
      if (result.occurrenceId && typeof result.choice === 'number') {
        acceptVote(result, true);
        if (typeof result.votes === 'number') voteCount.text(String(result.votes));
      }
      if (!response.ok) {
        if (!result.occurrenceId) acceptVote(previous, true);
        throw new Error(result.message || 'Could not register vote');
      }
    } catch (error) {
      // A timed-out POST may have committed. Re-read; never retry a mutation blindly.
      errorToast(error && error.message && error.name !== 'AbortError' ? error.message : 'Checking your vote after a connection interruption.');
    } finally {
      window.clearTimeout(timeout);
      setVotePending(occurrence, false);
      document.dispatchEvent(new CustomEvent('furatic:refresh-personal-votes'));
      getState();
      paintVotes();
      if (row.is('[data-history-id]')) document.dispatchEvent(new CustomEvent('furatic:history-refresh'));
    }
    return true;
  }

  function handleVoteActivation(event) {
    const buttonElement = findVoteButton(event);
    if (!buttonElement) {
      return;
    }

    if (buttonElement.getAttribute('data-furatic-own-vote-blocked') === 'true') {
      return;
    }

    if (!markActivationHandled(event, buttonElement)) {
      return;
    }

    handleVotePress(buttonElement);
  }

  // Touch completion is explicit: some mobile engines suppress the later
  // compatibility click after hover/content changes. Do not cancel touchstart
  // or touchmove: the browser must keep native scrolling and pinch zoom.
  type Tap = {id: number, button: Element, signature: string, x: number, y: number, began: number};
  let tap: Tap | null = null;
  let completedTouch = '', suppressClickUntil = 0;
  function cancelTap() {
    if (tap) {
      completedTouch = tap.signature;
      suppressClickUntil = Date.now() + 1000;
    }
    tap = null;
  }
  function beginTap(id: number, x: number, y: number, event: Event) {
    cancelTap();
    const button = findVoteButton(event);
    if (!button || button.closest('[inert]') || button.hasAttribute('disabled') ||
        button.getAttribute('data-furatic-own-vote-blocked') === 'true') return;
    tap = {id, button, signature: activationSignature(button), x, y, began: Date.now()};
  }
  function moveTap(id: number, x: number, y: number) {
    if (tap?.id === id && Math.hypot(x - tap.x, y - tap.y) > 12) cancelTap();
  }
  function finishTap(id: number, x: number, y: number, event: Event) {
    const candidate = tap;
    if (!candidate || candidate.id !== id) return;
    cancelTap();
    if (Date.now() - candidate.began > 900 || Math.hypot(x - candidate.x, y - candidate.y) > 12 ||
        !candidate.button.isConnected || activationSignature(candidate.button) !== candidate.signature ||
        document.elementFromPoint(x, y)?.closest('.vote-up, .vote-down') !== candidate.button) return;
    if (markActivationHandled(event, candidate.button)) handleVotePress(candidate.button);
  }
  if (typeof window.PointerEvent === 'function') {
    document.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch') return;
      if (!event.isPrimary) { cancelTap(); return; }
      beginTap(event.pointerId, event.clientX, event.clientY, event);
    }, {capture: true, passive: true});
    document.addEventListener('pointermove', event => moveTap(event.pointerId, event.clientX, event.clientY), {capture: true, passive: true});
    document.addEventListener('pointerup', event => finishTap(event.pointerId, event.clientX, event.clientY, event), {capture: true, passive: false});
    document.addEventListener('pointercancel', cancelTap, {capture: true, passive: true});
  } else {
    // Older touch browsers use this branch exclusively, never in addition to pointers.
    document.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) { cancelTap(); return; }
      const touch = event.changedTouches[0];
      beginTap(touch.identifier, touch.clientX, touch.clientY, event);
    }, {capture: true, passive: true});
    document.addEventListener('touchmove', event => {
      for (const touch of Array.from(event.changedTouches)) moveTap(touch.identifier, touch.clientX, touch.clientY);
    }, {capture: true, passive: true});
    document.addEventListener('touchend', event => {
      if (event.touches.length) { cancelTap(); return; }
      const touch = event.changedTouches[0];
      finishTap(touch.identifier, touch.clientX, touch.clientY, event);
    }, {capture: true, passive: false});
    document.addEventListener('touchcancel', cancelTap, {capture: true, passive: true});
  }
  document.addEventListener('scroll', cancelTap, {capture: true, passive: true});
  document.addEventListener('visibilitychange', cancelTap);
  window.addEventListener('pagehide', cancelTap);

  // Desktop, keyboard and assistive activation retain the ordinary click path.
  document.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') &&
        !(findVoteButton(event) instanceof HTMLButtonElement)) handleVoteActivation(event);
  }, {capture: true});

  document.addEventListener('click', event => {
    const button = findVoteButton(event);
    // A real tap and its delayed generated click are one action, including when
    // a fast POST finishes before the browser dispatches that generated click.
    if (button && event.detail !== 0 && Date.now() < suppressClickUntil &&
        activationSignature(button) === completedTouch) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    handleVoteActivation(event);
  }, {
    capture: true,
    passive: false,
  });
}

$(document).ready(() => {
  if (!["/musiq/", "/p/"].includes(window.location.pathname)) {
    return;
  }

  onReady();
});
