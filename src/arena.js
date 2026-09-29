// The fly's world: a top-down arena, a procedurally drawn body, sensors and a motor decoder.
// Nothing here decides *what* the fly does — it only turns world events into sensory
// neuron firing rates, and descending/motor neuron firing rates into body movement.

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const MOTOR_GAIN = {
  // body kinematics per Hz of descending-neuron firing (hand-tuned: the ventral nerve cord
  // and the leg motor system are not part of the brain connectome)
  forwardPerHz: 0.22,       // mm/s per Hz of mean P9 (DNp09) rate — ipsilateral turning per Bidaye et al. 2020
  backPerHz: 0.35,          // mm/s per Hz of MDN (moonwalker) rate — Bidaye et al. 2014
  turnDNa02: 0.055,         // rad/s per Hz of DNa02 R–L difference — ipsilateral steering, Rayshubskiy 2020 / Yang 2024
  turnP9: 0.03,             // rad/s per Hz of P9 R–L difference
};

export class Arena {
  /** canvas: optional 2D canvas (fallback view). The 3D view (arena3d.js) drives input via pointerDown/Move/Up. */
  constructor(canvas = null) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.R = 24;                          // arena radius, mm
    this.fly = { x: 0, y: 3, th: -Math.PI / 2, gait: 0, feed: 0, groom: 0, fly: 0, flyFrom: null, flyTo: null, wings: 0, speed: 0, omega: 0 };
    this.drops = [];
    this.threat = null;                   // { x, y, size, holding }
    this.puffs = [];                      // { x, y, side, until }
    this.tool = 'sugar';
    this.motor = {};                      // smoothed rates (Hz)
    this.simT = 0;
    this.events = [];
    this.onEvent = null;
    this.trail = [];
    // "6-7" meme gesture — a scripted easter egg, NOT produced by the connectome (see README)
    this.six = { active: false, t: 0, dur: 4000, next: 6000 };
    this.sixAuto = true;
    if (canvas) this._bind();
    this.addDrop(-7, -6, 'sugar'); this.addDrop(8, -9, 'bitter'); this.addDrop(6, 8, 'water');
  }

  addDrop(x, y, kind) {
    this.drops.push({ x, y, kind, r: kind === 'sugar' ? 2.2 : 1.9, amount: 1 });
    if (this.drops.length > 14) this.drops.shift();
  }

  // ---------------------------------------------------------------- input
  _toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = this.scale / (this.dpr || 1);
    return { x: (e.clientX - r.left - r.width / 2) / s, y: (e.clientY - r.top - r.height / 2) / s };
  }
  /** Tool action at world point p (mm). */
  pointerDown(p) {
    if (Math.hypot(p.x, p.y) > this.R) return;
    const t = this.tool;
    if (t === 'sugar' || t === 'bitter' || t === 'water') this.addDrop(p.x, p.y, t);
    else if (t === 'threat') this.threat = { x: p.x, y: p.y, size: 0, holding: true };
    else if (t === 'puff') this.puffAt(p.x, p.y);
    else if (t === 'erase') this.drops = this.drops.filter((d) => Math.hypot(d.x - p.x, d.y - p.y) > d.r + 1);
  }
  pointerMove(p) { if (this.threat && this.threat.holding) Object.assign(this.threat, { x: p.x, y: p.y }); }
  pointerUp() { if (this.threat) this.threat.holding = false; }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); this.pointerDown(this._toWorld(e)); });
    c.addEventListener('pointermove', (e) => this.pointerMove(this._toWorld(e)));
    const up = () => this.pointerUp();
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  }
  puffAt(x, y) {
    const f = this.fly;
    const rx = -Math.sin(f.th), ry = Math.cos(f.th);
    const side = (x - f.x) * rx + (y - f.y) * ry > 0 ? 'R' : 'L';
    this.puffs.push({ x, y, side, until: this.simT + 400, t0: this.simT });
  }
  /** Programmatic looming stimulus from one side of the fly. */
  loomFrom(side) {
    const f = this.fly, d = 7;
    const a = f.th + (side === 'L' ? -Math.PI / 2 : Math.PI / 2);
    this.threat = { x: f.x + Math.cos(a) * d, y: f.y + Math.sin(a) * d, size: 0, holding: true, auto: this.simT + 900 };
  }
  touchAntenna(side) {
    const f = this.fly;
    const a = f.th + (side === 'L' ? -0.9 : 0.9);
    this.puffAt(f.x + Math.cos(a) * 3, f.y + Math.sin(a) * 3);
  }
  placeFoodAhead(kind) {
    const f = this.fly;
    this.addDrop(f.x + Math.cos(f.th) * 1.6, f.y + Math.sin(f.th) * 1.6, kind);
  }

  /** Start the 6-7 gesture now (ignored while flying). */
  sixSeven() {
    if (this.fly.fly > 0 || this.six.active) return;
    Object.assign(this.six, { active: true, t: 0 });
  }
  /** 0..1 envelope of the 6-7 gesture. */
  get sixEnv() {
    const s = this.six;
    if (!s.active) return 0;
    return Math.min(smooth(s.t, 0, 300), 1 - smooth(s.t, s.dur - 350, s.dur));
  }

  // ---------------------------------------------------------------- sensors
  /** Returns Hz per sensor group, computed from the current world state. */
  sense() {
    const f = this.fly, out = { sugar: 0, bitter: 0, water: 0, joL: 0, joR: 0, loomL: 0, loomR: 0 };
    if (f.fly > 0) return out;
    const hx = f.x + Math.cos(f.th) * 1.5, hy = f.y + Math.sin(f.th) * 1.5;
    for (const d of this.drops) {
      if (d.amount <= 0.02) continue;
      if (Math.hypot(d.x - hx, d.y - hy) < d.r * Math.sqrt(d.amount) + 0.4) {
        out[d.kind] = Math.max(out[d.kind], d.kind === 'sugar' ? 110 : d.kind === 'bitter' ? 160 : 150);
      }
    }
    for (const p of this.puffs) if (this.simT < p.until) out['jo' + p.side] = 160;
    const t = this.threat;
    if (t && t.size > 0.02) {
      const dx = t.x - f.x, dy = t.y - f.y;
      const rx = -Math.sin(f.th), ry = Math.cos(f.th);
      const fwd = (dx * Math.cos(f.th) + dy * Math.sin(f.th)), lat = dx * rx + dy * ry;
      const ang = Math.atan2(lat, fwd);                 // + = right side of the fly
      const growing = t.holding ? 1 : 0.15;
      const hz = clamp(25 + 110 * t.size, 0, 135) * growing;
      if (Math.abs(ang) < 0.3) { out.loomL = hz; out.loomR = hz; }
      else if (ang > 0) out.loomR = hz; else out.loomL = hz;
    }
    return out;
  }

  // ---------------------------------------------------------------- motor decoding + physics
  update(dtSim, motorHz) {
    const dt = dtSim / 1000;             // s
    if (dt <= 0) return;
    this.simT += dtSim;
    const f = this.fly, m = this.motor;
    const k = 1 - Math.exp(-dtSim / 80);
    for (const key in motorHz) m[key] = (m[key] || 0) + (motorHz[key] - (m[key] || 0)) * k;

    // threat grows while held
    const t = this.threat;
    if (t) {
      if (t.auto && this.simT > t.auto) t.holding = false;
      t.size = t.holding ? Math.min(1, t.size + dt / 0.7) : t.size - dt / 0.35;
      if (!t.holding && t.size <= 0) this.threat = null;
    }
    this.puffs = this.puffs.filter((p) => this.simT < p.until + 600);

    // flight (after a Giant Fiber escape)
    if (f.fly > 0) {
      f.fly = Math.max(0, f.fly - dt / 0.9);
      const u = 1 - f.fly, e = u * u * (3 - 2 * u);
      f.x = f.flyFrom.x + (f.flyTo.x - f.flyFrom.x) * e;
      f.y = f.flyFrom.y + (f.flyTo.y - f.flyFrom.y) * e;
      f.wings = 1;
      if (f.fly === 0) { f.th = f.flyTo.th; this._event('landed'); }
      return;
    }
    f.wings = Math.max(0, f.wings - dt * 3);

    const six = this.six;
    if (six.active) {
      six.t += dtSim;
      // turns to face the middle of the arena (the "audience") before performing
      if (Math.hypot(f.x, f.y) > 4) {
        const want = Math.atan2(-f.y, -f.x);
        let d = ((want - f.th + Math.PI) % TAU + TAU) % TAU - Math.PI;
        f.th += d * Math.min(1, dt * 5);
      }
      if (six.t >= six.dur) { six.active = false; six.next = this.simT + 14000 + Math.random() * 10000; }
    } else if (this.sixAuto && this.simT >= six.next) {
      if (f.feed < 0.2 && f.groom < 0.2 && !this.threat) this.sixSeven(); else six.next = this.simT + 3000;
    }
    const env6 = this.sixEnv;

    const feedT = smooth(m.mn9 || 0, 8, 45);
    const groomT = smooth(m.groom || 0, 3, 16);
    f.feed += (feedT - f.feed) * Math.min(1, dt * 8);
    f.groom += (groomT - f.groom) * Math.min(1, dt * 6);

    if ((m.gf || 0) > 35 && this.simT - (this._lastEscape || -1e9) > 1500) {
      this._lastEscape = this.simT;
      const away = this.threat ? Math.atan2(f.y - this.threat.y, f.x - this.threat.x) : f.th + Math.PI;
      const dist = 10 + Math.random() * 6;
      let tx = f.x + Math.cos(away) * dist, ty = f.y + Math.sin(away) * dist;
      const r = Math.hypot(tx, ty); if (r > this.R - 3) { tx *= (this.R - 3) / r; ty *= (this.R - 3) / r; }
      f.flyFrom = { x: f.x, y: f.y }; f.flyTo = { x: tx, y: ty, th: away + (Math.random() - 0.5) };
      f.fly = 1; f.feed = 0; f.groom = 0; this.six.active = false;
      this._event('escape');
      return;
    }

    const p9 = ((m.walkL || 0) + (m.walkR || 0)) / 2;
    let v = MOTOR_GAIN.forwardPerHz * p9 - MOTOR_GAIN.backPerHz * (m.back || 0);
    const busy = Math.max(f.feed, f.groom);
    v *= 1 - 0.9 * busy;
    let w = MOTOR_GAIN.turnDNa02 * ((m.turnR || 0) - (m.turnL || 0)) + MOTOR_GAIN.turnP9 * ((m.walkR || 0) - (m.walkL || 0));
    w *= 1 - 0.7 * busy;
    v *= 1 - env6; w *= 1 - env6;          // stands still for the gesture
    f.speed = v; f.omega = w;
    f.th += w * dt;
    f.x += Math.cos(f.th) * v * dt; f.y += Math.sin(f.th) * v * dt;
    const r = Math.hypot(f.x, f.y), lim = this.R - 1.6;
    if (r > lim) { f.x *= lim / r; f.y *= lim / r; }
    f.gait += Math.abs(v) * dt * 2.2 + Math.abs(w) * dt * 1.5;

    // eating depletes sugar/water drops
    if (f.feed > 0.5) {
      const hx = f.x + Math.cos(f.th) * 1.5, hy = f.y + Math.sin(f.th) * 1.5;
      for (const d of this.drops) if (d.kind !== 'bitter' && Math.hypot(d.x - hx, d.y - hy) < d.r * Math.sqrt(d.amount) + 0.4) d.amount = Math.max(0, d.amount - dt * 0.05);
      this.drops = this.drops.filter((d) => d.amount > 0.02);
    }
    if (this.trail.length === 0 || Math.hypot(this.trail[this.trail.length - 1].x - f.x, this.trail[this.trail.length - 1].y - f.y) > 0.5) {
      this.trail.push({ x: f.x, y: f.y }); if (this.trail.length > 300) this.trail.shift();
    }
    const state = env6 > 0.5 ? 'six seven' : f.feed > 0.5 ? 'feeding' : f.groom > 0.5 ? 'grooming' : Math.abs(v) > 0.8 ? (v > 0 ? 'walking' : 'backing up') : 'resting';
    if (state !== this.state) { this.state = state; this._event(state); }
  }
  _event(name) { if (this.onEvent) this.onEvent(name, this.simT); }

  // ---------------------------------------------------------------- drawing
  draw(nowMs) {
    const c = this.canvas, ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.dpr = dpr;
    const s = (this.scale = Math.min(w, h) / (this.R * 2 + 3));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2); ctx.scale(s, s);

    // floor
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, this.R);
    g.addColorStop(0, '#1a1f2b'); g.addColorStop(1, '#10131b');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, this.R, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 0.08;
    for (let gx = -this.R; gx <= this.R; gx += 4) { ctx.beginPath(); ctx.moveTo(gx, -this.R); ctx.lineTo(gx, this.R); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-this.R, gx); ctx.lineTo(this.R, gx); ctx.stroke(); }
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, this.R, 0, TAU); ctx.lineWidth = 0.35; ctx.strokeStyle = 'rgba(160,200,255,0.18)'; ctx.stroke(); ctx.restore();
    ctx.globalCompositeOperation = 'destination-in'; ctx.beginPath(); ctx.arc(0, 0, this.R + 0.2, 0, TAU); ctx.fill(); ctx.globalCompositeOperation = 'source-over';

    // trail
    if (this.trail.length > 1) {
      ctx.lineWidth = 0.18; ctx.lineCap = 'round';
      for (let i = 1; i < this.trail.length; i++) {
        ctx.strokeStyle = `rgba(120,220,210,${(i / this.trail.length) * 0.25})`;
        ctx.beginPath(); ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y); ctx.lineTo(this.trail[i].x, this.trail[i].y); ctx.stroke();
      }
    }

    // drops
    const COL = { sugar: ['#ffd166', 'rgba(255,209,102,0.25)'], bitter: ['#c77dff', 'rgba(199,125,255,0.22)'], water: ['#4cc9f0', 'rgba(76,201,240,0.22)'] };
    for (const d of this.drops) {
      const r = d.r * Math.sqrt(d.amount);
      const [c1, c2] = COL[d.kind];
      ctx.fillStyle = c2; ctx.beginPath(); ctx.arc(d.x, d.y, r + 0.6, 0, TAU); ctx.fill();
      const gg = ctx.createRadialGradient(d.x - r * 0.35, d.y - r * 0.35, r * 0.1, d.x, d.y, r);
      gg.addColorStop(0, '#fff'); gg.addColorStop(0.25, c1); gg.addColorStop(1, c1 + '88');
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, TAU); ctx.fill();
    }

    // air puffs
    for (const p of this.puffs) {
      const u = clamp((this.simT - p.t0) / 700, 0, 1);
      ctx.strokeStyle = `rgba(200,230,255,${0.6 * (1 - u)})`; ctx.lineWidth = 0.2;
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(p.x, p.y, 0.8 + u * 5 + k * 0.9, 0, TAU); ctx.stroke(); }
    }

    this._drawFly(ctx, nowMs);
    const e6 = this.sixEnv;
    if (e6 > 0) this._drawSixLabels(ctx, nowMs, e6);

    // looming object (shadow of an approaching hand/predator)
    const t = this.threat;
    if (t && t.size > 0) {
      const rr = 1 + t.size * 7;
      const gg = ctx.createRadialGradient(t.x, t.y, rr * 0.2, t.x, t.y, rr);
      gg.addColorStop(0, `rgba(0,0,0,${0.85 * t.size})`); gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(t.x, t.y, rr, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgba(255,90,90,${0.5 * t.size})`; ctx.lineWidth = 0.15; ctx.beginPath(); ctx.arc(t.x, t.y, rr * 0.75, 0, TAU); ctx.stroke();
    }
    if (e6 > 0) this._drawSixCloseUp(ctx, nowMs, e6);
  }

  // "6" and "7" bobbing over the fly in the arena
  _drawSixLabels(ctx, nowMs, e) {
    const f = this.fly, a = Math.sin(nowMs * 0.012);
    ctx.save();
    ctx.globalAlpha = e;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 2.4px "Space Grotesk", system-ui, sans-serif';
    ctx.shadowColor = 'rgba(255,209,102,0.8)'; ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffd166';
    ctx.fillText('6', f.x - 1.9, f.y - 3.4 - a * 0.7);
    ctx.fillText('7', f.x + 1.9, f.y - 3.4 + a * 0.7);
    ctx.restore();
  }

  // front-view close-up of the fly doing the 6-7 hands, drawn in screen space
  _drawSixCloseUp(ctx, nowMs, e) {
    const c = this.canvas, dpr = this.dpr || 1;
    const H = c.height * 0.6, W = H * 1.08;
    const pad = 10 * dpr, x0 = pad, y0 = pad;
    const u = H / 10, cx = x0 + W / 2, cy = y0 + H * 0.52;
    const ph = nowMs * 0.012;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = e;
    const pop = 0.9 + 0.1 * e;
    ctx.translate(x0 + W / 2, y0 + H / 2); ctx.scale(pop, pop); ctx.translate(-(x0 + W / 2), -(y0 + H / 2));
    // card
    ctx.fillStyle = 'rgba(9,12,20,0.93)'; ctx.strokeStyle = 'rgba(255,209,102,0.55)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.roundRect(x0, y0, W, H, 12 * dpr); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.roundRect(x0, y0, W, H, 12 * dpr); ctx.clip();
    const glow = ctx.createRadialGradient(cx, cy, u, cx, cy, H * 0.7);
    glow.addColorStop(0, 'rgba(255,209,102,0.10)'); glow.addColorStop(1, 'rgba(255,209,102,0)');
    ctx.fillStyle = glow; ctx.fillRect(x0, y0, W, H);
    // floor
    ctx.strokeStyle = 'rgba(160,200,255,0.18)'; ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(x0, cy + 3.8 * u); ctx.lineTo(x0 + W, cy + 3.8 * u); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(cx, cy + 3.8 * u, 3 * u, 0.35 * u, 0, 0, TAU); ctx.fill();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const leg = (pts, wdt, col = '#2b2a2f') => {
      ctx.strokeStyle = col; ctx.lineWidth = wdt;
      ctx.beginPath(); ctx.moveTo(cx + pts[0][0] * u, cy + pts[0][1] * u);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(cx + pts[i][0] * u, cy + pts[i][1] * u);
      ctx.stroke();
    };
    const bob = Math.sin(ph * 2) * 0.06;
    // wings (behind)
    for (const sd of [-1, 1]) {
      ctx.save(); ctx.translate(cx + sd * 1.6 * u, cy + (-0.2 + bob) * u); ctx.rotate(sd * -0.45);
      ctx.fillStyle = 'rgba(210,225,255,0.16)'; ctx.strokeStyle = 'rgba(210,225,255,0.4)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.ellipse(sd * 1.1 * u, -0.3 * u, 1.9 * u, 0.62 * u, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    // middle + hind legs on the ground
    for (const sd of [-1, 1]) {
      leg([[sd * 1.0, 1.3 + bob], [sd * 2.5, 1.5], [sd * 3.3, 3.8]], 0.26 * u);
      leg([[sd * 0.7, 1.7 + bob], [sd * 1.7, 2.6], [sd * 2.1, 3.8]], 0.24 * u);
    }
    // thorax
    const th = ctx.createRadialGradient(cx - 0.4 * u, cy + 0.4 * u, 0.2 * u, cx, cy + 0.9 * u, 1.6 * u);
    th.addColorStop(0, '#c49a62'); th.addColorStop(1, '#7a5a34');
    ctx.fillStyle = th; ctx.beginPath(); ctx.ellipse(cx, cy + (0.9 + bob) * u, 1.3 * u, 1.5 * u, 0, 0, TAU); ctx.fill();
    // front legs: palms up, pumping alternately (the 6-7 hands)
    const hands = [];
    for (const sd of [-1, 1]) {
      const a = Math.sin(ph + (sd < 0 ? 0 : Math.PI));
      const hy = -0.9 - a * 1.05;
      hands.push({ sd, a, x: sd * 3.0, y: hy });
      const pts = [[sd * 0.95, 0.35 + bob], [sd * 2.35, 1.0 + a * 0.2], [sd * 2.95, hy + 0.45], [sd * 3.0, hy]];
      leg(pts, 0.42 * u, '#15141a');                       // outline
      leg(pts, 0.3 * u, '#6b5a48');                        // lighter front legs so they read on the wings
      // palm: tarsus turned flat and up
      ctx.strokeStyle = '#15141a'; ctx.lineWidth = 0.4 * u;
      ctx.beginPath(); ctx.moveTo(cx + (sd * 3.0 - 0.6) * u, cy + hy * u); ctx.lineTo(cx + (sd * 3.0 + 0.6) * u, cy + (hy - 0.05) * u); ctx.stroke();
      ctx.strokeStyle = '#8a7358'; ctx.lineWidth = 0.28 * u; ctx.stroke();
      ctx.fillStyle = '#e8cc9c';
      for (const k of [-0.6, 0, 0.6]) { ctx.beginPath(); ctx.arc(cx + (sd * 3.0 + k) * u, cy + (hy - 0.12) * u, 0.17 * u, 0, TAU); ctx.fill(); }
    }
    // head
    const hy0 = -1.35 + bob;
    ctx.fillStyle = '#8c6a40'; ctx.beginPath(); ctx.ellipse(cx, cy + hy0 * u, 1.45 * u, 1.15 * u, 0, 0, TAU); ctx.fill();
    for (const sd of [-1, 1]) {
      const ex = cx + sd * 0.98 * u, ey = cy + (hy0 - 0.1) * u;
      const eg = ctx.createRadialGradient(ex - sd * 0.2 * u, ey - 0.35 * u, 0.05 * u, ex, ey, 0.95 * u);
      eg.addColorStop(0, '#ff8a8a'); eg.addColorStop(0.45, '#d42a2a'); eg.addColorStop(1, '#6e1010');
      ctx.fillStyle = eg; ctx.beginPath(); ctx.ellipse(ex, ey, 0.72 * u, 0.95 * u, sd * 0.15, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.ellipse(ex - sd * 0.25 * u, ey - 0.4 * u, 0.16 * u, 0.1 * u, 0, 0, TAU); ctx.fill();
      // antenna
      ctx.strokeStyle = '#d7b98a'; ctx.lineWidth = 0.14 * u;
      ctx.beginPath(); ctx.moveTo(cx + sd * 0.22 * u, cy + (hy0 - 0.75) * u); ctx.lineTo(cx + sd * 0.42 * u, cy + (hy0 - 0.15) * u); ctx.stroke();
      ctx.lineWidth = 0.05 * u; ctx.beginPath(); ctx.moveTo(cx + sd * 0.42 * u, cy + (hy0 - 0.15) * u); ctx.lineTo(cx + sd * 0.95 * u, cy + (hy0 - 0.55) * u); ctx.stroke();
    }
    // proboscis
    ctx.strokeStyle = '#c9a27a'; ctx.lineWidth = 0.22 * u;
    ctx.beginPath(); ctx.moveTo(cx, cy + (hy0 + 0.6) * u); ctx.lineTo(cx, cy + (hy0 + 1.05) * u); ctx.stroke();
    // numbers above the palms
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const hd of hands) {
      const up = Math.max(0, hd.a);
      ctx.font = `700 ${(1.35 + up * 0.35) * u}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillStyle = '#ffd166'; ctx.shadowColor = 'rgba(255,209,102,0.9)'; ctx.shadowBlur = 10 * dpr * (0.4 + up);
      ctx.fillText(hd.sd < 0 ? '6' : '7', cx + hd.x * u, cy + (hd.y - 1.05) * u);
    }
    ctx.shadowBlur = 0;
    ctx.font = `600 ${0.5 * u}px "JetBrains Mono", monospace`; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(231,236,245,0.55)';
    ctx.fillText('SIX SEVEN · close-up', x0 + 0.4 * u, y0 + 0.55 * u);
    ctx.restore();
    ctx.restore();
  }

  _drawFly(ctx, nowMs) {
    const f = this.fly;
    const lift = f.fly > 0 ? Math.sin((1 - f.fly) * Math.PI) : 0;
    const S = 1.25 * (1 + lift * 0.6);
    // shadow
    ctx.save(); ctx.translate(f.x + lift * 2.5, f.y + lift * 3.5); ctx.rotate(f.th); ctx.scale(S, S);
    ctx.fillStyle = `rgba(0,0,0,${0.35 - lift * 0.2})`; ctx.beginPath(); ctx.ellipse(0, 0, 2.2, 1.1, 0, 0, TAU); ctx.fill();
    ctx.restore();

    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.th); ctx.scale(S, S);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const legC = '#2b2a2f';
    // legs: tripod gait
    const ph = f.gait * 3;
    const legs = [[0.55, 0.45, 1.5, 0.9], [0.05, 0.55, 0.1, 1.6], [-0.45, 0.45, -1.2, 1.35]];
    ctx.strokeStyle = legC; ctx.lineWidth = 0.14;
    for (let side = -1; side <= 1; side += 2) {
      legs.forEach(([bx, by, fx, fy], j) => {
        const phase = ((j % 2 === 0) === (side > 0) ? 0 : Math.PI);
        let sw = Math.sin(ph + phase) * 0.35;
        let tx = fx + sw, ty = fy;
        if (j === 0 && f.groom > 0.05) {          // front legs sweep over the head/antennae
          const gph = Math.sin(nowMs * 0.03 + (side > 0 ? 0 : 1.3));
          tx = fx * (1 - f.groom) + (1.35 + gph * 0.25) * f.groom;
          ty = fy * (1 - f.groom) + (0.25 + gph * 0.12) * f.groom;
        }
        const e6 = this.sixEnv;
        if (j === 0 && e6 > 0) {                   // 6-7: front legs raised forward, pumping alternately
          const a = Math.sin(nowMs * 0.012 + (side > 0 ? 0 : Math.PI));
          tx = tx * (1 - e6) + (2.05 + a * 0.45) * e6;
          ty = ty * (1 - e6) + (0.8 - a * 0.1) * e6;
        }
        if (f.fly > 0) { tx = bx - 0.2; ty = by + 0.35; }
        ctx.beginPath(); ctx.moveTo(bx, by * side); ctx.quadraticCurveTo((bx + tx) / 2 + 0.1, (by + ty) / 2 * side + 0.25 * side, tx, ty * side); ctx.stroke();
      });
    }
    // wings
    const spread = 0.28 + f.wings * 0.9 + (f.fly > 0 ? Math.sin(nowMs * 0.35) * 0.4 : 0);
    for (let side = -1; side <= 1; side += 2) {
      ctx.save(); ctx.translate(0.15, 0.12 * side); ctx.rotate(Math.PI + spread * side * -1);
      ctx.fillStyle = 'rgba(210,225,255,0.22)'; ctx.strokeStyle = 'rgba(210,225,255,0.45)'; ctx.lineWidth = 0.05;
      ctx.beginPath(); ctx.ellipse(1.2, 0, 1.25, 0.42, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.1, 0); ctx.lineTo(2.2, 0.05); ctx.stroke();
      ctx.restore();
    }
    // abdomen
    const ab = ctx.createLinearGradient(-1.9, 0, -0.2, 0); ab.addColorStop(0, '#6b4a2b'); ab.addColorStop(1, '#b8874f');
    ctx.fillStyle = ab; ctx.beginPath(); ctx.ellipse(-1.05, 0, 0.95, 0.62, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(40,25,15,0.8)'; ctx.lineWidth = 0.12;
    for (const sx of [-1.5, -1.15, -0.8]) { ctx.beginPath(); ctx.moveTo(sx, -0.52); ctx.quadraticCurveTo(sx - 0.08, 0, sx, 0.52); ctx.stroke(); }
    // thorax
    ctx.fillStyle = '#9a7646'; ctx.beginPath(); ctx.ellipse(0.35, 0, 0.62, 0.52, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.ellipse(0.45, -0.12, 0.3, 0.18, 0, 0, TAU); ctx.fill();
    // proboscis
    if (f.feed > 0.02) {
      ctx.strokeStyle = '#c9a27a'; ctx.lineWidth = 0.16;
      const L = 0.3 + f.feed * (0.75 + Math.sin(nowMs * 0.02) * 0.08);
      ctx.beginPath(); ctx.moveTo(1.2, 0); ctx.lineTo(1.2 + L, 0); ctx.stroke();
      ctx.fillStyle = '#e6c49c'; ctx.beginPath(); ctx.arc(1.2 + L, 0, 0.13, 0, TAU); ctx.fill();
    }
    // head + eyes
    ctx.fillStyle = '#8c6a40'; ctx.beginPath(); ctx.ellipse(1.1, 0, 0.36, 0.48, 0, 0, TAU); ctx.fill();
    for (const side of [-1, 1]) {
      const eg = ctx.createRadialGradient(1.08, 0.3 * side, 0.02, 1.08, 0.3 * side, 0.3);
      eg.addColorStop(0, '#ff6b6b'); eg.addColorStop(1, '#8e1b1b');
      ctx.fillStyle = eg; ctx.beginPath(); ctx.ellipse(1.07, 0.3 * side, 0.26, 0.24, 0, 0, TAU); ctx.fill();
    }
    // antennae
    ctx.strokeStyle = '#d7b98a'; ctx.lineWidth = 0.08;
    for (const side of [-1, 1]) {
      const p = this.puffs.find((q) => q.side === (side < 0 ? 'L' : 'R') && this.simT < q.until);
      const wig = p ? Math.sin(nowMs * 0.08) * 0.12 : 0;
      ctx.beginPath(); ctx.moveTo(1.38, 0.1 * side); ctx.lineTo(1.62, (0.2 + wig) * side); ctx.stroke();
    }
    ctx.restore();
  }
}
