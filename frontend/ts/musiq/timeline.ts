import {acceptVote, paintVotes} from './vote-state';

type Anchor = {home: boolean, occurrence: string | null, section: string, offset: number, top: number, previousHome: number};

/** One native scroll surface for past, playing and upcoming songs. */
export class HistoryTimeline {
  private scroll = document.getElementById('main-queue-scroll');
  private card = document.getElementById('current-song-card');
  private list = document.getElementById('history-song-queue');
  private button = document.getElementById('timeline-recenter') as HTMLButtonElement;
  private songs: any[] = [];
  private home = 0;
  private ready = false;
  private loaded = false;
  private busy = false;
  private again = false;
  private disposed = false;
  private generation = 0;
  private abort: AbortController | null = null;
  private frame = 0;
  private motion: {start: number, end: number, began: number} | null = null;
  private resizeFrame = 0;
  private idle = 0;
  private requestTimeout = 0;
  private poll = 0;
  private observer: ResizeObserver | null = null;
  private previousTop = 0;
  private nearCrossing = false;
  private boundaryUntil = 0;
  private lastWheel = 0;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private render: (songs: any[], animate: boolean, settle: () => void) => void) {
    if (!this.scroll || !this.card || !this.list || !this.button) return;
    this.scroll.addEventListener('scroll', this.onScroll, {passive: true});
    this.scroll.addEventListener('wheel', this.onWheel, {passive: false});
    this.scroll.addEventListener('pointerdown', this.stop, {passive: true});
    this.scroll.addEventListener('touchstart', this.stop, {passive: true});
    this.scroll.addEventListener('keydown', this.onKey);
    this.button.addEventListener('click', this.onCenter);
    document.addEventListener('furatic:history-refresh', this.onRefresh);
    document.addEventListener('furatic:queue-panel-change', this.onPanelChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(this.scroll);
      this.observer.observe(this.card);
      this.observer.observe(this.list);
    }
    this.restore(null);
    if (!(window as any).FURATIC_TUTORIAL_PLAYER) {
      this.refresh();
      this.poll = window.setInterval(() => { if (!document.hidden) this.refresh(); }, 30000);
    }
  }

  capture(): Anchor {
    const viewport = this.scroll.getBoundingClientRect();
    const upcoming = this.scroll.scrollTop > this.home + 3;
    const pinned = this.scroll.classList.contains('has-upcoming-overflow') &&
      this.scroll.scrollTop >= document.getElementById('timeline-current-anchor').offsetTop;
    const edge = viewport.top + (pinned ? this.card.getBoundingClientRect().height : 0);
    const row = Array.from(this.scroll.querySelectorAll<HTMLElement>(upcoming ?
        '#song-queue > li[data-occurrence-id]' : '#history-song-queue > li[data-occurrence-id], #current-song'))
        .find(node => node.getBoundingClientRect().bottom > edge + 1);
    return {home: !this.ready || Math.abs(this.scroll.scrollTop - this.home) < 3,
      occurrence: row?.dataset.occurrenceId || null,
      section: row?.closest('#song-queue') ? '#song-queue > li' : row?.closest('#history-song-queue') ? '#history-song-queue > li' : '#current-song',
      offset: row ? row.getBoundingClientRect().top - viewport.top : 0,
      top: this.scroll.scrollTop, previousHome: this.home};
  }

  restore(anchor: Anchor | null, followRow = true) {
    if (!this.scroll || !this.card) return;
    const previousHome = this.home;
    const last = this.list.lastElementChild as HTMLElement;
    const fullPeek = last ? last.offsetHeight + (parseFloat(getComputedStyle(last).marginBottom) || 0) + 8 : 0;
    const peek = Math.min(fullPeek, Math.max(0, this.scroll.clientHeight - this.card.offsetHeight - 24));
    // A separate flow marker stays stable while the playing card is sticky.
    const marker = document.getElementById('timeline-current-anchor');
    this.home = Math.max(0, marker.offsetTop - peek);
    const tail = document.getElementById('timeline-tail');
    const content = tail.offsetTop - marker.offsetTop;
    this.scroll.classList.toggle('has-upcoming-overflow', content > this.scroll.clientHeight);
    const padding = Math.max(0, this.scroll.clientHeight - peek - content);
    if (tail.style.height !== padding + 'px') tail.style.height = padding + 'px';
    if (!anchor || anchor.home) this.scroll.scrollTop = this.home;
    else {
      const row = followRow && Array.from(this.scroll.querySelectorAll<HTMLElement>(anchor.section))
          .find(node => node.dataset.occurrenceId === anchor.occurrence);
      const viewport = this.scroll.getBoundingClientRect();
      const scale = viewport.height / this.scroll.offsetHeight || 1;
      this.scroll.scrollTop = row ? this.scroll.scrollTop +
        (row.getBoundingClientRect().top - viewport.top - anchor.offset) / scale :
        anchor.top + this.home - anchor.previousHome;
    }
    // A handoff can grow history while the return animation is still running.
    // Keep its deadline and current position, but follow the new home position.
    if (this.motion) {
      const progress = Math.min(1, (performance.now() - this.motion.began) / 520);
      const eased = 1 - Math.pow(1 - progress, 4);
      this.motion.end += this.home - previousHome;
      this.motion.start = eased < .999999 ?
        (this.scroll.scrollTop - this.motion.end * eased) / (1 - eased) : this.scroll.scrollTop;
    }
    this.ready = true;
    this.previousTop = this.scroll.scrollTop;
    this.updateButton();
    if (this.scroll.dataset.panelCovered === 'true') this.syncPanelOffset();
  }

  /** Bridge the handoff immediately; the committed history response replaces it. */
  retire(song: any) {
    if (!song?.occurrenceId || !song.playbackStartedAt) return;
    this.generation++;
    if (this.songs.some(row => row.occurrenceId === song.occurrenceId)) return;
    const anchor = this.capture();
    this.songs = [{...song, id: null, pendingHistory: true,
      ownedHistory: document.getElementById('current-song')?.classList.contains('furatic-owned-song') || false,
      ownershipSeed: song.queueKey, endedAt: new Date().toISOString()}, ...this.songs].slice(0, 50);
    this.render([...this.songs].reverse(), true, () => this.restore(anchor));
  }

  async refresh() {
    if (this.disposed || !this.list || (window as any).FURATIC_TUTORIAL_PLAYER) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    const generation = this.generation;
    this.abort = new AbortController();
    this.requestTimeout = window.setTimeout(() => this.abort?.abort(), 9000);
    const status = document.getElementById('history-status');
    try {
      const response = await fetch(urls['musiq']['played-history'], {
        credentials: 'same-origin', cache: 'no-store', signal: this.abort.signal,
      });
      if (!response.ok) throw new Error('History unavailable');
      const result = await response.json();
      if (this.disposed) return;
      if (generation !== this.generation) { this.again = true; return; }
      if (!Array.isArray(result.songs)) throw new Error('Invalid history');
      const anchor = this.capture();
      status.textContent = '';
      const seen = new Set<string>();
      const playing = document.getElementById('current-song')?.dataset.occurrenceId;
      this.songs = result.songs.filter(song => song.occurrenceId && song.occurrenceId !== playing && !seen.has(song.occurrenceId) &&
        Boolean(seen.add(song.occurrenceId))).slice(0, 50);
      this.render([...this.songs].reverse(), this.loaded, () => this.restore(anchor));
      this.loaded = true;
      if (Array.isArray(result.myVotes)) result.myVotes.forEach(vote => acceptVote(vote));
      paintVotes();
    } catch (error) {
      if (!this.disposed && error.name !== 'AbortError') {
        const anchor = this.capture();
        status.textContent = 'Recently played songs will refresh when the connection returns.';
        this.restore(anchor);
      }
    } finally {
      window.clearTimeout(this.requestTimeout);
      this.requestTimeout = 0;
      this.busy = false;
      this.abort = null;
      if (this.again && !this.disposed) { this.again = false; this.refresh(); }
    }
  }

  private updateButton() {
    const show = !this.scroll.hasAttribute('inert') && this.scroll.dataset.panelCovered !== 'true' &&
      this.scroll.scrollTop < this.home - Math.max(120, this.scroll.clientHeight * .35);
    this.button.classList.toggle('is-visible', show);
    this.button.disabled = !show;
    this.button.setAttribute('aria-hidden', String(!show));
    this.button.toggleAttribute('inert', !show);
  }

  private onScroll = () => {
    const top = this.scroll.scrollTop;
    if (!this.frame && (this.previousTop - this.home) * (top - this.home) < 0 && Math.abs(top - this.home) < 72) {
      this.nearCrossing = true;
    }
    this.previousTop = top;
    this.updateButton();
    window.clearTimeout(this.idle);
    if (!this.frame) this.idle = window.setTimeout(() => {
      this.idle = 0;
      if (this.nearCrossing && Math.abs(this.scroll.scrollTop - this.home) < 72) this.center();
      this.nearCrossing = false;
    }, 150);
  };

  private onWheel = (event: WheelEvent) => {
    if (this.scroll.dataset.panelCovered === 'true' || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? this.scroll.clientHeight : 1);
    const now = performance.now();
    const newGesture = now - this.lastWheel > 160;
    this.lastWheel = now;
    if (this.boundaryUntil > now && !newGesture) { event.preventDefault(); return; }
    if (this.boundaryUntil && (newGesture || now >= this.boundaryUntil)) {
      this.boundaryUntil = 0;
      if (this.frame) { event.preventDefault(); this.center(this.home + delta); return; }
      this.stop();
      return;
    }
    this.stop();
    const distance = this.scroll.scrollTop - this.home;
    if (Math.abs(distance) > 3 && distance * (distance + delta) <= 0) {
      event.preventDefault();
      this.boundaryUntil = now + 350;
      this.center();
    }
  };

  private onKey = (event: KeyboardEvent) => {
    if (event.target !== this.scroll || this.scroll.dataset.panelCovered === 'true') return;
    const delta = event.key === 'PageUp' ? -this.scroll.clientHeight * .8 :
      event.key === 'PageDown' ? this.scroll.clientHeight * .8 :
      event.key === 'ArrowUp' ? -56 : event.key === 'ArrowDown' ? 56 : 0;
    const distance = this.scroll.scrollTop - this.home;
    if (delta && Math.abs(distance) > 3 && distance * (distance + delta) <= 0) {
      event.preventDefault(); this.center();
    }
  };

  center(target = this.home) {
    this.stop();
    const start = this.scroll.scrollTop;
    const end = target;
    if (this.reduced.matches || Math.abs(start - end) < 1) { this.scroll.scrollTop = end; return; }
    this.motion = {start, end, began: performance.now()};
    const tick = (now: number) => {
      const motion = this.motion;
      if (this.disposed || !motion) return;
      const progress = Math.min(1, (now - motion.began) / 520);
      this.scroll.scrollTop = motion.start + (motion.end - motion.start) * (1 - Math.pow(1 - progress, 4));
      if (progress < 1) this.frame = requestAnimationFrame(tick);
      else { this.frame = 0; this.motion = null; this.nearCrossing = false; }
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stop = () => {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.motion = null;
    window.clearTimeout(this.idle); this.idle = 0;
    this.nearCrossing = false;
  };
  private onCenter = () => { this.scroll.focus({preventScroll: true}); this.center(); };
  private onRefresh = () => { this.generation++; this.refresh(); };
  private syncPanelOffset() {
    const viewport = this.scroll.getBoundingClientRect();
    const card = this.card.getBoundingClientRect();
    const visible = card.top < viewport.bottom && card.bottom > viewport.top;
    const scale = viewport.height / this.scroll.offsetHeight || 1;
    const offset = visible ? Math.min(this.scroll.clientHeight, Math.max(0, (card.bottom - viewport.top) / scale + 8)) : 0;
    this.scroll.dataset.panelCurrentVisible = String(visible);
    this.scroll.closest<HTMLElement>('.furatic-queue-middle').style.setProperty('--timeline-playing-bottom', offset + 'px');
  }
  private onPanelChange = () => { this.syncPanelOffset(); this.updateButton(); };
  private onResize = () => {
    if (this.resizeFrame) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = 0;
      if (!this.disposed) { const anchor = this.capture(); this.restore(anchor); }
    });
  };
  private resume = () => {
    if (this.disposed) return;
    this.center();
    this.refresh();
  };
  private onVisibility = () => { if (document.hidden) this.stop(); else this.resume(); };
  private onPageShow = (event: PageTransitionEvent) => { if (event.persisted) this.resume(); };
  private onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) this.dispose(); else this.stop(); };

  dispose() {
    this.disposed = true;
    this.stop();
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    window.clearInterval(this.poll); window.clearTimeout(this.requestTimeout);
    this.abort?.abort(); this.observer?.disconnect();
    this.scroll.removeEventListener('scroll', this.onScroll);
    this.scroll.removeEventListener('wheel', this.onWheel);
    this.scroll.removeEventListener('pointerdown', this.stop);
    this.scroll.removeEventListener('touchstart', this.stop);
    this.scroll.removeEventListener('keydown', this.onKey);
    this.button.removeEventListener('click', this.onCenter);
    document.removeEventListener('furatic:history-refresh', this.onRefresh);
    document.removeEventListener('furatic:queue-panel-change', this.onPanelChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
  }
}
