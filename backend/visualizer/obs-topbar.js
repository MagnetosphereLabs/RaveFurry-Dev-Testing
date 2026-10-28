/* OBS-only metadata UI. The audio renderer and WebGL scene stay independent. */
(() => {
  'use strict';
  const bar = document.getElementById('obs-topbar');
  if (!bar) return;
  const notice = document.getElementById('vote-notice');
  const songRoot = document.getElementById('obs-song');
  const art = document.getElementById('obs-artwork');
  const progress = document.getElementById('obs-progress-fill');
  const fields = Object.fromEntries(['title','artist','elapsed','duration','votes'].map(key => [key, document.getElementById('obs-song-' + key)]));
  const noticeFields = Object.fromEntries(['headline','title','artist','detail','footer'].map(key => [key, document.getElementById('vote-notice-' + key)]));
  const ordinal = document.getElementById('vote-notice-ordinal');
  const texts = new Map(), effects = new Set(), marquees = new Map(), nodeEffects = new WeakMap();
  const easing = 'cubic-bezier(.22,1,.36,1)';
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity:'grapheme'}) : null;
  let snapshot = null, received = 0, songId = '', notificationId = '', coverId = '', coverGeneration = 0;
  let timer = 0, clock = 0, controller = null, stopped = false, obsVisible = true;
  const options = new URLSearchParams(location.search);
  const port = Number(options.get('port') || (location.protocol === 'http:' && ['127.0.0.1','localhost'].includes(location.hostname) ? location.port : 8766));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  const origin = 'http://127.0.0.1:' + port;
  const graphemes = text => segmenter ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
  const visible = () => !stopped && obsVisible && !document.hidden;
  function animate(node, frames, timing) {
    if (!node.animate) return null;
    nodeEffects.get(node)?.cancel();
    const effect = node.animate(frames, {...timing, fill:'both'});
    nodeEffects.set(node,effect);
    effects.add(effect);
    const release = () => { effects.delete(effect); if(nodeEffects.get(node)===effect)nodeEffects.delete(node); effect.onfinish = effect.oncancel = null; effect.cancel(); };
    effect.onfinish = () => {
      // Keep the terminal appearance before releasing the animation. In
      // particular an outgoing digit must stay invisible until it is removed.
      const last = frames[frames.length - 1];
      for (const key of ['opacity', 'transform', 'filter']) if (last[key] !== undefined) node.style[key] = last[key];
      release();
    };
    effect.oncancel = release;
    return effect;
  }
  function marquee(element) {
    const state = texts.get(element);
    if (!state || state.digits || !state.content.isConnected) return;
    const width = element.clientWidth, distance = Math.max(0, state.content.scrollWidth - width);
    const prior = marquees.get(element);
    if (prior && prior.width === width && prior.distance === distance && prior.content === state.content) return;
    prior?.animation?.cancel();
    let animation = null;
    // Same resting, travelling and returning rhythm as the embedded queue.
    if (width > 0 && distance > 1) {
      const rest = 2000, travel = Math.max(1000, distance / 30 * 1000), duration = 2 * (rest + travel);
      animation = state.content.animate([
        {transform:'translateX(0px)',offset:0},
        {transform:'translateX(0px)',offset:rest/duration,easing:'ease-in-out'},
        {transform:`translateX(${-distance}px)`,offset:(rest+travel)/duration},
        {transform:`translateX(${-distance}px)`,offset:(2*rest+travel)/duration,easing:'ease-in-out'},
        {transform:'translateX(0px)',offset:1},
      ], {duration, iterations:Infinity, delay:850});
    }
    marquees.set(element, {width, distance, content:state.content, animation});
  }
  function typeText(element, value, digits = false) {
    const text = String(value ?? '');
    const prior = texts.get(element);
    if (prior?.text === text) return;
    element.setAttribute('aria-label', text);
    if (digits && prior?.digits && prior.text.length === text.length) {
      graphemes(text).forEach((letter, index) => {
        const cell = prior.content.children[index];
        if (cell.dataset.letter === letter) return;
        cell.dataset.letter = letter;
        const old = cell.firstElementChild;
        const next = document.createElement('span'); next.textContent = letter;
        cell.appendChild(next);
        if (old) {
          old.classList.add('obs-glyph-out');
          animate(old, [{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(-.28em) scale(.45)'}],{duration:190,easing});
          setTimeout(() => old.remove(), 210);
        }
        animate(next,[{opacity:0,transform:'translateY(.3em) scale(.5)'},{opacity:1,transform:'translateY(-.025em) scale(1.05)',offset:.78},{opacity:1,transform:'translate3d(0,0,0)'}],{duration:340,easing});
      });
      prior.text = text; return;
    }
    marquees.get(element)?.animation?.cancel(); marquees.delete(element);
    // Keep a single outgoing copy; quick changes cannot accumulate old labels.
    element.querySelectorAll(':scope > .obs-outgoing-text').forEach(node => node.remove());
    if (prior?.content.isConnected) {
      const old = prior.content; old.classList.add('obs-outgoing-text');
      animate(old,[{opacity:1,filter:'blur(0px)',transform:getComputedStyle(old).transform},{opacity:0,filter:'blur(5px)',transform:'translateY(-.18em) scale(.97)'}],{duration:280,easing});
      setTimeout(() => old.remove(), 300);
    }
    const content = document.createElement('span'); content.className = 'obs-text-content'; content.setAttribute('aria-hidden','true');
    graphemes(text).forEach((letter, index) => {
      const glyph = document.createElement('span'); glyph.className = digits ? 'obs-digit-cell' : 'obs-glyph';
      if (digits) { glyph.dataset.letter = letter; if (letter === ':') glyph.classList.add('is-colon'); const inner = document.createElement('span'); inner.textContent = letter; glyph.appendChild(inner); }
      else glyph.textContent = letter === ' ' ? '\u00a0' : letter;
      content.appendChild(glyph);
      animate(digits ? glyph.firstElementChild : glyph,[
        {opacity:0,transform:'translate(.12em,.38em) rotate(-5deg) scale(.45)',filter:'blur(3px)'},
        {opacity:1,transform:'translate(0,-.025em) rotate(1deg) scale(1.045)',filter:'blur(0px)',offset:.78},
        {opacity:1,transform:'translate3d(0,0,0)',filter:'none'},
      ], {duration:450,delay:Math.min(index * (digits ? 25 : 16),560),easing});
    });
    element.appendChild(content); texts.set(element,{text,content,digits});
    setTimeout(() => marquee(element), 30);
  }
  async function artwork(path) {
    if (path === coverId) return;
    const ticket = ++coverGeneration;
    if (!path) {
      coverId = ''; art.classList.add('is-empty');
      art.querySelectorAll('img').forEach(node => {
        animate(node,[{opacity:1,transform:'scale(1)',filter:'blur(0px)'},{opacity:0,transform:'scale(.8) rotate(-3deg)',filter:'blur(8px)'}],{duration:450,easing});
        setTimeout(() => node.remove(),470);
      });
      return;
    }
    if (!/^\/overlay-artwork\/[A-Za-z0-9_-]{11}$/.test(path)) return;
    const image = new Image(); image.alt = ''; image.decoding = 'async';
    image.src = origin + path;
    try { await image.decode(); } catch (_) { return; }
    if (ticket !== coverGeneration || !visible()) return;
    coverId = path; art.classList.remove('is-empty');
    const previous = art.querySelector('img');
    art.querySelectorAll('.is-outgoing').forEach(node => node.remove());
    if (previous) { previous.classList.add('is-outgoing'); animate(previous,[{opacity:1,transform:'scale(1)',filter:'blur(0px)'},{opacity:0,transform:'scale(.87) rotate(-4deg)',filter:'blur(8px)'}],{duration:500,easing}); setTimeout(() => previous.remove(),520); }
    art.appendChild(image);
    animate(image,[{opacity:0,transform:'translateY(8%) scale(.88) rotate(3deg)',filter:'blur(8px)'},{opacity:1,transform:'translateY(0) scale(1.025) rotate(-.5deg)',filter:'blur(0px)',offset:.8},{opacity:1,transform:'translateY(0) scale(1) rotate(0)',filter:'blur(0px)'}],{duration:650,easing});
  }
  function reminder(mode) {
    return {id:'default',kind:'reminder',headline:"Don't forget to vote!",title:'',artist:'',detail:'Help your favorite music reach the top.',footer:'Cast your vote and add music at',persistent:true};
  }
  function showNotification(message, mode) {
    const now = Date.now()/1000;
    const valid = message && (message.persistent === true && ['rank','reminder'].includes(message.kind) || message.expiresAt > now);
    const next = valid ? message : reminder(mode);
    if (next.id === notificationId) return;
    notificationId = next.id;
    // The surface is stationary. Only content and the retained badge morph.
    const rank = next.kind === 'rank' ? next.rank : 0;
    notice.dataset.rank = String(rank); notice.dataset.kind = next.kind;
    ordinal.textContent = rank ? ['', '1st','2nd','3rd'][rank] : '';
    for (const key of Object.keys(noticeFields)) typeText(noticeFields[key], next[key] || '');
    animate(notice.querySelector('.vote-notice-content'),[
      {opacity:.3,filter:'blur(5px)',transform:'scale(.985)'},
      {opacity:1,filter:'none',transform:'none'},
    ],{duration:480,easing});
    fitNotification();
    animate(document.getElementById('vote-notice-badge'),[
      {opacity:.2,transform:'translateY(.2em) scale(.82) rotate(-5deg)'},
      {opacity:1,transform:'translateY(0) scale(1.04) rotate(1deg)',offset:.78},
      {opacity:1,transform:'translateY(0) scale(1) rotate(0)'},
    ],{duration:680,easing});
  }
  const stamp = value => { const seconds = Math.max(0,Math.floor(Number(value)||0)); return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'); };
  function tick() {
    if (!visible() || !snapshot) return;
    const song = snapshot.song;
    const position = song ? Math.min(song.duration, song.position + (song.paused ? 0 : Math.max(0, performance.now()-received)/1000)) : 0;
    typeText(fields.elapsed, stamp(position), true);
    progress.style.transform = 'scaleX(' + (song?.duration > 0 ? Math.min(1,position/song.duration) : 0) + ')';
    if (snapshot.message && !snapshot.message.persistent && snapshot.message.expiresAt <= Date.now()/1000) showNotification(null,snapshot.mode);
  }
  function receive(value) {
    if (!value || value.version !== 1 || !Number.isFinite(value.updatedAt) || !value.updatedAt) return;
    bar.dataset.mode = value.mode;
    snapshot = value; received = performance.now() - Math.max(0,Date.now()/1000-value.updatedAt)*1000;
    const song = value.song, id = song?.id || (value.queueEmpty ? 'empty' : 'preparing');
    songRoot.dataset.state = song ? 'playing' : value.queueEmpty ? 'empty' : 'preparing';
    typeText(fields.title, song?.title || (value.queueEmpty ? 'Queue empty' : 'Getting your music ready…'));
    typeText(fields.artist, song?.artist || (!song && value.queueEmpty && value.mode === 'event' ? 'Add music at furatic.xyz' : ''));
    typeText(fields.duration, stamp(song?.duration || 0), true);
    typeText(fields.votes, song ? song.votes + (song.votes === 1 ? ' vote' : ' votes') : '');
    artwork(song?.artwork || '');
    if (id !== songId) { songId = id; animate(songRoot,[{filter:'blur(3px)'},{filter:'none'}],{duration:420,easing}); }
    showNotification(value.message,value.mode); tick();
  }
  async function poll() {
    timer = 0; if (!visible() || controller) return;
    const abort = new AbortController(); controller = abort;
    const timeout = setTimeout(() => abort.abort(),1500);
    try {
      const response = await fetch(origin + '/overlay-state',{cache:'no-store',credentials:'omit',signal:abort.signal});
      if (!response.ok) return;
      const body = await response.text(); if (body.length > 32768) return;
      if (visible()) receive(JSON.parse(body));
    } catch (_) { /* Retain the last coherent view during web/companion recovery. */ }
    finally { clearTimeout(timeout); if (controller === abort) controller = null; if (visible()) timer = setTimeout(poll,2000); }
  }
  function fitNotification() {
    // Measure the incoming labels, never the outgoing animated copies. The
    // divider follows the content while the song keeps a useful minimum area.
    const width = element => texts.get(element)?.content.scrollWidth || 0;
    const box = element => element.offsetWidth;
    const gap = element => parseFloat(getComputedStyle(element).columnGap) || 0;
    const header = notice.querySelector('.vote-notice-header');
    const footer = notice.querySelector('.vote-notice-footer');
    const song = notice.querySelector('.vote-notice-song');
    const headerWidth = width(noticeFields.headline) + box(notice.querySelector('.vote-notice-character')) + box(document.getElementById('vote-notice-badge')) + 2*gap(header);
    const footerWidth = width(noticeFields.footer) + box(notice.querySelector('.vote-notice-url')) + gap(footer);
    const songWidth = notice.dataset.kind === 'reminder' ? 0 : width(noticeFields.title) + width(noticeFields.artist) + gap(song);
    const padding = parseFloat(getComputedStyle(notice).paddingLeft) || 0;
    const required = Math.ceil(Math.max(headerWidth,footerWidth,songWidth,width(noticeFields.detail)) + padding + 3);
    const unit = Math.min(innerWidth*.017,innerHeight*.03022226);
    const available = bar.clientWidth - 2*(parseFloat(getComputedStyle(bar).paddingLeft)||0) - unit*.8;
    const maximum = Math.min(available*.62, available-unit*18);
    if (available > 0 && required > padding + 3) {
      const target = Math.max(0,Math.min(required,maximum));
      if (Math.abs((parseFloat(bar.style.getPropertyValue('--obs-notice-width'))||0)-target) > .5) bar.style.setProperty('--obs-notice-width',target+'px');
    }
  }
  function matchOriginalNoticeHeight() {
    // Measure a full original achievement card offscreen. This locks the bar
    // to its existing broadcast height, independent of reminder/song text.
    const reference = notice.cloneNode(true), unit = Math.min(innerWidth*.017,innerHeight*.03022226);
    const old = {};
    for (const key of ['headline','title','artist','detail','footer','badge']) old[key]=reference.querySelector('#vote-notice-'+key);
    reference.removeAttribute('id');
    reference.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));
    reference.style.cssText='--u:'+unit+'px;position:fixed;left:-10000px;top:0;visibility:hidden;display:block;width:max-content;max-width:'+27*unit+'px;padding:'+unit*.75+'px;border:1px solid transparent;font:500 '+unit*.86+'px/1.35 system-ui;box-sizing:border-box;pointer-events:none';
    reference.dataset.kind='rank';reference.dataset.rank='1';
    old.badge.style.cssText='flex:none;width:'+unit*2.65+'px;height:'+unit*3+'px';
    reference.querySelector('.vote-notice-content').style.width='auto';
    old.headline.textContent='A new crowd favorite!';
    old.headline.style.cssText='margin:0;font:750 '+unit*1.25+'px/1.16 system-ui;letter-spacing:-.025em;white-space:normal;padding:0;min-height:0';
    old.title.textContent='Murder At The Bingo Hall';old.title.style.cssText='font:650 '+unit*.85+'px/1.35 system-ui;padding:0;min-height:0;flex:0 1 auto;white-space:nowrap';
    old.artist.textContent='Amigo The Devil';old.artist.style.cssText='font:500 '+unit*.66+'px/1.35 system-ui;padding:0;min-height:0;flex:0 1 auto;max-width:40%';
    old.detail.textContent="Song #1 in today's event so far · 3 votes.";old.detail.style.cssText='margin:'+unit*.4+'px 0 0;font:500 '+unit*.81+'px/1.35 system-ui;padding:0;min-height:0;white-space:normal';
    old.footer.textContent='Cast your vote and add music at';old.footer.style.cssText='font:500 '+unit*.6+'px/1.35 system-ui;padding:0;min-height:0';
    const footer=reference.querySelector('.vote-notice-footer');
    footer.style.cssText='display:flex;align-items:baseline;flex-wrap:wrap;gap:'+unit*.3+'px;margin-top:'+unit*.35+'px;padding-top:'+unit*.3+'px;border-top:1px solid transparent';
    footer.querySelector('.vote-notice-url').style.cssText='font:750 '+unit*.86+'px/1.35 system-ui;letter-spacing:-.02em';
    document.body.appendChild(reference);const height=reference.getBoundingClientRect().height;reference.remove();
    if(height>unit*5&&height<unit*15)bar.style.height=(Math.round(height*.9*100)/100)+'px';
    const style=getComputedStyle(bar);
    const inside=bar.clientHeight-parseFloat(style.paddingTop||0)-parseFloat(style.paddingBottom||0);
    if(inside>0)bar.style.setProperty('--obs-cover-size',Math.min(unit*6.7,inside)+'px');
    fitNotification();
  }
  matchOriginalNoticeHeight();
  window.addEventListener('resize',matchOriginalNoticeHeight);
  const resize = new ResizeObserver(() => { fitNotification(); for (const element of texts.keys()) marquee(element); });
  for (const element of [...Object.values(fields),...Object.values(noticeFields)]) resize.observe(element);
  document.fonts?.ready.then(() => { fitNotification(); for (const element of texts.keys()) marquee(element); });
  function visibility() {
    clearTimeout(timer); clearInterval(clock); timer = clock = 0;
    if (!visible()) { controller?.abort(); for (const state of marquees.values()) state.animation?.pause(); return; }
    for (const state of marquees.values()) state.animation?.play();
    clock = setInterval(tick,100); poll();
  }
  window.addEventListener('obsSourceVisibleChanged', event => { if (typeof event.detail?.visible === 'boolean') obsVisible = event.detail.visible; visibility(); });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', () => { stopped = true; visibility(); resize.disconnect(); effects.forEach(effect => effect.cancel()); marquees.forEach(state => state.animation?.cancel()); });
  visibility();
})();
