import {requestNewMusic} from './buttons';

type Result = {videoId: string, title: string, artist: string, durationFormatted: string, artworkUrl: string, url: string};

/** Overlay the existing queue without changing any of its layout or scroll state. */
export function installSearchPicker(): boolean {
  if ((window as any).FURATIC_TUTORIAL_PLAYER) return true;
  const input = document.getElementById('music-input') as HTMLInputElement;
  const card = document.getElementById('music-input-card');
  if (!input || !card) return false;
  if (input.dataset.pickerReady) return true;
  input.dataset.pickerReady = 'true';
  const panel = document.createElement('section');
  panel.id = 'furatic-search-picker'; panel.className = 'furatic-search-picker';
  panel.setAttribute('aria-label', 'Song search results'); panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = '<div class="song-search-scroll" role="listbox" id="song-search-results" aria-label="Choose a song"></div><div class="song-search-status" role="status"></div>';
  // Share the input's stacking context so one glass surface can sit behind
  // both regions. The existing input and queue nodes stay in their places.
  (card.closest('.furatic-embed-shell') || document.body).appendChild(panel);
  const list = panel.querySelector<HTMLElement>('.song-search-scroll');
  const status = panel.querySelector<HTMLElement>('.song-search-status');
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'song-search-results'); input.setAttribute('aria-expanded', 'false');
  let query = '', cursor: string = null, items: Result[] = [], selected = -1;
  let timer = 0, pendingTimer = 0, startedTyping = 0, lastLookup = 0, generation = 0;
  let request: AbortController = null, opened = false, loading = false, selecting = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const maxResults = 25;
  const inputGroup = card.parentElement;
  let closingTimer = 0;
  const eligible = (text: string) => /[\p{L}\p{N}]/u.test(text) && !/https?:\/\//i.test(text);
  function position() {
    if (!opened) return;
    const bounds = card.getBoundingClientRect();
    panel.style.left = bounds.left + 'px'; panel.style.top = bounds.top + 'px';
    panel.style.width = bounds.width + 'px';
    panel.style.setProperty('--search-input-height', bounds.height + 'px');
    panel.style.setProperty('--search-radius', getComputedStyle(card).borderTopLeftRadius || '18px');
    const footer = status.textContent ? 38 : 0;
    const available = Math.max(0, window.innerHeight - bounds.bottom - 28 - footer);
    const rowHeight = available < 228 ? 64 : 76;
    const rows = Math.min(3, Math.max(1, Math.floor(available / rowHeight)), items.length);
    panel.style.setProperty('--search-row-height', rowHeight + 'px');
    list.style.height = rows * rowHeight + 'px';
    panel.style.height = bounds.height + 18 + rows * rowHeight + footer + 'px';
  }
  function open() {
    window.clearTimeout(closingTimer);
    if (!opened) {
      panel.style.height = card.getBoundingClientRect().height + 'px';
      void panel.offsetHeight; // Start the expansion at the original input outline.
    }
    opened = true;
    panel.classList.add('is-open'); card.classList.add('has-search-picker');
    inputGroup.classList.add('has-search-surface');
    panel.setAttribute('aria-hidden', 'false'); input.setAttribute('aria-expanded', 'true');
    position();
  }
  function close() {
    opened = false; panel.classList.remove('is-open');
    panel.style.height = card.getBoundingClientRect().height + 'px'; panel.setAttribute('aria-hidden', 'true');
    window.clearTimeout(closingTimer);
    closingTimer = window.setTimeout(() => {
      card.classList.remove('has-search-picker'); inputGroup.classList.remove('has-search-surface');
    }, reduced.matches ? 0 : 520);
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    selected = -1;
  }
  function cancel() {
    generation++; window.clearTimeout(timer); window.clearTimeout(pendingTimer);
    request?.abort(); request = null; loading = false; startedTyping = 0;
  }
  function showStatus(text: string, spinner = false) {
    status.replaceChildren(); status.classList.toggle('is-loading', spinner);
    if (spinner) { const spin = document.createElement('span'); spin.className = 'song-search-spinner'; spin.setAttribute('aria-hidden', 'true'); status.appendChild(spin); }
    status.appendChild(document.createTextNode(text)); status.hidden = !text;
    position();
  }
  function highlight(index: number) {
    selected = Math.max(-1, Math.min(items.length - 1, index));
    list.querySelectorAll<HTMLElement>('.song-search-row').forEach((row, at) => {
      row.setAttribute('aria-selected', String(at === selected));
      if (at === selected) { input.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({block: 'nearest', behavior: 'auto'}); }
    });
  }
  function append(rows: Result[]) {
    const ids = new Set(items.map(row => row.videoId));
    rows.forEach(item => {
      if (items.length >= maxResults || !/^[A-Za-z0-9_-]{11}$/.test(item.videoId) || ids.has(item.videoId)) return;
      ids.add(item.videoId); const index = items.length; items.push(item);
      const row = document.createElement('button'); row.type = 'button'; row.className = 'song-search-row';
      row.id = 'song-search-result-' + index; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
      const image = document.createElement('img'); image.alt = ''; image.decoding = 'async'; image.loading = 'lazy';
      try { const url = new URL(item.artworkUrl, location.href); if (url.origin === location.origin || url.protocol === 'https:') image.src = url.href; } catch (_) { /* Optional artwork. */ }
      image.addEventListener('error', () => image.style.opacity = '0');
      const copy = document.createElement('span'); copy.className = 'song-search-copy';
      const title = document.createElement('span'); title.className = 'song-search-title'; title.textContent = item.title;
      const artist = document.createElement('span'); artist.className = 'song-search-artist'; artist.textContent = item.artist;
      copy.append(title, artist);
      const duration = document.createElement('span'); duration.className = 'song-search-duration'; duration.textContent = item.durationFormatted;
      row.append(image, copy, duration); list.appendChild(row);
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => choose(index));
      if (!reduced.matches && row.animate) row.animate([
        {opacity: 0, transform: 'translateY(9px) scale(.985)', filter: 'blur(4px)'},
        {opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0px)'},
      ], {duration: 350, delay: Math.min(index % 5 * 28, 112), easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards'});
    });
    document.dispatchEvent(new CustomEvent('furatic:search-results'));
    position();
  }
  function choose(index: number) {
    const item = items[index]; if (!item || selecting) return;
    const previousQuery = query;
    const result = requestNewMusic('https://www.youtube.com/watch?v=' + item.videoId, 'youtube');
    if (!result) return;
    selecting = true; cancel(); close();
    result.fail(() => {
      if (!input.value || input.value === item.url) { input.value = previousQuery; $(input).trigger('change'); }
    }).always(() => { selecting = false; });
  }
  async function load(more = false) {
    if (loading || document.hidden || !eligible(query) || (more && (!cursor || items.length >= maxResults))) return;
    loading = true; const ticket = generation, term = query;
    const abort = new AbortController(); request = abort;
    const timeout = window.setTimeout(() => abort.abort(), 9000);
    lastLookup = performance.now(); startedTyping = 0;
    showStatus(more && items.length ? 'Loading more…' : 'Finding your music…', true); open();
    try {
      const url = new URL('/api/musiq/search/', location.href); url.searchParams.set('q', term);
      if (more && cursor) url.searchParams.set('cursor', cursor);
      const response = await fetch(url.href, {credentials: 'same-origin', cache: 'no-store', signal: abort.signal});
      const data = await response.json();
      if (ticket !== generation || term !== query || document.hidden) return;
      if (!response.ok) throw new Error(data.message || 'Search will be available again shortly.');
      if (!more) { list.replaceChildren(); items = []; selected = -1; list.scrollTop = 0; }
      append(data.results || []); cursor = items.length < maxResults ? data.next || null : null;
      const pending = Boolean(data.pending && cursor);
      showStatus(pending ? (items.length ? 'Loading more…' : 'Finding your music…') : data.message || (items.length ? '' : 'No matches found.'), pending);
      if (pending) pendingTimer = window.setTimeout(() => load(true), 1100);
    } catch (error) {
      if (ticket === generation && error.name !== 'AbortError') showStatus(error.message || 'Search is temporarily unavailable.');
    } finally {
      window.clearTimeout(timeout);
      if (request === abort) { request = null; loading = false; }
    }
  }
  function changed() {
    const value = input.value.trim();
    if (value === query) { if (!value) close(); return; }
    const since = startedTyping;
    cancel(); query = value; cursor = null;
    if (!eligible(value)) { close(); return; }
    startedTyping = since || performance.now();
    const debounce = Math.min(350, Math.max(0, 1200 - (performance.now() - startedTyping)));
    timer = window.setTimeout(() => { if (query === value) load(); }, Math.max(debounce, 1000 - (performance.now() - lastLookup)));
  }
  input.addEventListener('input', changed); input.addEventListener('change', changed);
  $(input).on('change', changed);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { cancel(); close(); return; }
    if (!opened) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation(); highlight(selected + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && selected >= 0) {
      event.preventDefault(); event.stopImmediatePropagation(); choose(selected);
    } else if (event.key === 'Enter') { cancel(); close(); }
  }, true);
  list.addEventListener('scroll', () => {
    if (opened && !loading && cursor && list.scrollHeight - list.scrollTop - list.clientHeight < 96) load(true);
  }, {passive: true});
  document.addEventListener('pointerdown', event => { if (opened && !card.contains(event.target as Node) && !panel.contains(event.target as Node)) { cancel(); close(); } });
  document.addEventListener('furatic:music-request-accepted', () => { if (!input.value) { query = ''; cancel(); close(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancel(); close(); } });
  const cardResize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : null;
  cardResize?.observe(card);
  window.addEventListener('resize', position); window.visualViewport?.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  window.addEventListener('pagehide', () => { cancel(); window.clearTimeout(closingTimer); card.classList.remove('has-search-picker'); inputGroup.classList.remove('has-search-surface'); cardResize?.disconnect(); panel.remove(); });
  return true;
}
