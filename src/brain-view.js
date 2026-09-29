// WebGL2 point-cloud renderer: every neuron of the brain, glowing when it spikes.

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aCls;
layout(location=2) in float aAct;
layout(location=3) in float aFlag;
uniform mat4 uMVP;
uniform float uSize;
uniform vec3 uPalette[12];
uniform float uFocus;
out vec4 vCol;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  int c = int(aCls + 0.5);
  vec3 base = uPalette[c];
  float a = aAct;
  float flag = aFlag;
  vec3 hot = mix(base * 1.6 + 0.25, vec3(1.0, 0.98, 0.9), clamp(a * 1.2 - 0.2, 0.0, 1.0));
  float dimBase = uFocus > 0.5 ? 0.03 : 0.11;
  vec3 col = mix(base * dimBase, hot, clamp(a, 0.0, 1.0));
  float size = uSize * (1.0 + a * 2.6);
  if (flag > 0.5 && flag < 1.5) { col = mix(col, vec3(0.35, 1.0, 0.55), 0.55); size *= 1.8; }      // driven
  else if (flag > 1.5 && flag < 2.5) { col = vec3(0.9, 0.18, 0.22) * 0.5; size *= 1.5; }         // silenced
  else if (flag > 2.5) { col = mix(col, vec3(1.0, 0.8, 0.25), 0.8); size *= 2.4; }                // selected
  gl_PointSize = size / max(gl_Position.w, 0.2);
  vCol = vec4(col, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float fall = exp(-r * 14.0);
  o = vec4(vCol.rgb * fall, 1.0);
}`;

// super-class palette (index matches order passed in)
export const CLASS_COLORS = {
  unknown: [0.5, 0.5, 0.5], optic: [0.45, 0.35, 1.0], central: [0.2, 0.85, 0.85],
  sensory: [1.0, 0.65, 0.2], visual_projection: [0.75, 0.4, 1.0], ascending: [0.4, 0.95, 0.5],
  descending: [1.0, 0.35, 0.45], sensory_ascending: [1.0, 0.8, 0.3], visual_centrifugal: [0.55, 0.55, 1.0],
  motor: [1.0, 0.25, 0.25], endocrine: [1.0, 0.5, 0.85],
};

function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function view(yaw, pitch, dist, pan) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // rotation Ry(yaw) then Rx(pitch), then translate
  const r = new Float32Array([
    cy, sy * sp, -sy * cp, 0,
    0, cp, sp, 0,
    sy, -cy * sp, cy * cp, 0,
    pan[0], pan[1], -dist, 1,
  ]);
  return r;
}

export class BrainView {
  constructor(canvas, neurons) {
    this.canvas = canvas;
    this.neurons = neurons;
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const N = neurons.N;
    this.N = N;

    // positions: FlyWire x (lateral), y (ventral), z (posterior) in 0.1 µm -> ~unit cube
    const pos = new Float32Array(N * 3);
    const S = 1 / 4200;
    for (let i = 0; i < N; i++) {
      pos[i * 3] = neurons.pos[i * 3] * S;
      pos[i * 3 + 1] = -neurons.pos[i * 3 + 1] * S;
      pos[i * 3 + 2] = -neurons.pos[i * 3 + 2] * S * 1.0;
    }
    this.pos = pos;
    const cls = new Float32Array(N);
    const names = neurons.meta.superClasses;
    for (let i = 0; i < N; i++) cls[i] = neurons.superClass[i];
    this.act = new Float32Array(N);
    this.flag = new Float32Array(N);

    const prog = this._program(VS, FS);
    this.prog = prog;
    this.u = {
      mvp: gl.getUniformLocation(prog, 'uMVP'), size: gl.getUniformLocation(prog, 'uSize'),
      pal: gl.getUniformLocation(prog, 'uPalette'), focus: gl.getUniformLocation(prog, 'uFocus'),
    };
    const pal = new Float32Array(36);
    names.forEach((n, j) => { const c = CLASS_COLORS[n] || CLASS_COLORS.unknown; pal.set(c, j * 3); });
    gl.useProgram(prog);
    gl.uniform3fv(this.u.pal, pal);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = (data, loc, size, usage = gl.STATIC_DRAW) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    buf(pos, 0, 3); buf(cls, 1, 1);
    this.actBuf = buf(this.act, 2, 1, gl.DYNAMIC_DRAW);
    this.flagBuf = buf(this.flag, 3, 1, gl.DYNAMIC_DRAW);

    this.cam = { yaw: 0.3, pitch: 0.22, dist: 2.35, pan: [0, 0] };
    this.autoRotate = true;
    this.focus = false;
    this.lastInteract = 0;
    this._bindControls();
    this.onPick = null;
    this.selected = -1;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  _bindControls() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, btn: e.button, shift: e.shiftKey };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.btn === 2 || drag.shift) {
        this.cam.pan[0] += dx * 0.0025 * this.cam.dist / 3; this.cam.pan[1] -= dy * 0.0025 * this.cam.dist / 3;
      } else {
        this.cam.yaw += dx * 0.006; this.cam.pitch = Math.max(-1.5, Math.min(1.5, this.cam.pitch + dy * 0.006));
      }
      this.lastInteract = performance.now();
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) this.pick(e);
      drag = null;
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.max(0.8, Math.min(8, this.cam.dist * Math.exp(e.deltaY * 0.001)));
      this.lastInteract = performance.now();
    }, { passive: false });
  }

  mvp() {
    const w = this.canvas.width, h = this.canvas.height;
    const P = perspective(0.75, w / h, 0.05, 50);
    return mat4Mul(P, view(this.cam.yaw, this.cam.pitch, this.cam.dist, this.cam.pan));
  }

  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * 2 - 1, my = -((e.clientY - r.top) / r.height * 2 - 1);
    const M = this.mvp(), p = this.pos;
    let best = -1, bestScore = Infinity;
    const tol = 10 / r.width * 2;
    for (let i = 0; i < this.N; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= 0) continue;
      const cx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw;
      const cy = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
      const d = Math.hypot(cx - mx, cy - my);
      if (d > tol) continue;
      const score = d - this.act[i] * tol * 0.8 + cw * 0.002;   // prefer active & near
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (this.onPick) this.onPick(best);
  }

  spikes(list, n) { const a = this.act; for (let s = 0; s < n; s++) a[list[s]] = 1; }

  setFlags(driven, silenced) {
    this.flag.fill(0);
    for (const i of silenced) this.flag[i] = 2;
    for (const i of driven) this.flag[i] = 1;
    if (this.selected >= 0) this.flag[this.selected] = 3;
    this._flagsDirty = true;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }

  draw(dtMs) {
    const gl = this.gl;
    this.resize();
    if (this.autoRotate && performance.now() - this.lastInteract > 4000) this.cam.yaw += dtMs * 0.00008;
    const k = Math.exp(-dtMs / 180), a = this.act;
    for (let i = 0; i < a.length; i++) if (a[i] > 0.004) a[i] *= k; else a[i] = 0;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.016, 0.02, 0.035, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.actBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, a);
    if (this._flagsDirty) { gl.bindBuffer(gl.ARRAY_BUFFER, this.flagBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.flag); this._flagsDirty = false; }
    gl.uniformMatrix4fv(this.u.mvp, false, this.mvp());
    gl.uniform1f(this.u.size, 3.2 * this.dpr * (this.canvas.height / 900 + 0.35));
    gl.uniform1f(this.u.focus, this.focus ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, this.N);
  }
}
