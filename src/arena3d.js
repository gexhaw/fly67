// 3D view of the arena (three.js). Pure rendering + input: all behaviour still comes from
// Arena (arena.js) — i.e. from the brain's motor/descending neuron rates.
//
// World mapping: arena (x, y) in mm → three (x, 0, y), Y is up. Fly local frame: +X forward,
// +Y up, +Z right side of the fly.
import * as THREE from './vendor/three.min.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * t; };

const DROP_COLORS = { sugar: 0xffc94d, bitter: 0xb46cff, water: 0x3fc2ee };

// ------------------------------------------------------------------ procedural textures
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const floorTex = () => canvasTex(1024, 1024, (x, w, h) => {
  const g = x.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
  g.addColorStop(0, '#222838'); g.addColorStop(1, '#141824');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(160,190,255,0.10)'; x.lineWidth = 2;
  for (let i = 0; i <= 24; i++) { const p = (i / 24) * w; x.beginPath(); x.moveTo(p, 0); x.lineTo(p, h); x.stroke(); x.beginPath(); x.moveTo(0, p); x.lineTo(w, p); x.stroke(); }
  x.strokeStyle = 'rgba(160,190,255,0.05)'; x.lineWidth = 1;
  for (let i = 0; i <= 96; i++) { const p = (i / 96) * w; x.beginPath(); x.moveTo(p, 0); x.lineTo(p, h); x.stroke(); x.beginPath(); x.moveTo(0, p); x.lineTo(w, p); x.stroke(); }
});
const stripeTex = () => canvasTex(256, 64, (x, w, h) => {
  x.fillStyle = '#b8874f'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 5; i++) { const p = w * (0.08 + i * 0.16); x.fillStyle = 'rgba(52,32,18,0.9)'; x.fillRect(p, 0, w * 0.07, h); }
  x.fillStyle = 'rgba(40,24,12,0.85)'; x.fillRect(0, 0, w * 0.06, h);
});
const eyeTex = () => canvasTex(256, 256, (x, w, h) => {
  x.fillStyle = '#a3171b'; x.fillRect(0, 0, w, h);
  const r = 5.2;
  for (let j = 0; j < h / (r * 1.6) + 1; j++) for (let i = 0; i < w / (r * 1.85) + 1; i++) {
    const cx = i * r * 1.85 + (j % 2) * r * 0.92, cy = j * r * 1.6;
    const g = x.createRadialGradient(cx - 1, cy - 1, 0.5, cx, cy, r);
    g.addColorStop(0, '#ff5a5a'); g.addColorStop(0.7, '#c9242a'); g.addColorStop(1, '#6a0c0f');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r * 0.95, 0, TAU); x.fill();
  }
});
const wingTex = () => canvasTex(512, 192, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  x.fillStyle = 'rgba(215,228,255,0.30)'; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(70,60,50,0.75)'; x.lineWidth = 3; x.lineCap = 'round';
  const veins = [[0.02, 0.5, 0.98, 0.42], [0.02, 0.5, 0.9, 0.75], [0.02, 0.5, 0.95, 0.2], [0.05, 0.5, 0.7, 0.9], [0.35, 0.45, 0.4, 0.78], [0.6, 0.3, 0.62, 0.62]];
  for (const [a, b, c, d] of veins) { x.beginPath(); x.moveTo(a * w, b * h); x.quadraticCurveTo((a + c) / 2 * w, (b + d) / 2 * h - 8, c * w, d * h); x.stroke(); }
});
const radialTex = (inner, outer) => canvasTex(256, 256, (x, w, h) => {
  const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
});
const digitTex = (d) => canvasTex(256, 256, (x, w, h) => {
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '800 200px "Space Grotesk", system-ui, sans-serif';
  x.shadowColor = 'rgba(255,190,60,0.95)'; x.shadowBlur = 28;
  x.fillStyle = '#ffd166'; x.fillText(d, w / 2, h / 2 + 8);
  x.shadowBlur = 0; x.lineWidth = 6; x.strokeStyle = 'rgba(80,50,0,0.6)'; x.strokeText(d, w / 2, h / 2 + 8);
  x.fillText(d, w / 2, h / 2 + 8);
});

// ------------------------------------------------------------------ fly model
const LEG_ATTACH = [[0.55, 0.62, 0.22], [0.28, 0.6, 0.28], [0.0, 0.62, 0.24]];   // front, mid, hind (x, y, |z|)
const LEG_YAW = [0.55, -0.05, -0.65];                                              // rest splay, + = forward
const LEN = { femur: 0.78, tibia: 0.84, tarsus: 0.6 };

function limb(len, radius, mat) {
  const g = new THREE.CylinderGeometry(radius * 0.8, radius, len, 10, 1);
  g.rotateZ(-Math.PI / 2); g.translate(len / 2, 0, 0);
  const m = new THREE.Mesh(g, mat); m.castShadow = true;
  return m;
}

class FlyModel {
  constructor() {
    const chitin = new THREE.MeshStandardMaterial({ color: 0x9a7646, roughness: 0.55, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2c2724, roughness: 0.65 });
    const abdomenMat = new THREE.MeshStandardMaterial({ map: stripeTex(), roughness: 0.5 });
    const eyeMat = new THREE.MeshStandardMaterial({ map: eyeTex(), roughness: 0.28, metalness: 0.05, emissive: 0x2a0303 });
    const wingMat = new THREE.MeshPhysicalMaterial({
      map: wingTex(), transparent: true, side: THREE.DoubleSide, depthWrite: false,
      roughness: 0.2, metalness: 0, iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [200, 600],
    });
    const sphere = (r, mat, s = [1, 1, 1], p = [0, 0, 0]) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), mat);
      m.scale.set(...s); m.position.set(...p); m.castShadow = true; return m;
    };

    this.root = new THREE.Group();          // world position + heading
    this.body = new THREE.Group();          // pitch (rearing) + bob
    this.root.add(this.body);
    this.body.add(sphere(0.55, chitin, [1.12, 0.92, 0.9], [0.3, 0.98, 0]));          // thorax
    const abd = sphere(0.62, abdomenMat, [1.45, 0.82, 0.95], [-0.88, 0.92, 0]); abd.rotation.z = 0.08;
    this.body.add(abd);
    this.head = new THREE.Group(); this.head.position.set(0.98, 1.08, 0); this.body.add(this.head);
    this.head.add(sphere(0.4, chitin, [0.75, 0.95, 1.1], [0.05, 0, 0]));
    for (const s of [-1, 1]) {
      const e = sphere(0.3, eyeMat, [0.85, 1.15, 0.78], [0.1, 0.02, s * 0.3]); e.rotation.y = s * 0.3; this.head.add(e);
      const ant = limb(0.22, 0.045, chitin); ant.position.set(0.28, 0.18, s * 0.09); ant.rotation.set(0, s * -0.45, 0.25); this.head.add(ant);
      const ar = limb(0.26, 0.01, dark); ar.position.set(0.22, 0, 0); ar.rotation.set(0, s * -0.3, 0.55); ant.add(ar);
    }
    // proboscis
    this.prob = new THREE.Group(); this.prob.position.set(0.2, -0.28, 0); this.head.add(this.prob);
    const pm = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.6 });
    this.probMesh = limb(1, 0.06, pm); this.prob.add(this.probMesh);
    this.probTip = sphere(0.08, pm, [0.8, 0.5, 1.5]); this.prob.add(this.probTip);

    // wings
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.bezierCurveTo(0.5, 0.42, 1.9, 0.48, 2.3, 0.12);
    shape.bezierCurveTo(2.45, -0.1, 1.8, -0.4, 0.9, -0.3); shape.bezierCurveTo(0.4, -0.22, 0.1, -0.1, 0, 0);
    const wg = new THREE.ShapeGeometry(shape, 24);
    const pos = wg.attributes.position, uv = wg.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 2.45, (pos.getY(i) + 0.45) / 0.95);
    wg.rotateX(-Math.PI / 2);
    this.wings = [];
    for (const s of [-1, 1]) {
      const base = new THREE.Group(); base.position.set(0.22, 1.36, s * 0.12);
      const flap = new THREE.Group(); base.add(flap);
      const m = new THREE.Mesh(wg, wingMat); m.scale.z = s; m.renderOrder = 2; flap.add(m);
      this.body.add(base); this.wings.push({ base, flap, s });
    }

    // legs: yaw group → femur → tibia → tarsus
    this.legs = [];
    for (let j = 0; j < 3; j++) for (const s of [-1, 1]) {
      const [ax, ay, az] = LEG_ATTACH[j];
      const yaw = new THREE.Group(); yaw.position.set(ax, ay, s * az); this.body.add(yaw);
      const femur = new THREE.Group(); yaw.add(femur); femur.add(limb(LEN.femur, 0.075, dark));
      const tibia = new THREE.Group(); tibia.position.x = LEN.femur; femur.add(tibia); tibia.add(limb(LEN.tibia, 0.055, dark));
      const tarsus = new THREE.Group(); tarsus.position.x = LEN.tibia; tibia.add(tarsus); tarsus.add(limb(LEN.tarsus, 0.035, dark));
      const tip = new THREE.Object3D(); tip.position.x = LEN.tarsus; tarsus.add(tip);
      this.legs.push({ j, s, yaw, femur, tibia, tarsus, tip });
    }
    // 6 and 7 above the palms
    this.digits = ['6', '7'].map((d) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: digitTex(d), transparent: true, depthTest: false }));
      sp.scale.set(1.25, 1.25, 1); sp.renderOrder = 10; sp.visible = false;
      return sp;
    });
  }

  /** pose from arena state; t = wall ms for cyclic motions */
  pose(f, env6, t) {
    const lift = f.fly > 0 ? Math.sin((1 - f.fly) * Math.PI) : 0;
    this.root.position.set(f.x, lift * 7, f.y);
    this.root.rotation.y = -f.th;
    const walk = Math.min(1, Math.abs(f.speed || 0) / 3);
    const ph = f.gait * 3;
    this.body.rotation.z = 0.42 * env6 + 0.08 * f.feed - 0.1 * lift;
    this.body.position.y = 0.18 * env6 + Math.sin(ph * 2) * 0.025 * walk;
    this.head.rotation.z = -0.25 * f.feed + 0.1 * env6;

    // proboscis extends while feeding (MN9)
    const pl = 0.18 + 0.7 * f.feed + (f.feed > 0.3 ? Math.sin(t * 0.02) * 0.05 : 0);
    this.probMesh.scale.set(pl, 1, 1); this.probTip.position.x = pl;
    this.prob.rotation.z = -1.25 - 0.25 * f.feed;

    // wings: folded over the abdomen; spread + flap in flight
    for (const w of this.wings) {
      const spread = 0.16 + f.wings * 1.15;
      w.base.rotation.y = w.s > 0 ? Math.PI + spread : Math.PI - spread;
      w.base.rotation.x = w.s * 0.12;
      w.flap.rotation.z = f.fly > 0 ? Math.sin(t * 0.45) * 0.9 : 0.06 + f.wings * 0.2;
    }

    for (const L of this.legs) {
      const { j, s } = L;
      let yaw = LEG_YAW[j], fem = 0.6, knee = 1.65, ank = 0.62;
      // tripod gait: L1 R2 L3 vs R1 L2 R3
      const tripod = (j % 2 === 0) === (s < 0) ? 0 : Math.PI;
      const sw = Math.sin(ph + tripod), up = Math.max(0, Math.cos(ph + tripod));
      yaw += 0.32 * sw * walk; fem += 0.28 * up * walk;
      if (j === 0 && f.groom > 0.02) {          // front legs rub the antennae
        const g = f.groom, r = Math.sin(t * 0.03 + (s > 0 ? 0 : 1.4));
        yaw = lerp(yaw, 1.25 + 0.15 * r, g); fem = lerp(fem, 1.05 + 0.12 * r, g); knee = lerp(knee, 2.2, g); ank = lerp(ank, 0.9, g);
      }
      if (j === 0 && env6 > 0) {                // six-seven: forearms up, palms flat, pumping alternately
        const a = Math.sin(t * 0.012 + (s < 0 ? 0 : Math.PI));
        const fem6 = 0.12 + 0.28 * a, knee6 = -0.9 - 0.3 * a;
        yaw = lerp(yaw, 1.3, env6); fem = lerp(fem, fem6, env6);
        knee = lerp(knee, knee6, env6); ank = lerp(ank, knee6 - fem6, env6);   // tarsus horizontal = "palm"
      }
      if (f.fly > 0) { fem = lerp(fem, 0.1, lift); knee = lerp(knee, 2.3, lift); ank = lerp(ank, 0.4, lift); }
      L.yaw.rotation.y = s > 0 ? -Math.PI / 2 + yaw : Math.PI / 2 - yaw;
      L.femur.rotation.z = fem; L.tibia.rotation.z = -knee; L.tarsus.rotation.z = ank;
    }
    // digits follow the palms
    // camera faces the fly during 6-7, so the fly's right hand is on the viewer's left → "6"
    const front = this.legs.filter((L) => L.j === 0).sort((a, b) => b.s - a.s);
    this.root.updateMatrixWorld(true);
    front.forEach((L, k) => {
      const d = this.digits[k], p = new THREE.Vector3();
      L.tip.getWorldPosition(p);
      d.visible = env6 > 0.02;
      d.position.set(p.x, p.y + 0.7, p.z);
      d.material.opacity = env6;
      const a = Math.sin(t * 0.012 + (L.s < 0 ? 0 : Math.PI));
      const sc = 1.15 + 0.3 * Math.max(0, a);
      d.scale.set(sc, sc, 1);
    });
  }
}

// ------------------------------------------------------------------ view
export class Arena3D {
  constructor(canvas, arena) {
    this.canvas = canvas; this.arena = arena;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.1;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = r;
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x0d111a);
    scene.fog = new THREE.Fog(0x0d111a, 60, 140);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);

    scene.add(new THREE.HemisphereLight(0xa9c1ff, 0x2a2018, 1.1));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff1dd, 2.2));
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);
    const rim = new THREE.DirectionalLight(0x6fe8d0, 0.6); rim.position.set(-30, 20, -25); scene.add(rim);
    this.fill = new THREE.DirectionalLight(0xffe6c8, 0.9); scene.add(this.fill, this.fill.target);   // key light from the camera

    const R = arena.R;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 128), new THREE.MeshStandardMaterial({ map: floorTex(), roughness: 0.92 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    this.floor = floor;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 1.6, 128, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    wall.position.y = 0.8; scene.add(wall);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(R, 0.08, 8, 160), new THREE.MeshBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.55 }));
    lip.rotation.x = Math.PI / 2; lip.position.y = 1.6; scene.add(lip);

    this.fly = new FlyModel();
    scene.add(this.fly.root, ...this.fly.digits);

    this.dropMeshes = new Map();
    this.dropGeo = new THREE.SphereGeometry(1, 40, 20, 0, TAU, 0, Math.PI / 2);
    this.glowTex = radialTex('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
    this.puffMeshes = new Map();

    // trail
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(300 * 3), 3));
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(300 * 3), 3));
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }));
    scene.add(this.trail);

    // looming object: a dark sphere dropping toward the fly + its shadow
    this.threat = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.35, metalness: 0.3, emissive: 0x220406 }));
    this.threat.castShadow = true; this.threat.visible = false; scene.add(this.threat);
    this.threatShadow = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ map: radialTex('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false }));
    this.threatShadow.rotation.x = -Math.PI / 2; this.threatShadow.position.y = 0.03; this.threatShadow.visible = false; scene.add(this.threatShadow);
    this.threatRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 8, 64), new THREE.MeshBasicMaterial({ color: 0xff5a5a, transparent: true }));
    this.threatRing.rotation.x = Math.PI / 2; this.threatRing.visible = false; scene.add(this.threatRing);

    // camera state
    this.mode = 'follow';
    this.orbit = { yaw: 2.3, pitch: 0.5, dist: 15 };
    this.target = new THREE.Vector3(arena.fly.x, 1, arena.fly.y);
    this.camYaw = this.orbit.yaw; this.camPitch = this.orbit.pitch; this.camDist = this.orbit.dist;
    this.raycaster = new THREE.Raycaster();
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._bind();
  }

  setMode(m) { this.mode = m; this.orbit.dist = m === 'overview' ? 62 : 15; this.orbit.pitch = m === 'overview' ? 0.95 : 0.5; }

  _groundPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.ground, p) ? { x: p.x, y: p.z } : null;
  }

  _bind() {
    const c = this.canvas, a = this.arena;
    let st = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const p = this._groundPoint(e);
      st = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, mode: 'pending', p };
      if (e.button === 2 || e.shiftKey) st.mode = 'orbit';
      else if (a.tool === 'threat' && p) { a.pointerDown(p); st.mode = 'threat'; }
    });
    c.addEventListener('pointermove', (e) => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y; st.x = e.clientX; st.y = e.clientY;
      if (st.mode === 'pending' && Math.hypot(e.clientX - st.x0, e.clientY - st.y0) > 5) st.mode = 'orbit';
      if (st.mode === 'orbit') {
        this.orbit.yaw += dx * 0.008;
        this.orbit.pitch = clamp(this.orbit.pitch + dy * 0.006, 0.08, 1.45);
      } else if (st.mode === 'threat') { const p = this._groundPoint(e); if (p) a.pointerMove(p); }
    });
    const up = () => {
      if (!st) return;
      if (st.mode === 'pending' && st.p) { a.pointerDown(st.p); a.pointerUp(); }
      if (st.mode === 'threat') a.pointerUp();
      st = null;
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbit.dist = clamp(this.orbit.dist * Math.exp(e.deltaY * 0.001), 4, 95);
    }, { passive: false });
  }

  _syncDrops() {
    const seen = new Set();
    for (const d of this.arena.drops) {
      seen.add(d);
      let m = this.dropMeshes.get(d);
      if (!m) {
        const col = DROP_COLORS[d.kind];
        const mesh = new THREE.Mesh(this.dropGeo, new THREE.MeshPhysicalMaterial({
          color: col, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
          transparent: true, opacity: 0.9, emissive: col, emissiveIntensity: 0.28,
        }));
        mesh.castShadow = true; mesh.receiveShadow = true;
        const glow = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({
          map: this.glowTex, color: col, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        glow.rotation.x = -Math.PI / 2; glow.position.y = 0.02;
        m = { mesh, glow }; this.scene.add(mesh, glow); this.dropMeshes.set(d, m);
      }
      const r = d.r * Math.sqrt(d.amount);
      m.mesh.position.set(d.x, 0, d.y); m.mesh.scale.set(r, r * 0.34, r);
      m.glow.position.set(d.x, 0.02, d.y); m.glow.scale.setScalar(r * 1.9);
    }
    for (const [d, m] of this.dropMeshes) if (!seen.has(d)) { this.scene.remove(m.mesh, m.glow); m.mesh.material.dispose(); m.glow.material.dispose(); this.dropMeshes.delete(d); }
  }

  _syncPuffs() {
    const a = this.arena, seen = new Set();
    for (const p of a.puffs) {
      seen.add(p);
      let g = this.puffMeshes.get(p);
      if (!g) {
        g = new THREE.Group();
        for (let k = 0; k < 3; k++) g.add(new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 48), new THREE.MeshBasicMaterial({ color: 0xd6ecff, transparent: true })));
        this.scene.add(g); this.puffMeshes.set(p, g);
      }
      const u = clamp((a.simT - p.t0) / 700, 0, 1);
      g.position.set(p.x, 1.1, p.y);
      g.children.forEach((m, k) => { m.scale.setScalar(0.6 + u * 4 + k * 0.8); m.material.opacity = 0.7 * (1 - u); m.rotation.x = Math.PI / 2; });
    }
    for (const [p, g] of this.puffMeshes) if (!seen.has(p)) { this.scene.remove(g); this.puffMeshes.delete(p); }
  }

  _syncTrail() {
    const tr = this.arena.trail, g = this.trail.geometry;
    const P = g.attributes.position.array, C = g.attributes.color.array, n = tr.length;
    for (let i = 0; i < n; i++) {
      P[i * 3] = tr[i].x; P[i * 3 + 1] = 0.05; P[i * 3 + 2] = tr[i].y;
      const k = (i / n) * 0.55;
      C[i * 3] = 0.47 * k; C[i * 3 + 1] = 0.86 * k; C[i * 3 + 2] = 0.82 * k;
    }
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }

  draw(t) {
    const a = this.arena, f = a.fly;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this._w !== w || this._h !== h || this._dpr !== dpr) {
      this._w = w; this._h = h; this._dpr = dpr;
      this.renderer.setPixelRatio(dpr); this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h); this.camera.updateProjectionMatrix();
    }
    const env6 = a.sixEnv;
    this.fly.pose(f, env6, t);
    this._syncDrops(); this._syncPuffs(); this._syncTrail();

    const th = a.threat;
    const on = !!(th && th.size > 0);
    this.threat.visible = this.threatShadow.visible = this.threatRing.visible = on;
    if (on) {
      const rr = 1 + th.size * 4.5;
      this.threat.position.set(th.x, 3 + (1 - th.size) * 26 + rr * 0.3, th.y); this.threat.scale.setScalar(rr);
      this.threatShadow.position.set(th.x, 0.03, th.y); this.threatShadow.scale.setScalar(rr * (1.4 + th.size));
      this.threatRing.position.set(th.x, 0.06, th.y); this.threatRing.scale.setScalar(rr * 1.1); this.threatRing.material.opacity = 0.6 * th.size;
    }

    // camera: follow / overview, swooping to a front close-up during 6-7
    const lift = f.fly > 0 ? Math.sin((1 - f.fly) * Math.PI) * 7 : 0;
    const tgt = this.mode === 'overview' ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(f.x, 1 + lift * 0.8, f.y);
    const k = 0.12;
    this.target.lerp(tgt, k);
    let yaw = this.orbit.yaw, pitch = this.orbit.pitch, dist = this.orbit.dist;
    if (env6 > 0) {
      const e = env6 * env6 * (3 - 2 * env6);
      this.target.lerp(new THREE.Vector3(f.x + Math.cos(f.th) * 0.8, 1.55, f.y + Math.sin(f.th) * 0.8), e * 0.6);
      yaw = lerpAngle(yaw, f.th + 0.3, e); pitch = lerp(pitch, 0.12, e); dist = lerp(dist, 6.4, e);
    }
    this.camYaw = lerpAngle(this.camYaw, yaw, 0.12); this.camPitch = lerp(this.camPitch, pitch, 0.12); this.camDist = lerp(this.camDist, dist, 0.12);
    const cp = Math.cos(this.camPitch);
    this.camera.position.set(
      this.target.x + this.camDist * cp * Math.cos(this.camYaw),
      this.target.y + this.camDist * Math.sin(this.camPitch),
      this.target.z + this.camDist * cp * Math.sin(this.camYaw));
    // keep the camera inside the arena wall so it never looks through it
    const cr = Math.hypot(this.camera.position.x, this.camera.position.z), lim = a.R - 1.2;
    if (this.mode === 'follow' && cr > lim && this.camera.position.y < 12) {
      const k2 = lim / cr; this.camera.position.x *= k2; this.camera.position.z *= k2;
    }
    this.camera.lookAt(this.target);
    this.fill.position.copy(this.camera.position).add(new THREE.Vector3(0, 4, 0)); this.fill.target.position.copy(this.target);
    this.fill.intensity = 0.5 + 1.2 * env6;

    // shadow frustum hugs the fly (crisp) or covers the arena (overview)
    const big = this.mode === 'overview' || this.camDist > 30;
    const sc = this.sun.shadow.camera, ext = big ? a.R + 2 : 9;
    if (sc.right !== ext) { sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 80; sc.updateProjectionMatrix(); }
    const c = big ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(f.x, 0, f.y);
    this.sun.position.set(c.x + 10, 30, c.z + 6); this.sun.target.position.copy(c);

    this.renderer.render(this.scene, this.camera);
  }
}
