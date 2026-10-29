// Воксельная графика на WebGL: город из кубов. Земля — запечённые ночные текстуры чанков,
// здания/деревья/машины — объёмные блоки, неон — с bloom, стекло отражает окружение через кубическую камеру.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as W from './world.js';
import { CS, buildChunkAt, peekChunk } from './chunks.js';
import { S, LIGHT_RGB, CAR_COLORS, CAR_DIM } from './sprites.js';
import { rain } from './rain.js';
import { hashU } from './util.js';

const BG = 0x04060c;
const CHUNK_R = 2600;     // радиус подгрузки земли
const BLOCK_R = 2300;     // радиус подгрузки кварталов
const TEX = 256;          // разрешение запечённой текстуры чанка (2 ед. на тексель — «пиксельная» земля)

// ---------------------------------------------------------------- геометрия из коробок
const colCache = new Map();
function col(hex, k = 1) {
  const key = hex + '|' + k;
  let c = colCache.get(key);
  if (!c) { c = new THREE.Color(hex).multiplyScalar(k); colCache.set(key, c); }
  return c;
}
const glowCol = (name, k = 2.2) => {
  const rgb = LIGHT_RGB[name] || LIGHT_RGB.white;
  return new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace).multiplyScalar(k);
};

const DARK_UV = 0.5 / 64;
class Geo {
  constructor() { this.p = []; this.n = []; this.c = []; this.u = []; this.i = []; this.v = 0; }
  quad(a, b, c, d, n, cl, uv) {
    const q = [a, b, c, d];
    for (let k = 0; k < 4; k++) {
      this.p.push(q[k][0], q[k][1], q[k][2]);
      this.n.push(n[0], n[1], n[2]);
      this.c.push(cl.r, cl.g, cl.b);
      this.u.push(uv ? uv[k * 2] : DARK_UV, uv ? uv[k * 2 + 1] : DARK_UV);
    }
    const v = this.v;
    this.i.push(v, v + 1, v + 2, v, v + 2, v + 3);
    this.v += 4;
  }
  // win: [ou, ov, su, sv] — смещение и масштаб UV на боковых гранях (окна / стёкла)
  box(x0, y0, z0, x1, y1, z1, side, top = side, win = null, bottom = false) {
    const suv = (a0, a1) => (win ? [win[0] + a0 * win[2], win[1] + y0 * win[3], win[0] + a0 * win[2], win[1] + y1 * win[3],
      win[0] + a1 * win[2], win[1] + y1 * win[3], win[0] + a1 * win[2], win[1] + y0 * win[3]] : null);
    const dx = x1 - x0, dz = z1 - z0;
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], top, null);
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], side, suv(0, dz));
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], side, suv(0, dz));
    this.quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], side, suv(0, dx));
    this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], side, suv(0, dx));
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], side, null);
  }
  cube(x, y, z, s, cl) { this.box(x - s / 2, y - s / 2, z - s / 2, x + s / 2, y + s / 2, z + s / 2, cl, cl, null, true); }
  empty() { return this.v === 0; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------- текстуры
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function windowAtlas() {
  const c = canvas(64, 64), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 1; y < 64; y += 2) {
    const floorDark = rnd() < 0.25;
    for (let x = 1; x < 64; x += 2) {
      if (floorDark || rnd() > 0.4) { g.fillStyle = '#07090c'; g.fillRect(x, y, 1, 1); continue; }
      const k = rnd();
      g.fillStyle = k < 0.68 ? '#ffc778' : k < 0.92 ? '#b8d6ff' : '#6a88ff';
      g.fillRect(x, y, 1, 1);
    }
  }
  return pixelTex(c);
}
function mullionTex() {
  const c = canvas(16, 16), g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#4a5560'; g.fillRect(0, 0, 1, 16); g.fillRect(0, 0, 16, 1);
  return pixelTex(c);
}
function pixelTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = false;
  return t;
}
// ---------------------------------------------------------------- модели машин
const matCache = new Map();
function lambert(hex) {
  let m = matCache.get('l' + hex);
  if (!m) { m = new THREE.MeshLambertMaterial({ color: hex }); matCache.set('l' + hex, m); }
  return m;
}
function glowMat(name, k = 2.2) {
  const key = 'g' + name + k;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ color: glowCol(name, k), toneMapped: false }); matCache.set(key, m); }
  return m;
}
const unitBox = new THREE.BoxGeometry(1, 1, 1);
function part(grp, mat, x, y, z, sx, sy, sz) {
  const m = new THREE.Mesh(unitBox, mat);
  m.position.set(x, y, z); m.scale.set(sx, sy, sz);
  grp.add(m);
  return m;
}
let coneTex = null;
// Машина собрана из частей, чтобы их можно было мять: перед / середина / зад, кабина, крыша
function carModel(kind, color, isPlayer = false) {
  const [L, Wd] = CAR_DIM[kind] || CAR_DIM.sedan;
  const g = new THREE.Group();
  const body = isPlayer ? new THREE.MeshLambertMaterial({ color }) : lambert(color);
  const dark = lambert('#14181e');
  const tall = kind === 'bus' || kind === 'truck';
  const P = {};
  if (kind === 'truck') {
    P.rear = part(g, body, -L * 0.15, 17, 0, L * 0.7, 28, Wd);
    P.front = part(g, lambert('#d8d8d0'), L * 0.36, 13, 0, L * 0.27, 20, Wd - 2);
    part(g, dark, L * 0.48, 17, 0, 2, 8, Wd - 6);
  } else if (kind === 'bus') {
    P.mid = part(g, body, 0, 16, 0, L, 26, Wd);
    part(g, glowMat('warm', 0.9), 0, 20, Wd / 2 + 0.3, L * 0.85, 6, 0.6);
    part(g, glowMat('warm', 0.9), 0, 20, -Wd / 2 - 0.3, L * 0.85, 6, 0.6);
  } else {
    const seg = L / 3;
    P.rear = part(g, body, -seg, 8, 0, seg, 9, Wd);
    P.mid = part(g, body, 0, 8, 0, seg + 0.2, 9, Wd);
    P.front = part(g, body, seg, 7.5, 0, seg, 8, Wd);
    const cab = kind === 'van' ? [L * 0.75, -L * 0.08] : kind === 'hatch' ? [L * 0.55, -L * 0.1] : [L * 0.48, -L * 0.04];
    P.cabin = part(g, dark, cab[1], 16, 0, cab[0], 7, Wd - 3);
    P.roof = part(g, body, cab[1], 20, 0, cab[0] - 6, 1.5, Wd - 5);
    if (kind === 'taxi') part(g, glowMat('yellow', 1.4), cab[1], 23, 0, 6, 3, 10);
    if (kind === 'police') g.userData.bar = [part(g, glowMat('red', 3), cab[1], 22.5, -4, 4, 2.5, 7), part(g, glowMat('blue', 3), cab[1], 22.5, 4, 4, 2.5, 7)];
    if (isPlayer) { P.stripeA = part(g, lambert('#f2f2f2'), 0, 12.6, -3, L - 2, 0.6, 2); P.stripeB = part(g, lambert('#f2f2f2'), 0, 12.6, 3, L - 2, 0.6, 2); }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) part(g, lambert('#0a0a0c'), sx * L * 0.32, 4, sz * (Wd / 2), 9, 8, 3);
  g.userData.heads = [part(g, glowMat('white', 2.5), L / 2 + 0.3, 8, -Wd / 2 + 4, 1, 3, 4), part(g, glowMat('white', 2.5), L / 2 + 0.3, 8, Wd / 2 - 4, 1, 3, 4)];
  g.userData.tail = [part(g, glowMat('red', 1), -L / 2 - 0.3, 8, -Wd / 2 + 4, 1, 3, 4), part(g, glowMat('red', 1), -L / 2 - 0.3, 8, Wd / 2 - 4, 1, 3, 4)];
  if (!coneTex) { coneTex = new THREE.CanvasTexture(S.coneGlow); coneTex.colorSpace = THREE.SRGBColorSpace; }
  const len = isPlayer ? 300 : 190;
  const cone = new THREE.Mesh(new THREE.PlaneGeometry(len, len * 0.72), new THREE.MeshBasicMaterial({
    map: coneTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: isPlayer ? 0.55 : 0.3, toneMapped: false,
  }));
  cone.rotation.x = -Math.PI / 2;
  cone.position.set(L / 2 + len / 2 - 4, 1.2, 0);
  g.add(cone);
  g.userData.cone = cone;
  g.userData.parts = P;
  g.userData.body = body;
  g.userData.baseColor = new THREE.Color(color);
  g.userData.L = L; g.userData.W = Wd;
  // исходные положения частей для модели повреждений
  g.userData.base = new Map();
  g.traverse((o) => { if (o !== g) g.userData.base.set(o, { p: o.position.clone(), s: o.scale.clone() }); });
  return g;
}

// Деформация по зонам повреждений игрока
const scorch = new THREE.Color('#161414');
function applyDamage(m, P) {
  const { parts: Q, base, L, W: Wd } = m.userData;
  const d = P.dmg;
  for (const [o, b] of base) { o.position.copy(b.p); o.scale.copy(b.s); o.rotation.set(o === m.userData.cone ? -Math.PI / 2 : 0, 0, 0); }
  const seg = L / 3;
  if (Q.front) {
    const k = d.front * 0.5;
    Q.front.scale.x *= 1 - k; Q.front.position.x -= (seg * k) / 2; Q.front.rotation.z = -0.25 * d.front; Q.front.position.y += 1.5 * d.front;
  }
  if (Q.rear) {
    const k = d.rear * 0.45;
    Q.rear.scale.x *= 1 - k; Q.rear.position.x += (seg * k) / 2; Q.rear.rotation.z = 0.2 * d.rear;
  }
  if (Q.mid) {
    const side = d.left - d.right;
    Q.mid.position.z += side * 3; Q.mid.scale.z *= 1 - 0.2 * Math.max(d.left, d.right);
  }
  if (Q.cabin) {
    Q.cabin.rotation.x = (d.left - d.right) * 0.18; Q.cabin.rotation.z = (d.rear - d.front) * 0.08;
    Q.cabin.scale.y *= 1 - 0.3 * Math.max(d.front, d.left, d.right, d.rear) * (1 - P.hp / 100);
  }
  if (Q.roof) { Q.roof.rotation.x = Q.cabin.rotation.x * 1.3; Q.roof.position.y -= 2 * (1 - P.hp / 100); }
  // фары и фонари: смещаются вместе с мятым передом/задом и бьются
  const [hl, hr] = m.userData.heads, [tl, tr] = m.userData.tail;
  hl.position.x -= seg * d.front * 0.5; hr.position.x -= seg * d.front * 0.5;
  tl.position.x += seg * d.rear * 0.45; tr.position.x += seg * d.rear * 0.45;
  hl.visible = d.front < 0.4 && !P.dead; hr.visible = d.front < 0.75 && !P.dead;
  tl.visible = d.rear < 0.45; tr.visible = d.rear < 0.8;
  const cone = m.userData.cone;
  cone.visible = hl.visible || hr.visible;
  cone.material.opacity = hl.visible && hr.visible ? 0.55 : 0.3;
  m.userData.body.color.copy(m.userData.baseColor).lerp(scorch, P.dead ? 0.92 : (1 - P.hp / 100) * 0.55);
}

// Частицы-кубики: дым, огонь, искры, обломки
class Particles {
  constructor(scene, max, mat) {
    this.mesh = new THREE.InstancedMesh(unitBox, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.max = max; this.list = [];
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.p = new THREE.Vector3(); this.s = new THREE.Vector3();
    this.c = new THREE.Color();
    scene.add(this.mesh);
  }
  add(o) {
    if (this.list.length >= this.max) this.list.shift();
    o.t = 0; o.rx = o.rx || 0; o.ry = o.ry || 0; o.spin = o.spin || 0;
    this.list.push(o);
  }
  update(dt) {
    let n = 0;
    const out = [];
    for (const o of this.list) {
      o.t += dt;
      if (o.t >= o.life) continue;
      o.vy -= (o.g || 0) * dt;
      const dr = Math.exp(-(o.drag || 0) * dt);
      o.vx *= dr; o.vy *= o.g ? 1 : dr; o.vz *= dr;
      o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt;
      if (o.y < o.s1 / 2 && o.g) { o.y = o.s1 / 2; o.vy *= -0.35; o.vx *= 0.6; o.vz *= 0.6; o.spin *= 0.5; }
      o.rx += o.spin * dt; o.ry += o.spin * 0.7 * dt;
      const k = o.t / o.life;
      const sz = o.s0 + (o.s1 - o.s0) * k;
      this.e.set(o.rx, o.ry, 0); this.q.setFromEuler(this.e);
      this.p.set(o.x, o.y, o.z); this.s.set(sz, sz, sz);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      this.c.copy(o.col);
      if (o.fade) this.c.multiplyScalar(1 - k * 0.8);
      this.mesh.setColorAt(n, this.c);
      out.push(o);
      n++;
    }
    this.list = out;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- рендерер
export function createVoxel(cv) {
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 1600, 3600);
  const camera = new THREE.PerspectiveCamera(45, 1, 10, 9000);
  scene.add(new THREE.HemisphereLight(0x7080b0, 0x080810, 0.55));
  const moon = new THREE.DirectionalLight(0xa8b8ff, 0.5);
  moon.position.set(-0.6, 1, 0.8);
  scene.add(moon);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.7);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const atlas = windowAtlas();
  const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveMap: atlas, emissiveIntensity: 1.2 });
  const glowMatV = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  // Кубическая камера на уровне улицы снимает настоящий город вокруг — его и отражают стеклянные фасады.
  // За кадр обновляются две грани, полный оборот — за три кадра.
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const cubeCam = new THREE.CubeCamera(6, 4200, cubeRT);
  scene.add(cubeCam);
  let probeFace = -1;
  const glassMat = new THREE.MeshPhongMaterial({
    vertexColors: true, map: mullionTex(), envMap: cubeRT.texture, combine: THREE.MixOperation,
    reflectivity: 0.88, shininess: 90, specular: 0x555555,
    emissive: 0x0a1418, // слабый свет изнутри, чтобы стекло читалось и в тёмных местах
  });
  function updateProbe(T) {
    cubeCam.position.set(T.x, 90, T.z);
    cubeCam.updateMatrixWorld();
    glassMat.visible = false;
    const rl = rainLines.visible; rainLines.visible = false;
    if (probeFace < 0) { cubeCam.update(renderer, scene); probeFace = 0; }
    else {
      const cur = renderer.getRenderTarget();
      for (let n = 0; n < 2; n++) {
        renderer.setRenderTarget(cubeRT, probeFace);
        renderer.render(scene, cubeCam.children[probeFace]);
        probeFace = (probeFace + 1) % 6;
      }
      renderer.setRenderTarget(cur);
    }
    glassMat.visible = true;
    rainLines.visible = rl;
  }

  const chunks = new Map();
  const blocks = new Map();
  const cars = new Map();
  let playerModel = null, playerGen = -1;
  // эффекты
  const fxSmoke = new Particles(scene, 500, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }));
  const fxFire = new Particles(scene, 400, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const fxDebris = new Particles(scene, 300, new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const flash = new THREE.PointLight(0xffa040, 0, 700, 1.2);
  scene.add(flash);
  let flashT = 0;
  const fallen = [];
  const C = (h, k = 1) => new THREE.Color(h).multiplyScalar(k);
  const SPARK = [C('#ffd060', 3), C('#ffaa30', 3), C('#ffffff', 3)];
  const FIRE = [C('#ff6a10', 2.2), C('#ffb020', 2.4), C('#ff3008', 2)];
  const rnd = (a, b) => a + Math.random() * (b - a);
  function sparks(x, y, z, n, speed = 160) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283;
      fxFire.add({ x, y, z, vx: Math.cos(a) * rnd(30, speed), vy: rnd(20, speed * 0.9), vz: Math.sin(a) * rnd(30, speed), g: 420, life: rnd(0.25, 0.7), s0: 2.2, s1: 0.6, col: SPARK[k % 3] });
    }
  }
  function debris(x, z, color, n, speed = 140) {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283;
      fxDebris.add({ x, y: 10, z, vx: Math.cos(a) * rnd(20, speed), vy: rnd(40, speed), vz: Math.sin(a) * rnd(20, speed), g: 500, life: rnd(2.5, 4.5), s0: rnd(2, 5), s1: rnd(2, 4), col: k % 4 ? c : C('#20262e'), spin: rnd(-12, 12) });
    }
  }
  function smoke(x, y, z, black, n = 1) {
    for (let k = 0; k < n; k++) fxSmoke.add({ x: x + rnd(-4, 4), y, z: z + rnd(-4, 4), vx: rnd(-6, 6) + 25, vy: rnd(30, 55), vz: rnd(-6, 6), drag: 0.6, life: rnd(1.4, 2.6), s0: rnd(4, 7), s1: rnd(14, 26), col: black ? C('#141414') : C('#6a6e76'), fade: true, spin: rnd(-1, 1) });
  }
  function fire(x, y, z, n = 1, spread = 6) {
    for (let k = 0; k < n; k++) fxFire.add({ x: x + rnd(-spread, spread), y, z: z + rnd(-spread, spread), vx: rnd(-8, 8), vy: rnd(40, 90), vz: rnd(-8, 8), drag: 1, life: rnd(0.35, 0.8), s0: rnd(5, 9), s1: 1, col: FIRE[k % 3] });
  }
  function doFlash(x, z, power, color = 0xffa040) { flash.position.set(x, 40, z); flash.color.set(color); flash.intensity = power; flashT = 0.6; }
  // упавший столб
  function dropLamp(l) {
    const g = new THREE.Group();
    g.position.set(l.x, 0, l.y);
    part(g, lambert('#4a4e56'), 0, 28, 0, 3, 56, 3);
    const ox = l.lx - l.x, oz = l.ly - l.y;
    part(g, lambert('#2a2c30'), ox, 52.5, oz, 10, 3, 6);
    scene.add(g);
    const a = l.fallA || 0;
    const axis = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)).normalize();
    fallen.push({ g, axis, t: 0, landed: false, l });
    sparks(l.lx, 52, l.ly, 26, 140);
    doFlash(l.lx, l.ly, 3, 0xbfd8ff);
    // перепекаем землю вокруг — пятно света исчезает
    for (const [key, e] of [...chunks]) {
      const [cx, cy] = key.split(',').map(Number);
      const x0 = cx * CS, y0 = cy * CS;
      if (l.lx + l.r < x0 || l.lx - l.r > x0 + CS || l.ly + l.r < y0 || l.ly - l.r > y0 + CS) continue;
      const ch = peekChunk(cx, cy);
      if (!ch) continue;
      chunks.set(key, bakeChunk(ch));
      dropChunk(e);
    }
  }
  // следы шин
  const SKID_MAX = 1700;
  const skidPos = new Float32Array(SKID_MAX * 12);
  const skidIdx = [];
  for (let k = 0; k < SKID_MAX; k++) { const v = k * 4; skidIdx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
  const skidGeo = new THREE.BufferGeometry();
  skidGeo.setAttribute('position', new THREE.BufferAttribute(skidPos, 3).setUsage(THREE.DynamicDrawUsage));
  skidGeo.setIndex(skidIdx);
  const skidMesh = new THREE.Mesh(skidGeo, new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
  skidMesh.frustumCulled = false;
  scene.add(skidMesh);
  function syncSkids(st) {
    const n = Math.min(SKID_MAX, st.skids.length);
    const off = st.skids.length - n;
    for (let k = 0; k < n; k++) {
      const [x0, y0, x1, y1] = st.skids[off + k];
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
      const px = (-dy / l) * 1.8, py = (dx / l) * 1.8;
      skidPos.set([x0 + px, 0.5, y0 + py, x0 - px, 0.5, y0 - py, x1 + px, 0.5, y1 + py, x1 - px, 0.5, y1 - py], k * 12);
    }
    skidGeo.setDrawRange(0, n * 6);
    skidGeo.attributes.position.needsUpdate = true;
  }
  function handleFx(st, dt) {
    for (const f of st.fx) {
      if (f.type === 'sparks') sparks(f.x, 10, f.y, f.n);
      else if (f.type === 'debris') debris(f.x, f.y, f.color, f.n);
      else if (f.type === 'lamp') dropLamp(f.lamp);
      else if (f.type === 'explode') {
        sparks(f.x, 14, f.y, 70, 260); fire(f.x, 10, f.y, 60, 22); debris(f.x, f.y, '#d8262a', 40, 220);
        for (let k = 0; k < 20; k++) smoke(f.x, 20, f.y, true);
        doFlash(f.x, f.y, 14);
      }
    }
    st.fx.length = 0;
    // дым и огонь из подбитого мотора
    const P = st.player;
    const fx = Math.cos(P.a), fy = Math.sin(P.a);
    const ex = P.x + fx * 14, ez = P.y + fy * 14;
    if (P.hp < 60 && Math.random() < dt * (P.dead ? 30 : (60 - P.hp) * 0.35)) smoke(ex, 16, ez, P.hp < 25);
    if (P.hp < 22 && Math.random() < dt * (P.dead ? 60 : 18)) fire(ex, 14, ez, 1, P.dead ? 14 : 5);
    for (const c of st.traffic) if (c.mode === 'hit' && c.hitT < 6 && Math.random() < dt * 4) smoke(c.x + Math.cos(c.a) * c.L * 0.3, 14, c.y + Math.sin(c.a) * c.L * 0.3, false);
    fxSmoke.update(dt); fxFire.update(dt); fxDebris.update(dt);
    if (flashT > 0) { flashT -= dt; flash.intensity *= Math.exp(-dt * 6); if (flashT <= 0) flash.intensity = 0; }
    for (let k = fallen.length - 1; k >= 0; k--) {
      const f = fallen[k];
      if (f.t < 0.8) {
        f.t += dt;
        const th = Math.min(1, (f.t / 0.8) ** 2) * Math.PI * 0.49;
        f.g.quaternion.setFromAxisAngle(f.axis, th);
        if (f.t >= 0.8 && !f.landed) { f.landed = true; const a = f.l.fallA || 0; sparks(f.l.x + Math.cos(a) * 52, 3, f.l.y + Math.sin(a) * 52, 18, 120); }
      }
      if (Math.abs(f.g.position.x - P.x) > 3500 || Math.abs(f.g.position.z - P.y) > 3500) { scene.remove(f.g); fallen.splice(k, 1); }
    }
  }

  // пешеходы
  const MAXP = 90;
  const pedBody = new THREE.InstancedMesh(new THREE.BoxGeometry(7, 12, 5), new THREE.MeshLambertMaterial(), MAXP);
  const pedHead = new THREE.InstancedMesh(new THREE.BoxGeometry(5, 5, 5), new THREE.MeshLambertMaterial({ color: 0xd8b090 }), MAXP);
  pedBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage); pedHead.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(pedBody, pedHead);
  const PED_COLS = ['#c84a3a', '#3a6ac8', '#d8d8d8', '#3a3a3a', '#8a6a3a', '#3a8a5a', '#a03a8a', '#c8a03a'].map((h) => new THREE.Color(h));

  // дождь
  const MAXR = 1000;
  const rainPos = new Float32Array(MAXR * 6);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
  const rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0x9fb2e0, transparent: true, opacity: 0.4, fog: true }));
  rainLines.frustumCulled = false;
  scene.add(rainLines);

  // поезда
  const trainPool = [];
  function trainModel(n, carL) {
    const g = new THREE.Group();
    for (let k = 0; k < n; k++) {
      const z = (k + 0.5) * carL;
      const end = k === 0 || k === n - 1;
      part(g, lambert(end ? '#b83a2a' : '#5a6a7a'), 0, 16, z, 26, 26, carL - 6);
      part(g, glowMat('warm', 1.2), 13.4, 18, z, 0.6, 7, carL - 26);
      part(g, glowMat('warm', 1.2), -13.4, 18, z, 0.6, 7, carL - 26);
    }
    part(g, glowMat('white', 3), -7, 10, -0.5, 4, 4, 1);
    part(g, glowMat('white', 3), 7, 10, -0.5, 4, 4, 1);
    scene.add(g);
    return g;
  }

  // ---------------------------------------------------------------- чанки земли
  const dark = canvas(TEX, TEX), dg = dark.getContext('2d');
  function bakeChunk(ch) {
    const x0 = ch.cx * CS, y0 = ch.cy * CS, k = TEX / CS;
    const c = canvas(TEX, TEX), g = c.getContext('2d');
    g.drawImage(ch.canvas, 0, 0, TEX, TEX);
    // свет: фонари этого чанка, соседних и всех кварталов вокруг
    const lamps = new Set(ch.lamps);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const n = (dx || dy) && peekChunk(ch.cx + dx, ch.cy + dy);
      if (n) for (const l of n.lamps) lamps.add(l);
    }
    for (let i = W.colAt(x0 - 260); i <= W.colAt(x0 + CS + 260); i++) for (let j = W.rowAt(y0 - 260); j <= W.rowAt(y0 + CS + 260); j++) {
      for (const l of W.getBlock(i, j).lamps) lamps.add(l);
    }
    const near = [...lamps].filter((l) => !l.broken && l.lx + l.r > x0 && l.lx - l.r < x0 + CS && l.ly + l.r > y0 && l.ly - l.r < y0 + CS);
    dg.globalCompositeOperation = 'source-over';
    dg.globalAlpha = 1;
    dg.clearRect(0, 0, TEX, TEX);
    dg.fillStyle = 'rgba(1,2,8,0.9)';
    dg.fillRect(0, 0, TEX, TEX);
    dg.globalCompositeOperation = 'destination-out';
    for (const l of near) {
      const r = l.r * k;
      dg.globalAlpha = Math.min(1, l.i * (l.dot ? 0.7 : 0.85));
      dg.drawImage(S.mask, (l.lx - x0) * k - r, (l.ly - y0) * k - r, r * 2, r * 2);
    }
    g.drawImage(dark, 0, 0);
    g.globalCompositeOperation = 'lighter';
    for (const l of near) {
      const spr = S.glow[l.c] || S.glow.white;
      const r = (l.dot ? 14 : l.r * 0.95) * k;
      g.globalAlpha = Math.min(1, l.i * (l.dot ? 0.5 : l.c === 'sodium' ? 0.2 : l.c === 'white' ? 0.09 : 0.24));
      g.drawImage(spr, (l.lx - x0) * k - r, (l.ly - y0) * k - r, r * 2, r * 2);
    }
    // светящиеся зебры
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,0.2)';
    for (let i = W.colAt(x0 - 100); i <= W.colAt(x0 + CS + 100) + 1; i++) for (let j = W.rowAt(y0 - 100); j <= W.rowAt(y0 + CS + 100) + 1; j++) {
      const x = W.roadX(i), y = W.roadY(j);
      if (W.riverDist(x, y) < 60) continue;
      const hw = W.widthX(i) / 2, hh = W.widthY(j) / 2;
      const ds = W.diagsInRect(x - 150, y - 150, x + 150, y + 150, W.DIAG_W);
      const R = (rx, ry, rw, rh) => {
        for (const d of ds) if (Math.abs(W.diagSigned(d, rx + rw / 2, ry + rh / 2)) < W.DIAG_W / 2 + W.SW) return;
        g.fillRect((rx - x0) * k, (ry - y0) * k, rw * k, rh * k);
      };
      for (let u = -hw + 5; u < hw - 8; u += 11) { R(x + u, y - hh - 22, 6, 18); R(x + u, y + hh + 4, 6, 18); }
      for (let u = -hh + 5; u < hh - 8; u += 11) { R(x - hw - 22, y + u, 18, 6); R(x + hw + 4, y + u, 18, 6); }
    }
    g.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;
    const grp = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(CS, CS), new THREE.MeshBasicMaterial({ map: tex }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(x0 + CS / 2, 0, y0 + CS / 2);
    grp.add(ground);
    // столбы и светящиеся головы фонарей
    const solid = new Geo(), glow = new Geo();
    const poleC = col('#4a4e56');
    for (const l of ch.lamps) {
      if (l.broken) continue;
      if (l.dot) { glow.cube(l.lx, 9, l.ly, 3.5, glowCol(l.c, 2.4)); continue; }
      if (!l.pole) continue;
      solid.box(l.x - 1.5, 0, l.y - 1.5, l.x + 1.5, 56, l.y + 1.5, poleC);
      const ax = Math.abs(l.lx - l.x) < 1, az = Math.abs(l.ly - l.y) < 1;
      if (ax !== az) solid.box(Math.min(l.x, l.lx) - 1, 54, Math.min(l.y, l.ly) - 1, Math.max(l.x, l.lx) + 1, 56, Math.max(l.y, l.ly) + 1, poleC);
      glow.box(l.lx - 5, 51, l.ly - 3, l.lx + 5, 54, l.ly + 3, glowCol(l.c, 2.6), glowCol(l.c, 2.6), null, true);
    }
    if (!solid.empty()) grp.add(new THREE.Mesh(solid.build(), solidMat));
    if (!glow.empty()) grp.add(new THREE.Mesh(glow.build(), glowMatV));
    scene.add(grp);
    return { grp, tex };
  }
  function dropChunk(e) {
    scene.remove(e.grp);
    e.grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map && o.material.map === e.tex) o.material.dispose(); });
    e.tex.dispose();
  }

  // ---------------------------------------------------------------- кварталы
  const TREE_C = ['#1f3d24', '#25472b', '#2d4d25', '#1d3826'];
  const lighten = (hex, toward, t) => new THREE.Color(hex).lerp(new THREE.Color(toward), t);
  function buildBlock(B) {
    const solid = new Geo(), glow = new Geo(), glass = new Geo();
    const cranes = [];
    for (const b of B.buildings) addBuilding(b, solid, glow, glass, cranes);
    for (const t of B.trees) {
      const tr = col('#2a2018');
      solid.box(t.x - 2.5, 0, t.y - 2.5, t.x + 2.5, 12, t.y + 2.5, tr);
      const c = col(TREE_C[t.v % 4], 1.3), c2 = col(TREE_C[(t.v + 1) % 4], 1.6);
      const r = t.r * 0.8;
      if (t.kind === 1) {
        solid.box(t.x - r, 10, t.y - r, t.x + r, 22, t.y + r, c);
        solid.box(t.x - r * 0.65, 22, t.y - r * 0.65, t.x + r * 0.65, 34, t.y + r * 0.65, c);
        solid.box(t.x - r * 0.3, 34, t.y - r * 0.3, t.x + r * 0.3, 44, t.y + r * 0.3, c2);
      } else {
        solid.box(t.x - r, 12, t.y - r, t.x + r, 12 + r * 1.2, t.y + r, c);
        solid.box(t.x - r * 0.6, 12 + r * 1.2, t.y - r * 0.6, t.x + r * 0.6, 12 + r * 1.7, t.y + r * 0.6, c2);
      }
    }
    for (const p of B.parked) {
      const kind = p.kind === 'truck' ? 'truck' : 'sedan';
      const [L, Wd] = CAR_DIM[kind];
      const vert = Math.abs(Math.sin(p.a)) > 0.5;
      const hx = (vert ? Wd : L) / 2, hz = (vert ? L : Wd) / 2;
      const c = col(kind === 'truck' ? '#8a9098' : CAR_COLORS[p.spr % CAR_COLORS.length]);
      solid.box(p.x - hx, 2, p.y - hz, p.x + hx, kind === 'truck' ? 30 : 11, p.y + hz, c);
      if (kind !== 'truck') solid.box(p.x - hx * (vert ? 0.85 : 0.5), 11, p.y - hz * (vert ? 0.5 : 0.85), p.x + hx * (vert ? 0.85 : 0.5), 18, p.y + hz * (vert ? 0.5 : 0.85), col('#14181e'));
    }
    for (const p of B.props) if (p.t === 'excavator') {
      solid.box(p.x - 12, 0, p.y - 10, p.x + 12, 14, p.y + 10, col('#c89515'));
      solid.box(p.x - 6, 14, p.y - 6, p.x + 6, 24, p.y + 6, col('#1a2430'));
    }
    const grp = new THREE.Group();
    if (!solid.empty()) grp.add(new THREE.Mesh(solid.build(), solidMat));
    if (!glow.empty()) grp.add(new THREE.Mesh(glow.build(), glowMatV));
    if (!glass.empty()) grp.add(new THREE.Mesh(glass.build(), glassMat));
    for (const c of cranes) grp.add(c.jib);
    scene.add(grp);
    return { grp, cranes };
  }

  function addBuilding(b, solid, glow, glass, cranes) {
    const h = b.height;
    const x0 = b.x, z0 = b.y, x1 = b.x + b.w, z1 = b.y + b.h;
    if (b.crane) {
      const cx = b.cx, cz = b.cy;
      const y = col('#c9a227');
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) solid.box(cx + sx * 6 - 1.5, 0, cz + sz * 6 - 1.5, cx + sx * 6 + 1.5, h, cz + sz * 6 + 1.5, y);
      for (let yy = 20; yy < h; yy += 24) solid.box(cx - 7, yy, cz - 7, cx + 7, yy + 2, cz + 7, y);
      const jib = new THREE.Group();
      jib.position.set(cx, h, cz);
      const c = b.crane;
      part(jib, lambert('#d8b030'), (c.len - c.back) / 2, 4, 0, c.len + c.back, 6, 8);
      part(jib, lambert('#555a60'), -c.back + 12, 0, 0, 24, 14, 18);
      part(jib, lambert('#c9a227'), 0, 8, 0, 16, 14, 16);
      part(jib, lambert('#8a6a3a'), c.len * 0.6, -60, 0, 18, 14, 18);
      part(jib, lambert('#333'), c.len * 0.6, -26, 0, 1, 54, 1);
      part(jib, glowMat('red', 3), c.len, 8, 0, 5, 5, 5);
      part(jib, glowMat('red', 3), 0, 18, 0, 5, 5, 5);
      cranes.push({ jib, c, seed: b.seed });
      return;
    }
    if (b.cyl) {
      // труба: квадратные кольца с красно-белыми полосами
      const r = b.w / 2;
      for (let y = 0, k = 0; y < h; y += 20, k++) {
        const top = y > h * 0.65;
        const cl = top ? col(k % 2 ? '#a83a2a' : '#c8c0b8') : col('#3a302c');
        solid.box(b.cx - r, y, b.cy - r, b.cx + r, Math.min(h, y + 20), b.cy + r, cl);
      }
      glow.cube(b.cx + r, h + 3, b.cy, 5, glowCol('red', 3));
      glow.cube(b.cx - r, h + 3, b.cy, 5, glowCol('red', 3));
      return;
    }
    if (b.skeleton) {
      const floors = Math.max(1, Math.round(h / b.floorH));
      const cc = col('#6a6a66'), sc = col('#7c7c76');
      const nx = Math.max(2, Math.round(b.w / 32)), nz = Math.max(2, Math.round(b.h / 32));
      for (let a = 0; a <= nx; a++) for (let c = 0; c <= nz; c++) {
        if (a > 0 && a < nx && c > 0 && c < nz && (a + c) % 2) continue;
        const x = x0 + (b.w * a) / nx, z = z0 + (b.h * c) / nz;
        solid.box(x - 2, 0, z - 2, x + 2, h, z + 2, cc);
      }
      for (let f = 1; f <= floors; f++) {
        const y = (h * f) / floors;
        const half = f === floors;
        solid.box(x0, y - 3, z0, half ? x0 + b.w * 0.55 : x1, y, z1, sc);
      }
      return;
    }
    if (b.glass) {
      const tint = { green: '#6aff9a', cyan: '#7ad8ff', purple: '#c08aff', silver: '#c8d4e8' }[b.glass];
      glass.box(x0, 0, z0, x1, h, z1, col(tint), col(tint), [0, 0, 1 / 48, 1 / 48]);
      // огни по рёбрам крыши
      const gc = glowCol('white', 2);
      for (let x = x0 + 4; x < x1 - 2; x += 14) { glow.cube(x, h + 1, z0, 2, gc); glow.cube(x, h + 1, z1, 2, gc); }
      for (let z = z0 + 4; z < z1 - 2; z += 14) { glow.cube(x0, h + 1, z, 2, gc); glow.cube(x1, h + 1, z, 2, gc); }
    } else {
      const wall = lighten(b.wall, '#3c4458', 0.35), roof = lighten(b.roof, '#4a5060', 0.25);
      const s = hashU(b.seed, 1, 2);
      const win = b.lit > 0 ? [((s % 32) * 2) / 64, (((s >>> 5) % 32) * 2) / 64, 1 / 7 / 64, 1 / 10 / 64] : null;
      solid.box(x0, 0, z0, x1, h, z1, wall, roof, win);
      // парапет
      solid.box(x0, h, z0, x1, h + 3, z0 + 2, roof); solid.box(x0, h, z1 - 2, x1, h + 3, z1, roof);
      solid.box(x0, h, z0, x0 + 2, h + 3, z1, roof); solid.box(x1 - 2, h, z0, x1, h + 3, z1, roof);
    }
    if (b.gable) {
      // ступенчатая воксельная крыша
      const rc = lighten(b.roof, '#6a5040', 0.3);
      const long = b.w > b.h;
      for (let k = 1; k <= 3; k++) {
        const t = k * 0.16;
        if (long) solid.box(x0, h + (k - 1) * 5, z0 + b.h * t, x1, h + k * 5, z1 - b.h * t, rc);
        else solid.box(x0 + b.w * t, h + (k - 1) * 5, z0, x1 - b.w * t, h + k * 5, z1, rc);
      }
    }
    for (const d of b.details) {
      if (d.t === 'r' && d.w > 3 && d.h > 3) solid.box(d.x, h, d.y, d.x + d.w, h + 6, d.y + d.h, lighten(d.c.startsWith('#') ? d.c : '#2a2c30', '#555a64', 0.4));
      else if (d.t === 'c') solid.box(d.x - d.r * 0.7, h, d.y - d.r * 0.7, d.x + d.r * 0.7, h + 4, d.y + d.r * 0.7, d.c === '#c9a04a' || d.c === '#f0d27a' ? col('#e0b040', 1.2) : lighten(d.c, '#444', 0.3));
      else if (d.t === 'ant') solid.box(d.x - 1, h, d.y - 1, d.x + 1, h + 30, d.y + 1, col('#6a6c70'));
    }
    if (b.style === 'mast') glow.box(x0 - 6, h, z0 - 6, x1 + 6, h + 6, z1 + 6, glowCol('white', 3), glowCol('white', 3), null, true);
    for (const gl of b.glows) {
      if (gl.c === 'red') glow.cube(gl.x, h + 4, gl.y, 5, glowCol('red', 3));
      else if (gl.r < 40) glow.cube(gl.x, h + 2, gl.y, 4, glowCol(gl.c, 2));
    }
    if (b.crown) {
      const c = glowCol(b.crown, 1.5);
      glow.box(x0, h + 2, z0, x1, h + 4, z0 + 1.5, c, c, null, true); glow.box(x0, h + 2, z1 - 1.5, x1, h + 4, z1, c, c, null, true);
      glow.box(x0, h + 2, z0, x0 + 1.5, h + 4, z1, c, c, null, true); glow.box(x1 - 1.5, h + 2, z0, x1, h + 4, z1, c, c, null, true);
    }
    if (b.style === 'canopy') glow.box(x0 + 4, h - 2, z0 + 4, x1 - 4, h - 1, z1 - 4, glowCol('white', 1.6), glowCol('white', 1.6), null, true);
  }
  function dropBlock(e) {
    scene.remove(e.grp);
    e.grp.traverse((o) => { if (o.geometry && o.geometry !== unitBox) o.geometry.dispose(); });
  }

  // ---------------------------------------------------------------- кадр
  let built = 0;
  function manage(T, budget) {
    // земля
    const need = [];
    const cx0 = Math.floor((T.x - CHUNK_R) / CS), cx1 = Math.floor((T.x + CHUNK_R) / CS);
    const cy0 = Math.floor((T.z - CHUNK_R * 1.2) / CS), cy1 = Math.floor((T.z + CHUNK_R * 0.6) / CS);
    const want = new Set();
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const key = cx + ',' + cy;
      want.add(key);
      if (!chunks.has(key)) need.push([cx, cy, Math.hypot((cx + 0.5) * CS - T.x, (cy + 0.5) * CS - T.z)]);
    }
    for (const [key, e] of chunks) if (!want.has(key)) { dropChunk(e); chunks.delete(key); }
    need.sort((a, b) => a[2] - b[2]);
    let left = budget;
    for (const [cx, cy] of need) {
      if (left-- <= 0) break;
      chunks.set(cx + ',' + cy, bakeChunk(buildChunkAt(cx, cy)));
      built++;
    }
    // кварталы
    const bneed = [];
    const bwant = new Set();
    for (let i = W.colAt(T.x - BLOCK_R); i <= W.colAt(T.x + BLOCK_R); i++) {
      for (let j = W.rowAt(T.z - BLOCK_R * 1.25); j <= W.rowAt(T.z + BLOCK_R * 0.55); j++) {
        const key = i + ',' + j;
        bwant.add(key);
        if (!blocks.has(key)) { const B = W.getBlock(i, j); bneed.push([B, Math.hypot(B.cx - T.x, B.cy - T.z)]); }
      }
    }
    for (const [key, e] of blocks) if (!bwant.has(key)) { dropBlock(e); blocks.delete(key); }
    bneed.sort((a, b) => a[1] - b[1]);
    left = budget + 1;
    for (const [B] of bneed) {
      if (left-- <= 0) break;
      blocks.set(B.i + ',' + B.j, buildBlock(B));
    }
    return need.length + bneed.length;
  }

  function syncCars(st) {
    const seen = new Set();
    for (const c of st.traffic) {
      let m = cars.get(c);
      if (!m) {
        m = carModel(c.kind, c.color);
        scene.add(m);
        cars.set(c, m);
      }
      m.position.set(c.x, 0, c.y);
      m.rotation.y = -c.a;
      const tm = c.brake ? glowMat('red', 3) : glowMat('red', 1);
      for (const t of m.userData.tail) t.material = tm;
      if (m.userData.bar) { const on = Math.sin(st.time * 14) > 0; m.userData.bar[0].visible = on; m.userData.bar[1].visible = !on; }
      seen.add(c);
    }
    for (const [c, m] of cars) if (!seen.has(c)) { scene.remove(m); cars.delete(c); }
    const P = st.player;
    if (!playerModel || playerGen !== P.gen) {
      if (playerModel) scene.remove(playerModel);
      playerModel = carModel('sport', '#d8262a', true); scene.add(playerModel); playerGen = P.gen;
    }
    applyDamage(playerModel, P);
    playerModel.position.set(P.x, 0, P.y);
    playerModel.rotation.y = -P.a;
    const tm = P.brake ? glowMat('red', 3.5) : glowMat('red', 1.2);
    for (const t of playerModel.userData.tail) t.material = tm;
  }

  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpS = new THREE.Vector3(1, 1, 1), tmpP = new THREE.Vector3();
  function syncPeds(st) {
    let n = 0;
    for (const p of st.peds) {
      if (n >= MAXP) break;
      if (p.down > 0) {
        tmpE.set(0, -p.a, Math.PI / 2);
        tmpQ.setFromEuler(tmpE);
        tmpP.set(p.x, 3, p.y); tmpM.compose(tmpP, tmpQ, tmpS); pedBody.setMatrixAt(n, tmpM);
        tmpP.set(p.x + Math.cos(p.a) * 9, 3, p.y + Math.sin(p.a) * 9); tmpM.compose(tmpP, tmpQ, tmpS); pedHead.setMatrixAt(n, tmpM);
      } else {
        tmpE.set(0, -p.a, 0);
        tmpQ.setFromEuler(tmpE);
        const bob = Math.abs(Math.sin(p.phase)) * 1.5;
        tmpP.set(p.x, 6 + bob, p.y); tmpM.compose(tmpP, tmpQ, tmpS); pedBody.setMatrixAt(n, tmpM);
        tmpP.set(p.x, 14.5 + bob, p.y); tmpM.compose(tmpP, tmpQ, tmpS); pedHead.setMatrixAt(n, tmpM);
      }
      pedBody.setColorAt(n, PED_COLS[p.col]);
      n++;
    }
    pedBody.count = pedHead.count = n;
    pedBody.instanceMatrix.needsUpdate = pedHead.instanceMatrix.needsUpdate = true;
    if (pedBody.instanceColor) pedBody.instanceColor.needsUpdate = true;
  }

  function syncTrains(st) {
    let n = 0;
    for (const t of st.trains) {
      if (!trainPool[n]) trainPool[n] = trainModel(t.cars, t.carL);
      const g = trainPool[n++];
      g.visible = true;
      // модель строится вдоль +z от головы; для поезда на юг переворачиваем
      if (t.dir > 0) { g.position.set(t.x, 0, t.hy); g.rotation.y = Math.PI; }
      else { g.position.set(t.x, 0, t.hy); g.rotation.y = 0; }
    }
    for (let k = n; k < trainPool.length; k++) trainPool[k].visible = false;
  }

  function syncRain(st) {
    const n = Math.min(MAXR, rain.drops.length);
    for (let k = 0; k < n; k++) {
      const d = rain.drops[k], o = k * 6;
      rainPos[o] = d.x; rainPos[o + 1] = d.h; rainPos[o + 2] = d.y;
      rainPos[o + 3] = d.x - 6; rainPos[o + 4] = d.h + 46; rainPos[o + 5] = d.y;
    }
    rainGeo.setDrawRange(0, n * 2);
    rainGeo.attributes.position.needsUpdate = true;
    rainLines.material.opacity = 0.28 * rain.k;
    rainLines.visible = n > 0;
  }

  let W0 = 0, H0 = 0;
  return {
    resize(w, h) {
      W0 = w; H0 = h;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloom.resolution.set(w / 2, h / 2);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    render(st, first) {
      const k = Math.min(st.W, st.H) / st.cam.z / 820;
      const T = { x: st.cam.x, z: st.cam.y };
      const pending = manage(T, first ? 400 : 2);
      camera.position.set(T.x, 820 * k, T.z + 620 * k);
      camera.lookAt(T.x, 0, T.z - 60 * k);
      scene.fog.near = 1500 * k; scene.fog.far = 3400 * k;
      for (const e of blocks.values()) for (const c of e.cranes) c.jib.rotation.y = -(c.c.a0 + st.time * c.c.speed);
      syncCars(st);
      syncPeds(st);
      syncTrains(st);
      syncRain(st);
      syncSkids(st);
      handleFx(st, st.dt);
      updateProbe(T);
      composer.render();
      return pending;
    },
    dispose() {
      for (const e of chunks.values()) dropChunk(e);
      for (const e of blocks.values()) dropBlock(e);
      chunks.clear(); blocks.clear();
      renderer.dispose();
    },
  };
}
