/** The desktop preview keeps real links and native touch/keyboard scrolling.
 * Wheel targets are accumulated so rapid input never restarts an easing curve.
 */
export class PreviewScroller {
  private active = false;
  private frame = 0;
  private paintFrame = 0;
  private settleTimer = 0;
  private target = 0;
  private previousTime = 0;
  private position = 0;
  private stride = 0;
  private items: HTMLElement[] = [];
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private preview: HTMLElement, private up?: HTMLButtonElement, private down?: HTMLButtonElement) {
    preview.addEventListener('wheel', event => this.wheel(event), {passive: false});
    preview.addEventListener('scroll', () => {
      if (!this.active) return;
      if (!this.frame) this.target = preview.scrollTop;
      if (!this.paintFrame) this.paintFrame = requestAnimationFrame(() => { this.paintFrame = 0; this.paint(); });
    }, {passive: true});
    preview.addEventListener('pointerdown', () => this.stop());
    preview.addEventListener('keydown', event => {
      if (!this.active || event.altKey || event.ctrlKey || event.metaKey) return;
      const destinations = {ArrowDown: this.target + this.stride, ArrowUp: this.target - this.stride,
        PageDown: this.target + this.page(), PageUp: this.target - this.page(), Home: 0, End: this.maximum()};
      if (!(event.key in destinations)) return;
      event.preventDefault();
      this.move(destinations[event.key]);
    });
    preview.addEventListener('focusin', event => {
      if (!this.active) return;
      const tile = (event.target as HTMLElement).closest<HTMLElement>('.auto-queue-thumbnail');
      if (!tile) return;
      this.stop();
      if (tile.offsetTop < preview.scrollTop || tile.offsetTop + tile.offsetHeight > preview.scrollTop + preview.clientHeight) {
        this.move(tile.offsetTop);
      }
    });
    up?.addEventListener('click', () => this.move(this.target - this.stride));
    down?.addEventListener('click', () => this.move(this.target + this.stride));
  }

  private maximum() { return Math.max(0, this.preview.scrollHeight - this.preview.clientHeight); }
  private page() { return Math.max(1, Math.floor(this.preview.clientHeight / this.stride) - 1) * this.stride; }
  private clamp(value: number) { return Math.max(0, Math.min(this.maximum(), value)); }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    window.clearTimeout(this.settleTimer);
    this.target = this.preview.scrollTop;
  }

  layout(active: boolean) {
    this.items = Array.from(this.preview.querySelectorAll<HTMLElement>('.auto-queue-thumbnail'));
    this.active = active;
    if (!active) {
      this.stop();
      this.preview.scrollTop = 0;
      this.preview.removeAttribute('tabindex');
      this.items.forEach(item => { item.style.transform = ''; item.style.transformOrigin = ''; item.style.opacity = ''; });
      if (this.up) this.up.hidden = true;
      if (this.down) this.down.hidden = true;
      return;
    }
    this.stride = this.items.length > 1 ? this.items[1].offsetTop - this.items[0].offsetTop :
      (this.items[0]?.offsetHeight || 0) + (parseFloat(getComputedStyle(this.preview).rowGap) || 0);
    if (this.maximum() > 1) this.preview.tabIndex = 0; else this.preview.removeAttribute('tabindex');
    this.target = this.clamp(this.frame ? this.target : this.preview.scrollTop);
    this.paint();
  }

  private wheel(event: WheelEvent) {
    if (!this.active || !this.stride || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return;
    const delta = event.deltaY;
    const amount = event.deltaMode === 2 ? Math.sign(delta) * this.page() :
      event.deltaMode === 1 ? Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 3)) * this.stride :
      Math.abs(delta) >= 40 ? Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 100)) * this.stride : delta;
    const next = this.clamp(this.target + amount);
    if (Math.abs(next - this.target) < .1) return;
    event.preventDefault();
    this.move(next);
    // Fine trackpad input moves continuously, then settles onto a whole tile.
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      const snapped = this.target > this.maximum() - this.stride / 2 ? this.maximum() :
        Math.round(this.target / this.stride) * this.stride;
      this.move(snapped);
    }, 140);
  }

  private move(destination: number) {
    if (!this.active) return;
    this.target = this.clamp(destination);
    if (this.reduced.matches) {
      this.stop();
      this.preview.scrollTop = this.clamp(destination);
      this.target = this.preview.scrollTop;
      this.paint();
      return;
    }
    if (this.frame) return;
    this.position = this.preview.scrollTop;
    this.previousTime = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(50, Math.max(0, now - this.previousTime));
      this.previousTime = now;
      const distance = this.target - this.position;
      this.position = Math.abs(distance) < .4 ? this.target : this.position + distance * (1 - Math.exp(-elapsed / 65));
      this.preview.scrollTop = this.position;
      this.paint();
      if (Math.abs(this.target - this.position) < .4) {
        this.preview.scrollTop = this.target;
        this.frame = 0;
      } else this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private paint() {
    if (!this.active) return;
    const height = this.preview.clientHeight;
    const scroll = Math.max(0, this.preview.scrollTop);
    const more = scroll < this.maximum() - 1;
    let cue = height - 24;
    this.items.forEach(item => {
      const size = item.offsetHeight;
      if (!size) return;
      const top = item.offsetTop - scroll;
      const visible = Math.max(0, Math.min(1, top < 0 ? (top + size) / size : more ? (height - top) / size : 1));
      const scale = this.reduced.matches ? 1 : Math.max(.25, visible);
      item.style.transformOrigin = top < 0 ? '50% 100%' : '50% 0%';
      item.style.transform = `scale(${scale})`;
      item.style.opacity = String(visible);
      if (top >= 0 && top < height && visible < 1) cue = Math.min(height - 14, top + size * scale / 2);
    });
    if (this.up) {
      this.up.hidden = scroll <= 1;
      this.up.style.top = this.preview.offsetTop + 14 + 'px';
    }
    if (this.down) {
      this.down.hidden = !more;
      this.down.style.top = this.preview.offsetTop + cue + 'px';
    }
  }
}
