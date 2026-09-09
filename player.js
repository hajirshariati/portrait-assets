/* Portrait Follow storefront player.
 * Blends AI-rendered head poses (one WebP per yaw/pitch cell) toward the visitor's pointer.
 * Keep this file byte-identical to the inline <script> in portrait-follow.liquid (test_app.py checks).
 *
 * Manifest contract (written by backend/app.py):
 *   width, height      source image pixel size
 *   source             relative URL of the source image
 *   yaw, pitch         ascending degree lists that index frames[row=pitch][col=yaw]
 *   yawSign, pitchSign +1/-1: direction the nose moves in image space per positive degree
 *                      (x right, y down). Missing => defaults measured on the first real job.
 *   faces[]            box [x,y,w,h] of the generated crop, face [x,y,w,h] of the detected face,
 *                      center [u,v] normalised face centre, frames[pitchIndex][yawIndex] file names
 */
(() => {
  if (customElements.get('portrait-follow')) return;
  const TAU = 140;           // ms time constant of the head easing
  const REVEAL_MS = 450;     // fade-in of the AI layer once its neutral frame arrives
  const TOUCH_IDLE_MS = 1600;// return to neutral this long after the last touch move
  const CONCURRENCY = 6;     // parallel frame downloads per face
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, fallback, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) ? clamp(n, lo, hi) : fallback; };
  const nearestIndex = (list, value) => list.reduce((best, v, i) => Math.abs(v - value) < Math.abs(list[best] - value) ? i : best, 0);
  // Returns [i, u]: value sits between list[i] and list[i+1] at fraction u (clamped to the list range).
  const locate = (list, value) => {
    if (list.length < 2) return [0, 0];
    const v = clamp(value, list[0], list[list.length - 1]);
    let i = 0; while (i < list.length - 2 && v > list[i + 1]) i++;
    return [i, (v - list[i]) / (list[i + 1] - list[i])];
  };
  const isDegrees = a => Array.isArray(a) && a.length >= 1 && a.length <= 15 && a.every((v, i) => Number.isFinite(v) && Math.abs(v) <= 45 && (i === 0 || v > a[i - 1]));
  const isRect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0;

  customElements.define('portrait-follow', class extends HTMLElement {
    connectedCallback() {
      if (this.control) return;
      this.canvas = this.querySelector('canvas');
      if (!this.canvas) return;
      this.control = new AbortController();
      const signal = this.signal = this.control.signal;
      this.context = this.canvas.getContext('2d');
      this.motion = matchMedia('(prefers-reduced-motion: reduce)');
      this.visible = true; this.point = null; this.faces = []; this.ready = false; this.frame = 0; this.last = undefined;
      if (!this.style.touchAction) this.style.touchAction = 'pan-y';
      this.addEventListener('pointerdown', e => this.move(e), { signal });
      document.addEventListener('pointermove', e => this.move(e), { signal, passive: true });
      document.addEventListener('pointerout', e => { if (!e.relatedTarget) this.rest(); }, { signal });
      document.addEventListener('pointercancel', e => { if (e.pointerType === 'touch') this.rest(TOUCH_IDLE_MS); }, { signal });
      document.addEventListener('scroll', () => { if (this.point) this.schedule(); }, { signal, passive: true, capture: true });
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); else this.schedule(); }, { signal });
      this.motion.addEventListener('change', () => { this.point = null; this.schedule(); }, { signal });
      this.observer = new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; if (this.visible) this.schedule(); else this.pause(); });
      this.observer.observe(this);
      this.loader = this.load();
    }

    disconnectedCallback() {
      this.control?.abort(); this.control = null;
      this.observer?.disconnect(); this.observer = null;
      cancelAnimationFrame(this.frame); this.frame = 0;
      clearTimeout(this.idle);
      this.faces = []; this.ready = false;
    }

    image(url) {
      return new Promise((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous'; i.decoding = 'async';
        i.onload = () => { const done = () => resolve(i); (i.decode ? i.decode() : Promise.resolve()).then(done, done); };
        i.onerror = () => reject(new Error('image failed: ' + url));
        i.src = url;
      });
    }

    validate(d) {
      const ok = d && Number.isInteger(d.width) && Number.isInteger(d.height) && d.width >= 1 && d.height >= 1 && d.width <= 4096 && d.height <= 4096
        && typeof d.source === 'string' && isDegrees(d.yaw) && isDegrees(d.pitch) && Array.isArray(d.faces) && d.faces.length >= 1 && d.faces.length <= 4
        && d.faces.every(f => isRect(f.box) && (f.face === undefined || isRect(f.face)) && Array.isArray(f.center) && f.center.length === 2 && f.center.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
          && Array.isArray(f.frames) && f.frames.length === d.pitch.length && f.frames.every(row => Array.isArray(row) && row.length === d.yaw.length && row.every(n => typeof n === 'string')));
      if (!ok) throw new Error('invalid manifest');
      const sign = (v, fallback) => (v === 1 || v === -1) ? v : fallback;
      // Defaults reflect the measured behaviour of fal-ai/live-portrait on the first real job:
      // +yaw turned the nose toward image -x, +pitch toward image +y (down).
      return { ...d, yawSign: sign(d.yawSign, -1), pitchSign: sign(d.pitchSign, 1) };
    }

    async load() {
      try {
        const src = this.dataset.manifest;
        if (!src) return;
        const url = new URL(src, location.href);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
        const response = await fetch(url, { signal: this.signal, mode: 'cors' });
        if (!response.ok) throw new Error('manifest ' + response.status);
        const d = this.manifest = this.validate(await response.json());
        this.base = await this.image(new URL(d.source, url));
        if (this.signal.aborted) return;
        this.canvas.width = d.width; this.canvas.height = d.height;
        this.fit(d);
        this.faces = d.faces.map(f => this.setupFace(f, d));
        this.ready = true; this.canvas.hidden = false; this.schedule();
        await Promise.all(this.faces.map(f => this.loadFace(f, url)));
      } catch (e) {
        if (!this.signal.aborted) this.fallback(e);
      }
    }

    // Lock the host to the prepared image's aspect ratio so the canvas can never be stretched,
    // even if the merchant picked a differently cropped copy of the photo.
    fit(d) {
      this.style.aspectRatio = d.width + ' / ' + d.height;
      const img = this.querySelector('img');
      if (img) { img.style.position = 'absolute'; img.style.inset = '0'; img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover'; }
    }

    setupFace(f, d) {
      const [bx, by, bw, bh] = f.box;
      const cx = f.center[0] * d.width, cy = f.center[1] * d.height;
      // Older manifests lack the face rectangle; the backend padded the crop to 2.5x the face.
      const [fx, fy, fw, fh] = f.face || [cx - bw / 5, cy - bh / 5, bw / 2.5, bh / 2.5];
      return {
        box: f.box, cx, cy, fx, fy, fw, fh, names: f.frames,
        frames: f.frames.map(row => row.map(() => null)),
        ni: nearestIndex(d.yaw, 0), nj: nearestIndex(d.pitch, 0),
        ring: -1, layer: null, mask: null, yaw: 0, pitch: 0, reveal: 0
      };
    }

    async loadFace(f, base) {
      const cells = [];
      f.names.forEach((row, r) => row.forEach((name, c) => cells.push({ r, c, name, ring: Math.max(Math.abs(r - f.nj), Math.abs(c - f.ni)), dist: Math.hypot(r - f.nj, c - f.ni) })));
      cells.sort((a, b) => a.ring - b.ring || a.dist - b.dist);
      let next = 0;
      const worker = async () => {
        while (next < cells.length && !this.signal.aborted) {
          const cell = cells[next++];
          const img = await this.image(new URL(cell.name, base));
          if (this.signal.aborted) return;
          if (img.naturalWidth < 64 || img.naturalWidth > 2048 || img.naturalHeight < 64 || img.naturalHeight > 2048) throw new Error('frame size');
          f.frames[cell.r][cell.c] = img;
          if (!f.layer) this.createLayer(f, img.naturalWidth, img.naturalHeight);
          this.updateRing(f);
          this.schedule();
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }

    // The largest Chebyshev ring around the neutral cell whose frames are all loaded.
    updateRing(f) {
      const rows = f.frames.length, cols = f.frames[0].length;
      let ring = -1;
      for (let k = 0; k <= Math.max(rows, cols); k++) {
        let complete = true;
        for (let r = Math.max(0, f.nj - k); r <= Math.min(rows - 1, f.nj + k) && complete; r++)
          for (let c = Math.max(0, f.ni - k); c <= Math.min(cols - 1, f.ni + k); c++) if (!f.frames[r][c]) { complete = false; break; }
        if (!complete) break;
        ring = k;
      }
      f.ring = ring;
    }

    createLayer(f, W, H) {
      f.layer = document.createElement('canvas'); f.layer.width = W; f.layer.height = H;
      f.mask = document.createElement('canvas'); f.mask.width = W; f.mask.height = H;
      const m = f.mask.getContext('2d');
      const sx = W / f.box[2], sy = H / f.box[3];
      // Face centre and size in layer pixels.
      const mx = (f.fx + f.fw / 2 - f.box[0]) * sx, my = (f.fy + f.fh / 2 - f.box[1]) * sy, fw = f.fw * sx, fh = f.fh * sy;
      // LivePortrait's paste-back already blends the head into the crop, so the mask only needs
      // to hide resampling differences: keep everything inside ~1x the face solid and feather to ~1.3x.
      const rx = 1.3 * fw, ry = 1.45 * fh;
      m.save(); m.translate(mx, my); m.scale(rx, ry);
      const g = m.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.72, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = g; m.fillRect(-mx / rx, -my / ry, W / rx, H / ry); m.restore();
      // Never let the crop's straight edges show: punch out a soft border.
      const e = Math.round(W * 0.06);
      m.globalCompositeOperation = 'destination-out';
      // [gradient x0,y0,x1,y1, strip x,y,w,h] for the left, right, top and bottom borders.
      const strips = [[0, 0, e, 0, 0, 0, e, H], [W, 0, W - e, 0, W - e, 0, e, H], [0, 0, 0, e, 0, 0, W, e], [0, H, 0, H - e, 0, H - e, W, e]];
      for (const [gx0, gy0, gx1, gy1, x, y, w, h] of strips) {
        const lg = m.createLinearGradient(gx0, gy0, gx1, gy1);
        lg.addColorStop(0, 'rgba(0,0,0,1)'); lg.addColorStop(1, 'rgba(0,0,0,0)');
        m.fillStyle = lg; m.fillRect(x, y, w, h);
      }
      m.globalCompositeOperation = 'source-over';
    }

    fallback(e) {
      this.ready = false; this.canvas.hidden = true; this.faces = [];
      if (this.dataset.debug !== undefined) console.warn('portrait-follow:', e);
    }

    move(e) {
      if (this.motion.matches) return;
      if (e.pointerType === 'touch' && !this.contains(e.target)) return;
      this.point = { x: e.clientX, y: e.clientY };
      clearTimeout(this.idle);
      if (e.pointerType === 'touch') this.idle = setTimeout(() => this.rest(), TOUCH_IDLE_MS);
      this.schedule();
    }

    rest(delay) {
      clearTimeout(this.idle);
      if (delay) this.idle = setTimeout(() => this.rest(), delay);
      else { this.point = null; this.schedule(); }
    }

    pause() { cancelAnimationFrame(this.frame); this.frame = 0; this.last = undefined; this.point = null; }

    schedule() {
      if (!this.frame && this.ready && this.visible && !document.hidden && !this.signal.aborted) this.frame = requestAnimationFrame(t => this.draw(t));
    }

    target(f, rect) {
      const d = this.manifest;
      const range = (list, n) => {
        const lo = Math.max(0, n - f.ring), hi = Math.min(list.length - 1, n + f.ring);
        return [list[lo], list[hi]];
      };
      const [yawLo, yawHi] = range(d.yaw, f.ni), [pitchLo, pitchHi] = range(d.pitch, f.nj);
      let yaw = 0, pitch = 0;
      const p = this.point;
      if (p && !this.motion.matches && rect.width >= 1) {
        // Look-at geometry: the head sits `reach` section-widths behind the screen; the pointer lies on the screen.
        const reach = num(this.dataset.reach, 0.6, 0.15, 3), intensity = num(this.dataset.intensity, 1, 0.1, 1);
        const flipX = this.dataset.flipX === 'true' ? -1 : 1, flipY = this.dataset.flipY === 'true' ? -1 : 1;
        const cx = rect.left + f.cx / d.width * rect.width, cy = rect.top + f.cy / d.height * rect.height;
        const D = reach * rect.width, norm = Math.atan(rect.width / 2 / D);
        const ax = clamp(Math.atan((p.x - cx) / D) / norm, -1, 1), ay = clamp(Math.atan((p.y - cy) / D) / norm, -1, 1);
        const yawSpan = Math.max(Math.abs(d.yaw[0]), Math.abs(d.yaw[d.yaw.length - 1])), pitchSpan = Math.max(Math.abs(d.pitch[0]), Math.abs(d.pitch[d.pitch.length - 1]));
        yaw = d.yawSign * flipX * ax * yawSpan * intensity;
        pitch = d.pitchSign * flipY * ay * pitchSpan * intensity;
      }
      return { yaw: clamp(yaw, yawLo, yawHi), pitch: clamp(pitch, pitchLo, pitchHi) };
    }

    composite(f) {
      const d = this.manifest, W = f.layer.width, H = f.layer.height, l = f.layer.getContext('2d');
      const [c, u] = locate(d.yaw, f.yaw), [r, v] = locate(d.pitch, f.pitch);
      l.clearRect(0, 0, W, H);
      // Weighted sum of the four surrounding stills; weights sum to 1, so 'lighter' on a cleared
      // layer is an exact bilinear interpolation of opaque frames.
      l.globalCompositeOperation = 'lighter';
      for (const [rr, cc, w] of [[r, c, (1 - u) * (1 - v)], [r, c + 1, u * (1 - v)], [r + 1, c, (1 - u) * v], [r + 1, c + 1, u * v]]) {
        if (w < 0.002) continue;
        const img = f.frames[Math.min(rr, f.frames.length - 1)][Math.min(cc, f.frames[0].length - 1)];
        if (!img) continue;
        l.globalAlpha = w; l.drawImage(img, 0, 0, W, H);
      }
      l.globalAlpha = 1;
      l.globalCompositeOperation = 'destination-in'; l.drawImage(f.mask, 0, 0);
      l.globalCompositeOperation = 'source-over';
    }

    draw(t) {
      this.frame = 0;
      if (!this.ready) return;
      const dt = clamp(t - (this.last ?? t), 0, 64); this.last = t;
      const ease = 1 - Math.exp(-dt / TAU);
      const d = this.manifest, ctx = this.context, rect = this.canvas.getBoundingClientRect();
      ctx.globalAlpha = 1; ctx.clearRect(0, 0, d.width, d.height); ctx.drawImage(this.base, 0, 0, d.width, d.height);
      let active = false;
      for (const f of this.faces) {
        if (!f.layer || f.ring < 0) continue;
        const target = this.target(f, rect);
        f.yaw += (target.yaw - f.yaw) * ease; f.pitch += (target.pitch - f.pitch) * ease;
        if (Math.abs(target.yaw - f.yaw) + Math.abs(target.pitch - f.pitch) > 0.01) active = true;
        else { f.yaw = target.yaw; f.pitch = target.pitch; }
        if (f.reveal < 1) { f.reveal = Math.min(1, f.reveal + dt / REVEAL_MS); active = true; }
        this.composite(f);
        // Always composite the AI layer at full strength: fading it against the original photo
        // is what produced the ghosted "shadow" look.
        ctx.globalAlpha = f.reveal; ctx.drawImage(f.layer, f.box[0], f.box[1], f.box[2], f.box[3]);
      }
      ctx.globalAlpha = 1;
      if (active) this.schedule(); else this.last = undefined;
    }
  });
})();
