// Воксельный режим графики: тот же мир, физика и трафик, но всё строится из кубов в WebGL.
// Земля — запечённые ночные текстуры чанков, здания/деревья/машины — объёмные блоки, неон — с bloom.
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
// «ночной город» для отражений в зеркальных фасадах
function cityEnv() {
  const c = canvas(1024, 512), g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#020308'); sky.addColorStop(1, '#151b30');
  g.fillStyle = sky; g.fillRect(0, 0, 1024, 256);
  g.fillStyle = '#05060a'; g.fillRect(0, 256, 1024, 256);
  let s = 777;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let x = 0; x < 1024;) {
    const w = 12 + rnd() * 40, h = 20 + rnd() * 140;
    g.fillStyle = '#080a10'; g.fillRect(x, 256 - h, w, h + 2);
    for (let yy = 256 - h + 4; yy < 254; yy += 6) for (let xx = x + 3; xx < x + w - 3; xx += 5) {
      if (rnd() < 0.35) { g.fillStyle = rnd() < 0.7 ? '#ffcf80' : '#bfe0ff'; g.fillRect(xx, yy, 2, 2); }
    }
    x += w + 2;
  }
  // нижняя половина — «улицы внизу»: при взгляде сверху стены отражают именно её
  for (let k = 0; k < 14; k++) {
    const y = 262 + k * 17 + rnd() * 6;
    g.fillStyle = `rgba(255,${(150 + rnd() * 80) | 0},90,0.35)`; g.fillRect(0, y, 1024, 2);
  }
  for (let k = 0; k < 40; k++) { g.fillStyle = 'rgba(200,220,255,0.3)'; g.fillRect(rnd() * 1024, 256, 2, 256); }
  for (let k = 0; k < 900; k++) {
    g.fillStyle = ['#ffffff', '#ffd090', '#ffb060', '#c080ff', '#60e0ff', '#ff4060', '#80ff9a'][(rnd() * 7) | 0];
    const s2 = 2 + rnd() * 3;
    g.fillRect(rnd() * 1024, 258 + rnd() * 250, s2, s2);
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
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
function carModel(kind, color, isPlayer = false) {
  const [L, Wd] = CAR_DIM[kind] || CAR_DIM.sedan;
  const g = new THREE.Group();
  const body = lambert(color);
  const dark = lambert('#14181e');
  const tall = kind === 'bus' || kind === 'truck';
  if (kind === 'truck') {
    part(g, lambert(color), -L * 0.15, 17, 0, L * 0.7, 28, Wd);
    part(g, lambert('#d8d8d0'), L * 0.36, 13, 0, L * 0.27, 20, Wd - 2);
    part(g, dark, L * 0.48, 17, 0, 2, 8, Wd - 6);
  } else if (kind === 'bus') {
    part(g, body, 0, 16, 0, L, 26, Wd);
    part(g, glowMat('warm', 0.9), 0, 20, Wd / 2 + 0.3, L * 0.85, 6, 0.6);
    part(g, glowMat('warm', 0.9), 0, 20, -Wd / 2 - 0.3, L * 0.85, 6, 0.6);
  } else {
    part(g, body, 0, 8, 0, L, 9, Wd);
    const cab = kind === 'van' ? [L * 0.75, -L * 0.08] : kind === 'hatch' ? [L * 0.55, -L * 0.1] : [L * 0.48, -L * 0.04];
    part(g, dark, cab[1], 16, 0, cab[0], 7, Wd - 3);
    part(g, body, cab[1], 20, 0, cab[0] - 6, 1.5, Wd - 5);
    if (kind === 'taxi') { part(g, glowMat('yellow', 1.4), cab[1], 23, 0, 6, 3, 10); }
    if (kind === 'police') { g.userData.bar = [part(g, glowMat('red', 3), cab[1], 22.5, -4, 4, 2.5, 7), part(g, glowMat('blue', 3), cab[1], 22.5, 4, 4, 2.5, 7)]; }
    if (isPlayer) { part(g, lambert('#f2f2f2'), 0, 12.8, -3, L - 2, 0.6, 2); part(g, lambert('#f2f2f2'), 0, 12.8, 3, L - 2, 0.6, 2); }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) part(g, lambert('#0a0a0c'), sx * L * 0.32, 4, sz * (Wd / 2), 9, 8, 3);
  const hy = tall ? 8 : 8;
  part(g, glowMat('white', 2.5), L / 2 + 0.3, hy, -Wd / 2 + 4, 1, 3, 4);
  part(g, glowMat('white', 2.5), L / 2 + 0.3, hy, Wd / 2 - 4, 1, 3, 4);
  g.userData.tail = [part(g, glowMat('red', 1), -L / 2 - 0.3, hy, -Wd / 2 + 4, 1, 3, 4), part(g, glowMat('red', 1), -L / 2 - 0.3, hy, Wd / 2 - 4, 1, 3, 4)];
  // пятно света от фар на асфальте
  if (!coneTex) { coneTex = new THREE.CanvasTexture(S.coneGlow); coneTex.colorSpace = THREE.SRGBColorSpace; }
  const len = isPlayer ? 300 : 190;
  const cone = new THREE.Mesh(new THREE.PlaneGeometry(len, len * 0.72), new THREE.MeshBasicMaterial({
    map: coneTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: isPlayer ? 0.55 : 0.3, toneMapped: false,
  }));
  cone.rotation.x = -Math.PI / 2;
  cone.position.set(L / 2 + len / 2 - 4, 1.2, 0);
  g.add(cone);
  g.userData.L = L;
  return g;
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
  const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 0.04, envMap: cityEnv(), envMapIntensity: 2.6, map: mullionTex() });

  const chunks = new Map();
  const blocks = new Map();
  const cars = new Map();
  let playerModel = null;

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
    const near = [...lamps].filter((l) => l.lx + l.r > x0 && l.lx - l.r < x0 + CS && l.ly + l.r > y0 && l.ly - l.r < y0 + CS);
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
      const R = (rx, ry, rw, rh) => g.fillRect((rx - x0) * k, (ry - y0) * k, rw * k, rh * k);
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
        const kind = c.police ? 'police' : c.spr === S.taxi ? 'taxi' : c.spr === S.bus ? 'bus' : S.trucks.includes(c.spr) ? 'truck' : 'sedan';
        const color = kind === 'taxi' ? '#e8b81c' : kind === 'police' ? '#e8e8ee' : kind === 'bus' ? '#d0d4d8' : kind === 'truck' ? '#9aa0a8' : CAR_COLORS[(hashU(c.cruise * 1000 | 0, 3, 4)) % CAR_COLORS.length];
        m = carModel(kind, color);
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
    if (!playerModel) { playerModel = carModel('sport', '#d8262a', true); scene.add(playerModel); }
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
