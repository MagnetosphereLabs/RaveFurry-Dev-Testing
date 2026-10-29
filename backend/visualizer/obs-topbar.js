/* OBS-only metadata UI. The audio renderer and WebGL scene stay independent. */
(() => {
  'use strict';
  const bar = document.getElementById('obs-topbar');
  if (!bar) return;
  const notice = document.getElementById('vote-notice');
  const mascot = notice.querySelector('.vote-notice-character');
  const mascotSource = mascot?.getAttribute('src') || '';
  // Fill the PNG's transparent margins without changing its layout box/gaps.
  if (mascot) { mascot.style.transform = 'scale(1.5)'; mascot.style.transformOrigin = 'center'; }
  const songRoot = document.getElementById('obs-song');
  const art = document.getElementById('obs-artwork');
  const progress = document.getElementById('obs-progress-fill');
  const fields = Object.fromEntries(['title','artist','elapsed','duration','votes'].map(key => [key, document.getElementById('obs-song-' + key)]));
  const noticeFields = Object.fromEntries(['headline','title','artist','detail','footer'].map(key => [key, document.getElementById('vote-notice-' + key)]));
  const ordinal = document.getElementById('vote-notice-ordinal');
  const texts = new Map(), effects = new Set(), marquees = new Map(), nodeEffects = new WeakMap();
  const removals = new Map(), layouts = new Map(), textSlots = new Map(), animationSlots = new WeakMap();
  const coverSurfaces = [];
  let pendingCover = null, decodingCover = null;
  const easing = 'cubic-bezier(.22,1,.36,1)';
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity:'grapheme'}) : null;
  let snapshot = null, received = 0, songId = '', notificationId = '', coverId = '', coverGeneration = 0;
  let timer = 0, clock = 0, controller = null, stopped = false, obsVisible = true;
  let normalSuspended = false;
  const options = new URLSearchParams(location.search);
  const port = Number(options.get('port') || (location.protocol === 'http:' && ['127.0.0.1','localhost'].includes(location.hostname) ? location.port : 8766));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  const origin = 'http://127.0.0.1:' + port;
  const graphemes = text => segmenter ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
  const visible = () => !stopped && obsVisible && !document.hidden;
  function disposeAnimation(animation) {
    if (!animation) return;
    animation.onfinish = animation.oncancel = null;
    animation.cancel();
    // cancel() alone can leave a detached target reachable from the timeline.
    if (animation.effect) {
      animation.effect.target = null;
      animation.effect.setKeyframes?.([]);
    }
    animation.effect = null;
  }
  function startAnimation(node, frames, timing) {
    // Reuse the native animation/effect for this stable target. Cancellation
    // still detaches the target and empties its keyframes between transitions.
    const slot = animationSlots.get(node);
    if (slot) {
      slot.effect.target = node;
      slot.effect.setKeyframes(frames);
      slot.effect.updateTiming({delay:0,endDelay:0,iterations:1,iterationStart:0,direction:'normal',easing:'linear',fill:'none',...timing});
      slot.animation.effect = slot.effect;
      slot.animation.currentTime = 0;
      slot.animation.play();
      return slot.animation;
    }
    const animation = node.animate(frames,timing);
    if (animation.effect?.setKeyframes && animation.effect?.updateTiming) animationSlots.set(node,{animation,effect:animation.effect});
    return animation;
  }
  function removeNode(node) {
    for (const target of [node, ...node.querySelectorAll('*')]) {
      clearTimeout(removals.get(target)); removals.delete(target);
      nodeEffects.get(target)?.cancel();
      // Retired pool entries must not keep a blur/transform layer description
      // while waiting for reuse. Removal happens in this same JS turn.
      if (target.style) { target.style.transform = target.style.filter = 'none'; target.style.opacity = '1'; }
      if (target.tagName === 'IMG') target.removeAttribute('src');
      if (target.tagName === 'CANVAS') target.width = target.height = 0;
    }
    node.remove();
  }
  function removeLater(node, delay) {
    clearTimeout(removals.get(node));
    removals.set(node,setTimeout(() => removeNode(node),delay));
  }
  function animate(node, frames, timing) {
    if (!node.animate) return null;
    nodeEffects.get(node)?.cancel();
    const animation = startAnimation(node, frames, {...timing, fill:'both'});
    let deadline = 0, released = false;
    const record = {
      cancel() {
        if (released) return;
        released = true; clearTimeout(deadline); effects.delete(record);
        if (nodeEffects.get(node) === record) nodeEffects.delete(node);
        disposeAnimation(animation);
      },
      finish() {
        if (released) return;
        const last = frames[frames.length - 1];
        // Preserve the terminal opacity (including invisible outgoing digits),
        // but release identity transforms/filters once the entrance settles.
        for (const key of ['opacity','transform','filter']) {
          if (last[key] !== undefined) node.style[key] = last.opacity !== 0 && key === 'transform' ? 'none' : last.opacity !== 0 && key === 'filter' ? 'none' : last[key];
        }
        record.cancel();
      },
    };
    nodeEffects.set(node,record); effects.add(record);
    // A queued event from a canceled use must not finish/cancel its next use.
    animation.onfinish = () => { if (!animation.playState || animation.playState === 'finished') record.finish(); };
    animation.oncancel = () => { if (!animation.playState || animation.playState === 'idle') record.cancel(); };
    // Bound resource lifetime even if a renderer finish event never reaches
    // this handler, including interruption while an element is detached.
    deadline = setTimeout(record.finish,Number(timing.delay || 0)+Number(timing.duration || 0)+80);
    return animation;
  }
  function restingGlyph(node) {
    // Override the old HTML's permanent per-letter 3D promotion from this file.
    // Entrance effects still composite while moving, then return to normal text.
    node.style.transform = 'none'; node.style.backfaceVisibility = 'visible';
  }
  function textContent(element) {
    // Two stable label surfaces per field: current and outgoing. Recycle their
    // glyphs too, so each song/notice does not introduce new compositor targets.
    let slots = textSlots.get(element);
    if (!slots) { slots = []; textSlots.set(element,slots); }
    let content = slots.find(node => !node.isConnected);
    if (!content) { content = document.createElement('span'); slots.push(content); }
    content.className = 'obs-text-content'; content.setAttribute('aria-hidden','true');
    content.style.opacity = '1'; content.style.transform = content.style.filter = 'none';
    return content;
  }
  function digitGlyph(cell, letter) {
    // Keep two reusable digit faces, even during rapid clock corrections.
    cell.querySelectorAll('.obs-glyph-out').forEach(removeNode);
    const old = cell.firstElementChild;
    const faces = cell._obsFaces || (cell._obsFaces = old ? [old] : []);
    let next = faces.find(node => node !== old);
    if (!next) { next = document.createElement('span'); faces.push(next); }
    next.className = ''; next.textContent = letter;
    next.style.opacity = '1'; next.style.filter = 'none'; restingGlyph(next);
    cell.appendChild(next);
    return {old,next};
  }
  function marquee(element) {
    const state = texts.get(element);
    if (!state || state.digits || !state.content.isConnected) return;
    const width = element.clientWidth, distance = Math.max(0, state.content.scrollWidth - width);
    const prior = marquees.get(element);
    const unchanged = prior && prior.width === width && prior.distance === distance && prior.content === state.content;
    const canAnimate = visible() && getComputedStyle(element).visibility !== 'hidden';
    if (unchanged && (prior.animation || distance <= 1 || !canAnimate)) return;
    const resumeAt = unchanged ? prior.pausedAt : null;
    disposeAnimation(prior?.animation);
    let animation = null;
    // Same resting, travelling and returning rhythm as the embedded queue.
    if (canAnimate && width > 0 && distance > 1) {
      const rest = 2000, travel = Math.max(1000, distance / 30 * 1000), duration = 2 * (rest + travel);
      animation = startAnimation(state.content,[
        {transform:'translateX(0px)',offset:0},
        {transform:'translateX(0px)',offset:rest/duration,easing:'ease-in-out'},
        {transform:`translateX(${-distance}px)`,offset:(rest+travel)/duration},
        {transform:`translateX(${-distance}px)`,offset:(2*rest+travel)/duration,easing:'ease-in-out'},
        {transform:'translateX(0px)',offset:1},
      ], {duration, iterations:Infinity, delay:850});
      if (Number.isFinite(resumeAt)) animation.currentTime = resumeAt;
    }
    marquees.set(element, {width, distance, content:state.content, animation, pausedAt:resumeAt});
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
        // A correction can arrive before the previous digit's exit completes.
        // Prune that exit before selecting the actual current digit.
        const {old,next} = digitGlyph(cell,letter);
        if (old) {
          old.classList.add('obs-glyph-out');
          animate(old, [{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(-.28em) scale(.45)'}],{duration:190,easing});
          removeLater(old,210);
        }
        animate(next,[{opacity:0,transform:'translateY(.3em) scale(.5)'},{opacity:1,transform:'translateY(-.025em) scale(1.05)',offset:.78},{opacity:1,transform:'translate3d(0,0,0)'}],{duration:340,easing});
      });
      prior.text = text; return;
    }
    disposeAnimation(marquees.get(element)?.animation); marquees.delete(element);
    // Keep a single outgoing copy; quick changes cannot accumulate old labels.
    element.querySelectorAll(':scope > .obs-outgoing-text').forEach(removeNode);
    if (prior?.content.isConnected) {
      const old = prior.content; old.classList.add('obs-outgoing-text');
      animate(old,[{opacity:1,filter:'blur(0px)',transform:getComputedStyle(old).transform},{opacity:0,filter:'blur(5px)',transform:'translateY(-.18em) scale(.97)'}],{duration:280,easing});
      removeLater(old,300);
    }
    const content = textContent(element);
    const entering = [], reusable = [...content.children];
    graphemes(text).forEach((letter, index) => {
      const glyph = reusable[index] || document.createElement('span');
      glyph.className = digits ? 'obs-digit-cell' : 'obs-glyph'; glyph.style.display = '';
      if (digits) {
        glyph.dataset.letter = letter; if (letter === ':') glyph.classList.add('is-colon');
        // A retired label can have two digit faces left after interruption.
        for (const face of [...glyph.children]) removeNode(face);
        digitGlyph(glyph,letter);
      }
      else glyph.textContent = letter === ' ' ? '\u00a0' : letter;
      const target = digits ? glyph.firstElementChild : glyph;
      target.style.opacity = '1'; target.style.filter = 'none'; restingGlyph(target);
      content.appendChild(glyph); entering.push({glyph,target,index});
    });
    const active = new Set(entering.map(item => item.glyph));
    for (const glyph of reusable) if (!active.has(glyph)) { glyph.style.display = 'none'; glyph.textContent = ''; content.appendChild(glyph); }
    element.appendChild(content); texts.set(element,{text,content,digits});
    // Offscreen letters have already settled before their marquee reaches
    // them. Avoid allocating one animated GPU surface for every hidden letter.
    const width = element.clientWidth, first = content.firstElementChild?.offsetLeft || 0;
    if (getComputedStyle(element).visibility !== 'hidden') for (const {glyph,target,index} of entering) {
      if (!digits && (width > 0 ? glyph.offsetLeft - first > width + glyph.offsetWidth : index >= 64)) continue;
      animate(target,[
        {opacity:0,transform:'translate(.12em,.38em) rotate(-5deg) scale(.45)',filter:'blur(3px)'},
        {opacity:1,transform:'translate(0,-.025em) rotate(1deg) scale(1.045)',filter:'blur(0px)',offset:.78},
        {opacity:1,transform:'translate3d(0,0,0)',filter:'none'},
      ], {duration:450,delay:Math.min(index * (digits ? 25 : 16),560),easing});
    }
    clearTimeout(layouts.get(element));
    layouts.set(element,setTimeout(() => { layouts.delete(element); if (!stopped) marquee(element); },30));
  }
  function cancelCoverLoad() {
    const load = pendingCover;
    if (!load) return;
    pendingCover = null; ++coverGeneration;
    clearTimeout(load.timeout); load.abort.abort();
    // Native bitmap decoding cannot be aborted. Its owner stays alive only
    // until that ONE decode returns, then closes it even after hide/unload.
  }
  function paintBitmap(canvas, bitmap, width, height = width, contain = false) {
    const context = canvas.getContext('2d',{willReadFrequently:true});
    if (!context) throw new Error('Artwork canvas unavailable');
    canvas.width = width; canvas.height = height;
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    if (contain) {
      const scale = Math.min(width/bitmap.width,height/bitmap.height);
      context.drawImage(bitmap,(width-bitmap.width*scale)/2,(height-bitmap.height*scale)/2,bitmap.width*scale,bitmap.height*scale);
    } else {
      const side = Math.min(bitmap.width,bitmap.height);
      context.drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,width,height);
    }
    context.getImageData(0,0,1,1);
  }
  function coverSurface(bitmap) {
    let canvas = coverSurfaces.find(node => !node.isConnected);
    if (!canvas) {
      if (coverSurfaces.length === 2) throw new Error('Both cover surfaces are busy');
      canvas = document.createElement('canvas'); canvas.className = 'obs-cover';
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border-radius:inherit';
      coverSurfaces.push(canvas);
    }
    const unit = layoutUnit();
    const pixels = Math.min(1024,Math.max(64,Math.ceil((parseFloat(bar.style.getPropertyValue('--obs-cover-size')) || unit*6.7)*(window.devicePixelRatio || 1)*1.1)));
    // Draw once per cover into a display-sized backing store, with no frame
    // queue and no full-size HTML image retained for the current song.
    // Flush the draw before close(), rather than leaving source-image work
    // deferred. The small reusable canvas owns the displayed pixels.
    paintBitmap(canvas,bitmap,pixels);
    canvas.style.opacity = '1'; canvas.style.transform = canvas.style.filter = 'none';
    canvas.classList.remove('is-outgoing');
    return canvas;
  }
  async function artwork(path) {
    if (path === coverId) { cancelCoverLoad(); return; }
    if (pendingCover?.path === path) return;
    cancelCoverLoad();
    const ticket = ++coverGeneration;
    art.querySelectorAll('.is-outgoing').forEach(removeNode);
    if (!path) {
      coverId = ''; art.classList.add('is-empty');
      art.querySelectorAll('.obs-cover').forEach(node => {
        node.classList.add('is-outgoing');
        animate(node,[{opacity:1,transform:'scale(1)',filter:'blur(0px)'},{opacity:0,transform:'scale(.8) rotate(-3deg)',filter:'blur(8px)'}],{duration:450,easing});
        removeLater(node,470);
      });
      return;
    }
    if (!/^\/overlay-artwork\/[A-Za-z0-9_-]{11}$/.test(path) || decodingCover) return;
    const load = {path,abort:new AbortController(),timeout:0};
    pendingCover = load;
    load.timeout = setTimeout(() => { if (pendingCover === load) cancelCoverLoad(); },5000);
    let bitmap = null;
    try {
      const response = await fetch(origin + path,{cache:'no-store',credentials:'omit',signal:load.abort.signal});
      if (!response.ok) return;
      const blob = await response.blob();
      if (ticket !== coverGeneration || pendingCover !== load || !visible() || !blob.size || blob.size > 2*1024*1024) return;
      decodingCover = load;
      bitmap = await createImageBitmap(blob);
      if (ticket !== coverGeneration || pendingCover !== load || !visible()) return;
      art.querySelectorAll('.is-outgoing').forEach(removeNode);
      const canvas = coverSurface(bitmap);
      bitmap.close(); bitmap = null;
      const previous = art.querySelector('.obs-cover');
      if (previous) { previous.classList.add('is-outgoing'); animate(previous,[{opacity:1,transform:'scale(1)',filter:'blur(0px)'},{opacity:0,transform:'scale(.87) rotate(-4deg)',filter:'blur(8px)'}],{duration:500,easing}); removeLater(previous,520); }
      art.appendChild(canvas); coverId = path; art.classList.remove('is-empty');
      animate(canvas,[{opacity:0,transform:'translateY(8%) scale(.88) rotate(3deg)',filter:'blur(8px)'},{opacity:1,transform:'translateY(0) scale(1.025) rotate(-.5deg)',filter:'blur(0px)',offset:.8},{opacity:1,transform:'translateY(0) scale(1) rotate(0)',filter:'blur(0px)'}],{duration:650,easing});
    } catch (_) { /* Keep the current cover and retry on the next snapshot. */ }
    finally {
      bitmap?.close();
      for (const surface of coverSurfaces) if (!surface.isConnected) removeNode(surface);
      clearTimeout(load.timeout);
      if (decodingCover === load) decodingCover = null;
      if (pendingCover === load) pendingCover = null;
      const canceled = load.abort.signal.aborted; load.abort.abort();
      // Coalesce changes during a slow decode to the latest song, never queue
      // several uncancelable decodes. A failed current cover retries next poll.
      if (visible() && snapshot && (canceled || snapshot.song?.artwork !== path)) artwork(snapshot.song?.artwork || '');
    }
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
    if (!visible() || !snapshot || normalSuspended || window.FuraticOBSPresentation?.active) return;
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
    if (window.FuraticOBSPresentation?.receive(value) || normalSuspended) return;
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
    const unit = layoutUnit();
    const available = bar.clientWidth - 2*(parseFloat(getComputedStyle(bar).paddingLeft)||0) - unit*.8;
    const maximum = Math.min(available*.62, available-unit*18);
    if (available > 0 && required > padding + 3) {
      const target = Math.max(0,Math.min(required,maximum));
      if (Math.abs((parseFloat(bar.style.getPropertyValue('--obs-notice-width'))||0)-target) > .5) bar.style.setProperty('--obs-notice-width',target+'px');
    }
    // Place the artist immediately after a short title. When both labels are
    // long, share the row instead of reserving empty title space or capping
    // every artist at 42%, even when the remaining row is mostly empty.
    const row = Math.max(0,song.clientWidth-gap(song));
    const titleWidth = Math.min(width(noticeFields.title),Math.max(row*.6,row-width(noticeFields.artist)));
    const basis = Math.max(0,Math.min(row,titleWidth));
    if (Math.abs((parseFloat(song.style.getPropertyValue('--obs-notice-title-width'))||0)-basis) > .5)
      song.style.setProperty('--obs-notice-title-width',basis+'px');
  }
  let videoLayout = false;
  function layoutUnit() { return Math.min(innerWidth*.017,innerHeight*.03022226)*(videoLayout?.77:1); }
  function matchOriginalNoticeHeight() {
    // Measure a full original achievement card offscreen. This locks the bar
    // to its existing broadcast height, independent of reminder/song text.
    const reference = notice.cloneNode(true), unit = layoutUnit();
    bar.style.setProperty('--u',unit+'px');
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
  document.fonts?.ready.then(() => { if(stopped)return; fitNotification(); for (const element of texts.keys()) marquee(element); });
  function visibility() {
    clearTimeout(timer); clearInterval(clock); timer = clock = 0;
    if (!visible()) {
      for (const timeout of layouts.values()) clearTimeout(timeout);
      layouts.clear();
      controller?.abort(); cancelCoverLoad();
      for (const effect of [...effects]) effect.finish();
      for (const node of [...removals.keys()]) removeNode(node);
      for (const state of marquees.values()) {
        if (state.animation) state.pausedAt = Number(state.animation.currentTime) || 0;
        disposeAnimation(state.animation); state.animation = null;
      }
      return;
    }
    for (const element of texts.keys()) marquee(element);
    clock = setInterval(tick,100); poll();
  }
  const sourceVisibility = event => { if (typeof event.detail?.visible === 'boolean') obsVisible = event.detail.visible; visibility(); };
  function releaseText(element) {
    clearTimeout(layouts.get(element)); layouts.delete(element);
    disposeAnimation(marquees.get(element)?.animation); marquees.delete(element);
    for (const content of textSlots.get(element) || []) removeNode(content);
    textSlots.delete(element); texts.delete(element); resize.unobserve?.(element);
  }
  window.FuraticOBSUI = {
    setVideoLayout(value) {
      value=Boolean(value);if(value===videoLayout)return;
      const before=bar.getBoundingClientRect().height;videoLayout=value;matchOriginalNoticeHeight();
      const after=bar.getBoundingClientRect().height;
      if(!normalSuspended&&before>0&&after>0){bar.style.transformOrigin='top center';animate(bar,[{transform:'scaleY('+before/after+')',filter:'blur(1.5px)'},{transform:'none',filter:'none'}],{duration:550,easing});}
      for(const element of texts.keys())marquee(element);
    },
    text(element,value,digits=false) { resize.observe(element); typeText(element,value,digits); },
    label(element,value) {
      // Recycled chart rows enter as a group. One text surface per label keeps
      // their shared marquee without creating hundreds of glyph animations.
      const text=String(value??'');if(texts.get(element)?.text===text)return;
      resize.observe(element);element.setAttribute('aria-label',text);
      disposeAnimation(marquees.get(element)?.animation);marquees.delete(element);
      for(const node of [...element.children])removeNode(node);
      const content=textContent(element);content.textContent=text;element.appendChild(content);
      texts.set(element,{text,content,digits:false});
      clearTimeout(layouts.get(element));
      layouts.set(element,setTimeout(()=>{layouts.delete(element);if(!stopped)marquee(element);},30));
    },
    animate, paint:paintBitmap, remove:removeNode, release:releaseText,
    get snapshot() { return snapshot; },
    suspend() {
      normalSuspended = true; bar.hidden = true; cancelCoverLoad();
      bar.style.transform = bar.style.filter = 'none'; bar.style.opacity = '1';
      mascot?.removeAttribute('src');
      for (const element of [...Object.values(fields),...Object.values(noticeFields)]) releaseText(element);
      for (const canvas of coverSurfaces) removeNode(canvas);
      coverSurfaces.length = 0; coverId = songId = notificationId = '';
    },
    resume() {
      normalSuspended = false;
      for (const element of [...Object.values(fields),...Object.values(noticeFields)]) resize.observe(element);
      if (mascot && mascotSource) mascot.setAttribute('src',mascotSource);
      bar.hidden = false; if (snapshot && !stopped) receive(snapshot);
    },
  };
  window.addEventListener('obsSourceVisibleChanged', sourceVisibility);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', () => {
    stopped = true; visibility(); resize.disconnect();
    window.removeEventListener('resize',matchOriginalNoticeHeight);
    window.removeEventListener('obsSourceVisibleChanged',sourceVisibility);
    document.removeEventListener('visibilitychange',visibility);
    for (const effect of [...effects]) effect.cancel();
    for (const state of marquees.values()) disposeAnimation(state.animation);
    for (const canvas of coverSurfaces) removeNode(canvas);
    for (const slots of textSlots.values()) for (const content of slots) removeNode(content);
    coverSurfaces.length = 0; textSlots.clear();
    if (mascot) removeNode(mascot);
    effects.clear(); marquees.clear(); texts.clear(); snapshot = null;
    delete window.FuraticOBSUI;
  });
  window.FuraticOBSStartPresentation?.();
  visibility();
})();

