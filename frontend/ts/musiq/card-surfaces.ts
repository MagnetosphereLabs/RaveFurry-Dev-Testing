/** Opaque song surfaces follow the broad visualizer colors without GPU readback. */
type SurfaceScene = {clouds: number[], sizes: number[], thumps: number[], bass: number[],
  energy: number[], lights: number[], music: number[], aspect: number};
type Viewport = {x: number, y: number, width: number, height: number};
const pigments = [[0, 142, 248], [182, 72, 196], [213, 107, 12], [52, 217, 0]]
    .map(color => color.map(channel => Math.pow(channel / 255, 2.2)));
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** Low-frequency Gaussian color ownership mirrors the shader's broad volumes.
 * Fine noise is intentionally averaged out, as it would be beneath frosted glass. */
export function surfaceColor(scene: SurfaceScene, x: number, y: number): number[] {
  const scores: number[] = [], locals: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const offset = i * 4;
    const dx = (x - scene.clouds[offset]) * scene.aspect, dy = y - scene.clouds[offset + 1];
    const size = Math.max(.05, scene.sizes[i]);
    const lx = (dx * scene.clouds[offset + 2] + dy * scene.clouds[offset + 3]) / size;
    const ly = (-dx * scene.clouds[offset + 3] + dy * scene.clouds[offset + 2]) / size;
    const thump = clamp(scene.thumps[i]), groove = thump * .45;
    const swell = (1 + [.30, .20, .23, .16][i] * thump) * (i === 0 ? 1 + .05 * clamp(scene.bass[1]) : 1);
    scores.push(-3.8 * (Math.pow(lx / (.69 * (1 + .08 * groove) * swell), 2) +
      Math.pow(ly / (.53 * (1 - .04 * groove) * swell), 2)));
    locals.push([lx, ly]);
  }
  const peak = Math.max(...scores), weights = scores.map(score => Math.exp((score - peak) * .92));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const color = [.003, .008, .026];
  for (let i = 0; i < 4; i++) {
    const [lx, ly] = locals[i];
    const illumination = Math.exp(-Math.pow((lx + .05) / .70, 2) - Math.pow((ly - .02) / .43, 2));
    const light = ([.24, .24, .43, .29][i] * .52 + .065 + clamp(scene.energy[i]) * .09 +
      clamp(scene.lights[i]) * illumination * .55) * (1 - .18 * clamp(scene.music[0]));
    for (let channel = 0; channel < 3; channel++) color[channel] += pigments[i][channel] * light * weights[i] / total;
  }
  const minimum = Math.min(...color);
  for (let i = 0; i < 3; i++) color[i] = 1 - Math.exp(-Math.max(0, color[i] - minimum * .72) * .8);
  const luminance = color[0] * .2126 + color[1] * .7152 + color[2] * .0722;
  const rolloff = luminance < .10 ? luminance : .10 + .075 * (1 - Math.exp(-(luminance - .10) / .075));
  // Dense opaque tint keeps white text readable even under a bright accent.
  return color.map((channel, i) => Math.round(clamp(Math.pow(channel * rolloff / Math.max(.000001, luminance), 1 / 2.2) * 255 * .58 + [7, 10, 22][i] * .42, 0, 88)));
}

let latest: {scene: SurfaceScene, viewport: Viewport} | null = null;
let frame = 0, timer = 0, lastPaint = -Infinity, scrollingUntil = 0, disposed = false;
function paint() {
  frame = 0;
  if (!latest || document.hidden || disposed) return;
  lastPaint = performance.now();
  const {scene, viewport} = latest;
  // Read all rectangles first, then write colors; no alternating layout flushes.
  const updates: {row: HTMLElement, value: string}[] = [];
  const rows = document.querySelectorAll<HTMLElement>('#current-song, #song-queue > li, #history-song-queue > li, #auto-song-queue > li');
  const clips = new Map<Element, DOMRect>();
  rows.forEach(row => {
    const rect = row.getBoundingClientRect();
    if (!rect.width || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth || updates.length >= 32) return;
    const scroll = row.closest('.furatic-list-scroll');
    if (scroll) {
      if (!clips.has(scroll)) clips.set(scroll, scroll.getBoundingClientRect());
      const clip = clips.get(scroll);
      if (rect.bottom <= clip.top || rect.top >= clip.bottom) return;
    }
    const colors = [.15, .5, .85].map(position => surfaceColor(scene,
      viewport.x + clamp((rect.left + rect.width * position) / innerWidth) * viewport.width,
      1 - (viewport.y + clamp((rect.top + rect.height * .5) / innerHeight) * viewport.height)));
    const rgb = [0, 1, 2].map(i => Math.round(colors.reduce((sum, color) => sum + color[i], 0) / colors.length));
    updates.push({row, value: `rgb(${rgb.join(', ')})`});
  });
  updates.forEach(({row, value}) => {
    const duration = performance.now() < scrollingUntil ? '140ms' : '450ms';
    if (row.style.getPropertyValue('--furatic-card-tint-time') !== duration) row.style.setProperty('--furatic-card-tint-time', duration);
    if (row.style.getPropertyValue('--furatic-card-color') !== value) row.style.setProperty('--furatic-card-color', value);
  });
}
function schedule() {
  if (frame || timer || disposed || document.hidden || !latest) return;
  const wait = Math.max(0, 80 - (performance.now() - lastPaint));
  if (wait) timer = window.setTimeout(() => { timer = 0; frame = requestAnimationFrame(paint); }, wait);
  else frame = requestAnimationFrame(paint);
}
function scrolling() { scrollingUntil = performance.now() + 200; schedule(); }
function receive(event: MessageEvent) {
  if (window.parent === window || event.source !== window.parent || event.origin !== location.origin ||
      event.data?.type !== 'furatic:card-surface-scene') return;
  const {scene, viewport} = event.data;
  const lengths = {clouds: 16, sizes: 4, thumps: 4, bass: 2, energy: 4, lights: 4, music: 4};
  if (!scene || !viewport || !Number.isFinite(scene.aspect) || scene.aspect <= 0 || scene.aspect > 20 ||
      !Object.keys(lengths).every(key => Array.isArray(scene[key]) && scene[key].length === lengths[key] &&
        scene[key].every(value => Number.isFinite(value) && Math.abs(value) <= 100)) ||
      !['x', 'y', 'width', 'height'].every(key => Number.isFinite(viewport[key]) && Math.abs(viewport[key]) <= 10) ||
      viewport.width <= 0 || viewport.height <= 0) return;
  latest = {scene, viewport}; // Exactly one current scene; never retain a frame history.
  schedule();
}
function pause() { cancelAnimationFrame(frame); clearTimeout(timer); frame = timer = 0; }
function visibility() { if (document.hidden) pause(); else schedule(); }
function pageHide(event: PageTransitionEvent) {
  pause();
  if (event.persisted) return;
  disposed = true; latest = null;
  window.removeEventListener('message', receive);
  window.removeEventListener('resize', schedule);
  window.removeEventListener('pageshow', schedule);
  window.removeEventListener('pagehide', pageHide);
  document.removeEventListener('scroll', scrolling, true);
  document.removeEventListener('visibilitychange', visibility);
}
window.addEventListener('message', receive);
window.addEventListener('resize', schedule, {passive: true});
window.addEventListener('pageshow', schedule);
window.addEventListener('pagehide', pageHide);
document.addEventListener('scroll', scrolling, {passive: true, capture: true});
document.addEventListener('visibilitychange', visibility);
