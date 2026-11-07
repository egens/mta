// Воксельная графика на WebGL: город из кубов. Земля — запечённые ночные текстуры чанков,
// здания/деревья/машины — объёмные блоки, неон — с bloom.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as W from './world.js';
import { CS, buildChunkAt, peekChunk, releaseCanvas } from './chunks.js';
import { signalState } from './traffic.js';
import { S, LIGHT_RGB, CAR_COLORS, CAR_DIM } from './sprites.js';
import { rain } from './rain.js';
import { hashU } from './util.js';

const FOG = 0x2a0d3c;     // кислотная дымка у земли
const CHUNK_R = 2400;     // радиус подгрузки земли
const BLOCK_R = 2400;     // радиус подгрузки кварталов
const FOG_FAR = 2600;     // дальше — только силуэты мегабашен на горизонте
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
  tri(a, b, c, n, cl) {
    for (const q of [a, b, c]) { this.p.push(q[0], q[1], q[2]); this.n.push(n[0], n[1], n[2]); this.c.push(cl.r, cl.g, cl.b); this.u.push(DARK_UV, DARK_UV); }
    this.i.push(this.v, this.v + 1, this.v + 2);
    this.v += 3;
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
      if (floorDark || rnd() > 0.32) { g.fillStyle = '#07090c'; g.fillRect(x, y, 1, 1); continue; }
      const k = rnd();
      g.fillStyle = k < 0.36 ? '#ffd2a0' : k < 0.62 ? '#8ee8ff' : k < 0.8 ? '#ff6ad2' : k < 0.92 ? '#b48aff' : '#f4f4ff';
      g.fillRect(x, y, 1, 1);
    }
  }
  return pixelTex(c);
}
// Атлас для дальних мегабашен: тёмные стены (не чёрные — их тонирует дымка) и редкие окна
function skylineAtlas() {
  const c = canvas(64, 64), g = c.getContext('2d');
  g.fillStyle = '#1c1a24'; g.fillRect(0, 0, 64, 64);
  let s = 777;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 1; y < 64; y += 2) for (let x = 1; x < 64; x += 2) {
    if (rnd() > 0.3) continue;
    const k = rnd();
    g.fillStyle = k < 0.4 ? '#ffc890' : k < 0.7 ? '#70e0ff' : k < 0.88 ? '#ff5ad0' : '#ffffff';
    g.fillRect(x, y, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}
// Рекламные голограммы: 2×4 вывески на одном атласе
const ADS = [
  ['РАМЕН 24/7', '#ff3fa0'], ['ИМПЛАНТЫ', '#3ef2ff'], ['НЕО·БАНК', '#ffd23a'], ['КИБЕРДОК', '#7aff6a'],
  ['ГОЛО·ТВ', '#b46aff'], ['СИНТ·ЕДА', '#ff7a2a'], ['ОТЕЛЬ', '#ff3f5a'], ['РОБОТАКСИ', '#3a9aff'],
];
function adAtlas() {
  const c = canvas(512, 512), g = c.getContext('2d');
  ADS.forEach(([text, color], k) => {
    const x = (k % 2) * 256, y = ((k / 2) | 0) * 128;
    g.save();
    g.beginPath(); g.rect(x + 6, y + 6, 244, 116); g.clip();
    g.fillStyle = 'rgba(10,4,24,0.85)'; g.fillRect(x, y, 256, 128);
    g.strokeStyle = color; g.lineWidth = 4; g.shadowColor = color; g.shadowBlur = 14;
    g.strokeRect(x + 10, y + 10, 236, 108);
    for (let l = y + 14; l < y + 120; l += 4) { g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(x, l, 256, 1); }
    g.fillStyle = '#ffffff'; g.font = 'bold 34px "Trebuchet MS", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowBlur = 18; g.fillText(text, x + 128, y + 58);
    g.fillStyle = color; g.font = 'bold 14px monospace'; g.shadowBlur = 6;
    g.fillText('— 2087 —', x + 128, y + 96);
    g.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
  const body = isPlayer ? new THREE.MeshPhongMaterial({ color, specular: 0x8a8f98, shininess: 70 }) : lambert(color);
  const dark = lambert('#14181e');
  const tall = kind === 'bus' || kind === 'truck' || kind === 'dump' || kind === 'mixer';
  const P = {};
  if (kind === 'truck') {
    P.rear = part(g, body, -L * 0.15, 17, 0, L * 0.7, 28, Wd);
    P.front = part(g, lambert('#d8d8d0'), L * 0.36, 13, 0, L * 0.27, 20, Wd - 2);
    part(g, dark, L * 0.48, 17, 0, 2, 8, Wd - 6);
  } else if (kind === 'bus') {
    P.mid = part(g, body, 0, 16, 0, L, 26, Wd);
    const stripe = lambert(color === '#e4e6e8' ? '#2a62c8' : '#f2f2f2');
    for (const sd of [-1, 1]) {
      part(g, dark, 0, 20, sd * (Wd / 2 + 0.2), L * 0.9, 9, 0.6);
      part(g, glowMat('warm', 0.9), 0, 20.5, sd * (Wd / 2 + 0.3), L * 0.85, 6, 0.6);
      part(g, stripe, 0, 10, sd * (Wd / 2 + 0.25), L, 3, 0.5);
    }
    for (const dx of [0.32, -0.02, -0.34]) part(g, lambert('#1a1e24'), dx * L, 14, Wd / 2 + 0.45, 7, 19, 0.5);
    part(g, dark, L / 2 + 0.2, 18, 0, 0.6, 12, Wd - 4);
    part(g, glowMat('orange', 1.8), L / 2 + 0.5, 26, 0, 0.6, 3, Wd * 0.6);
    part(g, lambert('#b8bcc0'), -L * 0.1, 30, 0, L * 0.3, 3, Wd * 0.6);
  } else if (kind === 'dump' || kind === 'mixer') {
    P.front = part(g, body, L * 0.36, 14, 0, L * 0.28, 22, Wd);
    part(g, dark, L * 0.5 + 0.2, 19, 0, 0.6, 8, Wd - 4);
    part(g, dark, -L * 0.15, 7, 0, L * 0.66, 5, Wd - 4);
    if (kind === 'dump') {
      P.rear = part(g, lambert('#5a5e64'), -L * 0.15, 15, 0, L * 0.66, 13, Wd);
      part(g, lambert('#6a5a48'), -L * 0.15, 22, 0, L * 0.6, 2, Wd - 4);
    } else {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, L * 0.55, 10), lambert('#d8d8d0'));
      drum.rotation.z = Math.PI / 2 + 0.12;
      drum.position.set(-L * 0.17, 19, 0);
      for (let k = 0; k < 3; k++) {
        const fin = new THREE.Mesh(unitBox, lambert(color));
        const an = (k / 3) * Math.PI * 2;
        fin.position.set(Math.cos(an) * 10.5, 0, Math.sin(an) * 10.5); fin.scale.set(3, L * 0.5, 3);
        drum.add(fin);
      }
      g.add(drum);
      g.userData.spin = drum;
    }
    g.userData.beacon = [part(g, glowMat('orange', 3), L * 0.36, 26.5, 0, 4, 3, 5)];
  } else if (kind === 'roller') {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, Wd, 12), lambert('#5a5e64'));
    drum.rotation.x = Math.PI / 2; drum.position.set(L * 0.3, 9, 0);
    g.add(drum);
    P.mid = part(g, body, -L * 0.12, 12, 0, L * 0.5, 12, Wd - 4);
    part(g, dark, -L * 0.15, 21, 0, L * 0.25, 6, Wd - 8);
    for (const sd of [-1, 1]) part(g, dark, -L * 0.15, 26, sd * (Wd / 2 - 2), 1.5, 12, 1.5);
    part(g, body, -L * 0.15, 32, 0, L * 0.4, 1.5, Wd - 2);
    g.userData.beacon = [part(g, glowMat('orange', 3), -L * 0.15, 34, 0, 4, 3, 4)];
  } else if (kind === 'delorean') {
    // клиновидное купе из нержавейки: низкий острый нос, плоская крыша с «крыльями чайки»,
    // жалюзи на заднем стекле, чёрный молдинг по бокам и неоновая подсветка днища
    const seg = L / 3, steel = body;
    const blk = lambert('#101114'), glass = lambert('#0b0f16');
    P.mid = part(g, steel, 0, 8, 0, seg + 0.2, 7, Wd);
    P.front = part(g, steel, seg, 7, 0, seg, 5, Wd - 0.4); P.front.rotation.z = -0.1;
    P.rear = part(g, steel, -seg, 8.5, 0, seg, 7, Wd);
    part(g, blk, 0, 4.8, 0, L - 1, 2, Wd + 0.3);                          // чёрный низ кузова
    for (const sd of [-1, 1]) {
      part(g, blk, 0, 8.2, sd * (Wd / 2 + 0.15), L - 4, 1.4, 0.4);         // молдинг
      part(g, blk, -2, 17.1, sd * (Wd / 2 - 4.2), L * 0.3, 0.5, 0.5);     // шов двери-крыла
    }
    P.cabin = part(g, glass, -2, 14.2, 0, L * 0.34, 5.4, Wd - 3);
    const ws = part(g, glass, L * 0.17, 13.4, 0, 8.5, 0.8, Wd - 3.4); ws.rotation.z = -0.62;   // лобовое
    P.roof = part(g, steel, -2.5, 17.2, 0, L * 0.27, 1.2, Wd - 5);
    for (let k = 0; k < 5; k++) {                                          // жалюзи
      const sl = part(g, blk, -L * 0.2 - k * 1.9, 15.6 - k * 0.95, 0, 1, 0.7, Wd - 5); sl.rotation.z = 0.5;
    }
    part(g, blk, -L / 2 - 0.2, 8.5, 0, 0.5, 4, Wd - 9);                     // задняя решётка
    part(g, blk, L / 2 + 0.1, 6.2, 0, 0.5, 2.4, Wd - 2);                    // бампер-решётка
    part(g, glowMat('cyan', 0.55), 0, 0.5, 0, L * 0.7, 0.3, Wd * 0.7);      // подсветка днища
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
  if (kind === 'delorean') {
    g.userData.heads = [-1, 1].map((sd) => part(g, glowMat('white', 2.5), L / 2 + 0.3, 8.4, sd * (Wd / 2 - 4.5), 1, 2.2, 6.5));
    g.userData.tail = [-1, 1].map((sd) => part(g, glowMat('red', 1), -L / 2 - 0.3, 9.5, sd * (Wd / 2 - 3.2), 1, 3, 6));
  } else {
    g.userData.heads = [part(g, glowMat('white', 2.5), L / 2 + 0.3, 8, -Wd / 2 + 4, 1, 3, 4), part(g, glowMat('white', 2.5), L / 2 + 0.3, 8, Wd / 2 - 4, 1, 3, 4)];
    g.userData.tail = [part(g, glowMat('red', 1), -L / 2 - 0.3, 8, -Wd / 2 + 4, 1, 3, 4), part(g, glowMat('red', 1), -L / 2 - 0.3, 8, Wd / 2 - 4, 1, 3, 4)];
  }
  if (!coneTex) { coneTex = new THREE.CanvasTexture(S.coneGlow); coneTex.colorSpace = THREE.SRGBColorSpace; }
  // по лучу от каждой фары
  const len = isPlayer ? 290 : 180;
  const coneMat = new THREE.MeshBasicMaterial({
    map: coneTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: isPlayer ? 0.32 : 0.18, toneMapped: false,
  });
  const coneGeo = new THREE.PlaneGeometry(len, len * 0.46);
  g.userData.cones = [-1, 1].map((sd) => {
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(L / 2 + len / 2 - 4, 1.2, sd * (Wd / 2 - 4));
    g.add(cone);
    return cone;
  });
  g.userData.isCone = new Set(g.userData.cones);
  g.userData.parts = P;
  g.userData.body = body;
  g.userData.baseColor = new THREE.Color(color);
  g.userData.L = L; g.userData.W = Wd;
  // исходные положения частей для модели повреждений
  g.userData.base = new Map();
  g.traverse((o) => { if (o !== g) g.userData.base.set(o, { p: o.position.clone(), s: o.scale.clone(), r: o.rotation.clone() }); });
  return g;
}

// Экскаватор для ремонта дороги: гусеницы, поворотная башня, стрела с ковшом
// светоотражающие и подсвеченные прожекторами поверхности на ремонте
function emiss(hex, k) {
  const key = 'e' + hex + k;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshLambertMaterial({ color: hex, emissive: hex, emissiveIntensity: k }); matCache.set(key, m); }
  return m;
}
function excavatorModel(color) {
  const g = new THREE.Group();
  const body = emiss(color, 0.3), dark = lambert('#14181e'), steel = lambert('#3a3e44');
  for (const sd of [-1, 1]) part(g, dark, 0, 4, sd * 9.5, 48, 8, 7);
  const tur = new THREE.Group(); tur.position.y = 8; g.add(tur);
  part(tur, body, -3, 7, 0, 32, 10, 24);
  part(tur, steel, -19, 8, 0, 6, 11, 24);
  part(tur, body, 7, 17, -6, 12, 14, 11);
  part(tur, dark, 13.3, 18, -6, 0.6, 8, 9);
  const beacon = part(tur, glowMat('orange', 3), 7, 25.5, -6, 3, 2.5, 3);
  const boom = new THREE.Group(); boom.position.set(10, 12, 5); tur.add(boom);
  part(boom, body, 17, 0, 0, 34, 5, 5);
  const arm = new THREE.Group(); arm.position.set(33, 0, 0); boom.add(arm);
  part(arm, body, 12, 0, 0, 24, 4, 4);
  const bucket = new THREE.Group(); bucket.position.set(24, 0, 0); arm.add(bucket);
  part(bucket, steel, 3, -2, 0, 7, 7, 9);
  g.userData = { tur, boom, arm, bucket, beacon: [beacon] };
  return g;
}
// Красно-белая полосатая текстура для щитов ограждения
let stripeTex = null;
function stripeMat() {
  if (!stripeTex) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 64, 16);
    g.fillStyle = '#d42a22';
    for (let x = -16; x < 64; x += 16) { g.beginPath(); g.moveTo(x, 16); g.lineTo(x + 8, 16); g.lineTo(x + 16, 0); g.lineTo(x + 8, 0); g.fill(); }
    stripeTex = pixelTex(c);
  }
  return new THREE.MeshLambertMaterial({ map: stripeTex, emissive: '#3a1a18' });
}

// Деформация по зонам повреждений игрока
const scorch = new THREE.Color('#161414');
function applyDamage(m, P) {
  const { parts: Q, base, L, W: Wd } = m.userData;
  const d = P.dmg;
  for (const [o, b] of base) { o.position.copy(b.p); o.scale.copy(b.s); o.rotation.copy(b.r); }
  const seg = L / 3;
  if (Q.front) {
    const k = d.front * 0.5;
    Q.front.scale.x *= 1 - k; Q.front.position.x -= (seg * k) / 2; Q.front.rotation.z += -0.25 * d.front; Q.front.position.y += 1.5 * d.front;
  }
  if (Q.rear) {
    const k = d.rear * 0.45;
    Q.rear.scale.x *= 1 - k; Q.rear.position.x += (seg * k) / 2; Q.rear.rotation.z += 0.2 * d.rear;
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
  m.userData.cones[0].visible = hl.visible;
  m.userData.cones[1].visible = hr.visible;
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
  scene.background = new THREE.Color(FOG);
  scene.fog = new THREE.Fog(FOG, 300, FOG_FAR);
  const camera = new THREE.PerspectiveCamera(62, 1, 4, 11000);
  scene.add(new THREE.HemisphereLight(0x8a5ac8, 0x100818, 0.6));
  const moon = new THREE.DirectionalLight(0x6ad8ff, 0.4);
  moon.position.set(-0.6, 1, 0.8);
  scene.add(moon);
  // небо: купол от светящейся дымки у горизонта к чёрному зениту, идёт за камерой
  const sky = (() => {
    const geo = new THREE.SphereGeometry(10000, 32, 20);
    const pos = geo.attributes.position, cs = [];
    const top = new THREE.Color('#020108'), mid = new THREE.Color('#180826'), hor = new THREE.Color('#5c1a60'), low = new THREE.Color(FOG);
    const c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      const h = pos.getY(k) / 10000;
      if (h < 0) c.copy(low);
      else if (h < 0.08) c.copy(hor).lerp(mid, h / 0.08);
      else c.copy(mid).lerp(top, Math.min(1, (h - 0.08) / 0.5));
      cs.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.renderOrder = -10; m.frustumCulled = false;
    scene.add(m);
    return m;
  })();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.5, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const atlas = windowAtlas();
  const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveMap: atlas, emissiveIntensity: 1.2 });
  const glowMatV = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  // тонированное стекло без отражений: стыки панелей и слабый свет изнутри
  const glassMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: mullionTex(), emissive: 0x0d1a22 });
  // стёкла вестибюлей — полупрозрачные
  const paneMat = new THREE.MeshLambertMaterial({ color: 0x9fd8ff, emissive: 0x3a5a6a, transparent: true, opacity: 0.38, depthWrite: false });
  const holoMat = new THREE.MeshBasicMaterial({ map: adAtlas(), color: new THREE.Color(1.5, 1.5, 1.5), transparent: true, opacity: 0.92,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const solidMat2 = solidMat.clone();
  solidMat2.side = THREE.DoubleSide;

  const chunks = new Map();
  const blocks = new Map();
  const cars = new Map();
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpS = new THREE.Vector3(1, 1, 1), tmpP = new THREE.Vector3();
  let playerModel = null, playerGen = -1, playerCol = null;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(50, 26), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }));
  scene.add(shadow);
  // светофоры: столбы — отдельные меши, огни — один инстанс на все
  const signals = new Map();
  const MAXS = 2400;
  const sigMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), MAXS);
  sigMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sigMesh.frustumCulled = false;
  sigMesh.count = 0;
  scene.add(sigMesh);
  const sc = (h, k = 1) => new THREE.Color(h).multiplyScalar(k);
  const SIG = { red: sc('#ff2a1a', 3), yellow: sc('#ffc020', 3), green: sc('#30ff70', 3), off: sc('#141414') };
  function buildSignal(i, j) {
    const x = W.roadX(i), y = W.roadY(j);
    const hw = W.widthX(i) / 2, hh = W.widthY(j) / 2;
    if (W.riverDist(x, y) < 80) return { heads: [], mesh: null };
    // [x, z, ось движения, куда смотрит (dx, dz)]
    const heads = [
      [x - hw - 7, y + hh + 7, 'h', -1, 0], [x + hw + 7, y - hh - 7, 'h', 1, 0],
      [x - hw - 7, y - hh - 7, 'v', 0, -1], [x + hw + 7, y + hh + 7, 'v', 0, 1],
    ];
    const g = new Geo(), pc = col('#30333a');
    for (const [px, pz] of heads) {
      g.box(px - 1.5, 0, pz - 1.5, px + 1.5, 46, pz + 1.5, pc);
      g.box(px - 3.5, 32, pz - 3.5, px + 3.5, 48, pz + 3.5, col('#15171b'));
    }
    const mesh = new THREE.Mesh(g.build(), solidMat);
    scene.add(mesh);
    return { i, j, heads, mesh };
  }
  function syncSignals(st, T) {
    const want = new Set();
    for (let i = W.colAt(T.x - 1700); i <= W.colAt(T.x + 1700) + 1; i++) {
      for (let j = W.rowAt(T.z - 1700); j <= W.rowAt(T.z + 1700) + 1; j++) {
        const key = i + ',' + j;
        want.add(key);
        if (!signals.has(key)) signals.set(key, buildSignal(i, j));
      }
    }
    for (const [key, e] of signals) if (!want.has(key)) { if (e.mesh) { scene.remove(e.mesh); e.mesh.geometry.dispose(); } signals.delete(key); }
    let n = 0;
    for (const e of signals.values()) {
      if (!e.heads.length) continue;
      const sst = signalState(e.i, e.j, st.time);
      for (const [px, pz, ax, dx, dz] of e.heads) {
        const go = ax === 'h' ? sst === 0 : sst === 2, amber = ax === 'h' ? sst === 1 : sst === 3;
        const cols = [!go && !amber ? SIG.red : SIG.off, amber ? SIG.yellow : SIG.off, go ? SIG.green : SIG.off];
        for (let k = 0; k < 3; k++) {
          if (n >= MAXS) break;
          tmpP.set(px + dx * 4, 44 - k * 5.2, pz + dz * 4);
          tmpS.set(4.2, 4.2, 4.2);
          tmpM.compose(tmpP, tmpQ.identity(), tmpS);
          sigMesh.setMatrixAt(n, tmpM);
          sigMesh.setColorAt(n, cols[k]);
          n++;
        }
      }
    }
    tmpS.set(1, 1, 1);
    sigMesh.count = n;
    sigMesh.instanceMatrix.needsUpdate = true;
    if (sigMesh.instanceColor) sigMesh.instanceColor.needsUpdate = true;
  }
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
      if (l.lx + l.r < e.x0 || l.lx - l.r > e.x0 + e.size || l.ly + l.r < e.y0 || l.ly - l.r > e.y0 + e.size) continue;
      const ne = e.rebake();
      if (!ne) continue;
      chunks.set(key, ne);
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
      const [x0, y0, x1, y1, zz] = st.skids[off + k];
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
      const px = (-dy / l) * 1.8, py = (dx / l) * 1.8, h = (zz || 0) + 0.5;
      skidPos.set([x0 + px, h, y0 + py, x0 - px, h, y0 - py, x1 + px, h, y1 + py, x1 - px, h, y1 - py], k * 12);
    }
    skidGeo.setDrawRange(0, n * 6);
    skidGeo.attributes.position.needsUpdate = true;
  }
  function handleFx(st, dt) {
    for (const f of st.fx) {
      if (f.type === 'sparks') sparks(f.x, 10, f.y, f.n);
      else if (f.type === 'debris') debris(f.x, f.y, f.color, f.n);
      else if (f.type === 'lamp') dropLamp(f.lamp);
      else if (f.type === 'pane') breakPane(f.pane);
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
  function bakeChunk(ch) {
    const x0 = ch.cx * CS, y0 = ch.cy * CS;
    // свет: фонари этого чанка, соседних и всех кварталов вокруг
    const lamps = new Set(ch.lamps);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const n = (dx || dy) && peekChunk(ch.cx + dx, ch.cy + dy);
      if (n) for (const l of n.lamps) lamps.add(l);
    }
    for (let i = W.colAt(x0 - 260); i <= W.colAt(x0 + CS + 260); i++) for (let j = W.rowAt(y0 - 260); j <= W.rowAt(y0 + CS + 260); j++) {
      for (const l of W.getBlock(i, j).lamps) lamps.add(l);
    }
    const e = bakeGround(ch.canvas, x0, y0, CS, TEX, lamps, ch.lamps, procZebras);
    addRiverBed(e.grp, x0, y0, CS);
    releaseCanvas(ch);
    e.rebake = () => bakeChunk(buildChunkAt(ch.cx, ch.cy));
    return e;
  }
  // Русло реки ниже уровня улиц: бетонные стенки набережной и тёмная вода с отсветами неона
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x07121f, emissive: 0x0a0618 });
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x4a4a58, emissive: 0x16121e, side: THREE.DoubleSide });
  function addRiverBed(grp, x0, y0, size) {
    const g = new Geo(), wc = col('#ffffff');
    let any = false;
    const D = W.RIVER_D + 4;
    for (let m = Math.floor((y0 - 1500) / W.RP); m <= Math.floor((y0 + size + 1500) / W.RP); m++) {
      if (!W.riverExists(m)) continue;
      for (let x = x0; x < x0 + size; x += 16) {
        const xb = x + 16;
        for (const side of [-1, 1]) {
          const ya = W.riverY(m, x) + side * W.riverHV(m, x), yb = W.riverY(m, xb) + side * W.riverHV(m, xb);
          const ym = (ya + yb) / 2;
          if (ym < y0 - 8 || ym >= y0 + size + 8) continue;
          any = true;
          g.quad([x, 0.5, ya], [x, -D, ya], [xb, -D, yb], [xb, 0.5, yb], [0, 0, -side], wc);
        }
      }
    }
    if (!any) return;
    grp.add(new THREE.Mesh(g.build(), wallMat));
    const water = new THREE.Mesh(new THREE.PlaneGeometry(size, size), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(x0 + size / 2, -W.RIVER_D + 6, y0 + size / 2);
    grp.add(water);
    // отражения неоновых вывесок — длинные размытые блики на воде
    const gl = new Geo();
    for (let k = 0; k < 40; k++) {
      const x = x0 + hashU(x0, y0, k) % size, z = y0 + hashU(x0, y0, k + 99) % size;
      if (!W.isRiver(x, z)) continue;
      const c = glowCol(['pink', 'cyan', 'purple', 'yellow'][k % 4], 0.7);
      gl.box(x - 1.5, -W.RIVER_D + 6.2, z - 14 - (k % 3) * 8, x + 1.5, -W.RIVER_D + 6.4, z + 14 + (k % 3) * 8, c, c);
    }
    if (!gl.empty()) grp.add(new THREE.Mesh(gl.build(), glowMatV));
  }
  function procZebras(g, x0, y0, k) {
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
      const up = W.vSegExists(i, j - 1), dn = W.vSegExists(i, j), lf = W.hSegExists(i - 1, j), rt = W.hSegExists(i, j);
      for (let u = -hw + 5; u < hw - 8; u += 11) { if (up) R(x + u, y - hh - 22, 6, 18); if (dn) R(x + u, y + hh + 4, 6, 18); }
      for (let u = -hh + 5; u < hh - 8; u += 11) { if (lf) R(x - hw - 22, y + u, 18, 6); if (rt) R(x + hw + 4, y + u, 18, 6); }
    }
  }
  // Ночная текстура куска земли: исходник × темнота − пятна фонарей + цветное свечение.
  // allLamps — все фонари, чей свет может попасть сюда; poles — фонари, чьи столбы стоят в этом куске.
  const darkCv = {};
  function bakeGround(src, x0, y0, size, texN, allLamps, poles, extra) {
    const k = texN / size;
    const c = canvas(texN, texN), g = c.getContext('2d');
    g.drawImage(src, 0, 0, texN, texN);
    let dk = darkCv[texN];
    if (!dk) { const cv = canvas(texN, texN); dk = darkCv[texN] = { cv, g: cv.getContext('2d') }; }
    const dg = dk.g;
    const near = [...allLamps].filter((l) => !l.broken && !l.dead && l.lx + l.r > x0 && l.lx - l.r < x0 + size && l.ly + l.r > y0 && l.ly - l.r < y0 + size);
    dg.globalCompositeOperation = 'source-over';
    dg.globalAlpha = 1;
    dg.clearRect(0, 0, texN, texN);
    dg.fillStyle = 'rgba(1,2,8,0.9)';
    dg.fillRect(0, 0, texN, texN);
    dg.globalCompositeOperation = 'destination-out';
    for (const l of near) {
      const r = l.r * k;
      dg.globalAlpha = Math.min(1, l.i * (l.dot ? 0.7 : 0.85));
      dg.drawImage(S.mask, (l.lx - x0) * k - r, (l.ly - y0) * k - r, r * 2, r * 2);
    }
    g.drawImage(dk.cv, 0, 0);
    g.globalCompositeOperation = 'lighter';
    for (const l of near) {
      const spr = S.glow[l.c] || S.glow.white;
      const r = (l.dot ? 14 : l.r * 0.95) * k;
      g.globalAlpha = Math.min(1, l.i * (l.dot ? 0.5 : l.c === 'sodium' ? 0.2 : l.c === 'white' ? 0.09 : 0.24));
      g.drawImage(spr, (l.lx - x0) * k - r, (l.ly - y0) * k - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
    if (extra) extra(g, x0, y0, k);
    // вырезы (русла рек) остаются прозрачными после затемнения и подсветки
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(src, 0, 0, texN, texN);
    g.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;
    const grp = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(x0 + size / 2, 0, y0 + size / 2);
    grp.add(ground);
    // столбы и светящиеся головы фонарей
    const solid = new Geo(), glow = new Geo();
    const poleC = col('#4a4e56');
    for (const l of poles) {
      if (l.broken || l.dead) continue;
      if (l.dot) { glow.cube(l.lx, 9, l.ly, 3.5, glowCol(l.c, 2.4)); continue; }
      if (!l.pole) continue;
      solid.box(l.x - 1.5, 0, l.y - 1.5, l.x + 1.5, 56, l.y + 1.5, poleC);
      const ax = Math.abs(l.lx - l.x) < 1, az = Math.abs(l.ly - l.y) < 1;
      if (ax !== az) solid.box(Math.min(l.x, l.lx) - 1, 54, Math.min(l.y, l.ly) - 1, Math.max(l.x, l.lx) + 1, 56, Math.max(l.y, l.ly) + 1, poleC);
      glow.box(l.lx - 5, 51, l.ly - 3, l.lx + 5, 54, l.ly + 3, glowCol(l.c, 1.9), glowCol(l.c, 1.9), null, true);
    }
    if (!solid.empty()) grp.add(new THREE.Mesh(solid.build(), solidMat));
    if (!glow.empty()) grp.add(new THREE.Mesh(glow.build(), glowMatV));
    scene.add(grp);
    return { grp, tex, x0, y0, size };
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
    const solid = new Geo(), glow = new Geo(), glass = new Geo(), bill = new Geo();
    const cranes = [];
    for (const b of B.buildings) addBuilding(b, solid, glow, glass, cranes, bill);
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
      const pz = p.z || 0;
      solid.box(p.x - hx, pz + 2, p.y - hz, p.x + hx, pz + (kind === 'truck' ? 30 : 11), p.y + hz, c);
      if (kind !== 'truck') solid.box(p.x - hx * (vert ? 0.85 : 0.5), pz + 11, p.y - hz * (vert ? 0.5 : 0.85), p.x + hx * (vert ? 0.85 : 0.5), pz + 18, p.y + hz * (vert ? 0.5 : 0.85), col('#14181e'));
    }
    for (const p of B.props) if (p.t === 'excavator') {
      solid.box(p.x - 12, 0, p.y - 10, p.x + 12, 14, p.y + 10, col('#c89515'));
      solid.box(p.x - 6, 14, p.y - 6, p.x + 6, 24, p.y + 6, col('#1a2430'));
    }
    const wedge = new Geo();
    for (const gr of B.garages) addGarage(gr, solid, glow, wedge, B);
    const grp = new THREE.Group();
    if (!solid.empty()) grp.add(new THREE.Mesh(solid.build(), solidMat));
    if (!wedge.empty()) grp.add(new THREE.Mesh(wedge.build(), solidMat2));
    if (!glow.empty()) grp.add(new THREE.Mesh(glow.build(), glowMatV));
    if (!glass.empty()) grp.add(new THREE.Mesh(glass.build(), glassMat));
    if (!bill.empty()) { const m = new THREE.Mesh(bill.build(), holoMat); m.renderOrder = 3; grp.add(m); }
    for (const c of cranes) grp.add(c.jib);
    const entry = { grp, cranes, B, panes: null };
    buildPanes(entry);
    scene.add(grp);
    return entry;
  }
  // целые стёкла вестибюлей одного квартала — отдельный меш, пересобирается при каждом разбитом стекле
  function buildPanes(e) {
    if (e.panes) { e.grp.remove(e.panes); e.panes.geometry.dispose(); e.panes = null; }
    const g = new Geo();
    const c = col('#ffffff');
    for (const p of e.B.panes) if (!p.broken) g.box(p.x, 0.5, p.y, p.x + p.w, p.z1, p.y + p.h, c);
    if (g.empty()) return;
    e.panes = new THREE.Mesh(g.build(), paneMat);
    e.panes.renderOrder = 2;
    e.grp.add(e.panes);
  }
  function breakPane(p) {
    const e = blocks.get(p.B.i + ',' + p.B.j);
    if (e) buildPanes(e);
    const cx = p.x + p.w / 2, cz = p.y + p.h / 2;
    const gc = new THREE.Color('#bfe6ff');
    for (let k = 0; k < 26; k++) {
      const a = Math.random() * 6.283;
      fxDebris.add({ x: cx + rnd(-p.w / 2, p.w / 2), y: rnd(4, p.z1 - 4), z: cz + rnd(-p.h / 2, p.h / 2), vx: Math.cos(a) * rnd(30, 160), vy: rnd(20, 120), vz: Math.sin(a) * rnd(30, 160), g: 520, life: rnd(1.5, 3), s0: rnd(1.2, 3), s1: rnd(1, 2), col: gc, spin: rnd(-14, 14) });
    }
  }
  // клин пандуса: вершины считаем вручную, материал двусторонний
  function wedgeBox(G, rp, c) {
    const { x, y, w, h, dh } = rp;
    const H = (px, pz) => W.rampHeight(rp, px, pz);
    const P = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const top = P.map(([px, pz]) => [px, H(px, pz), pz]);
    const bot = P.map(([px, pz]) => [px, 0, pz]);
    const up = [0, 1, 0];
    G.quad(top[0], top[3], top[2], top[1], up, c, null);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      if (top[k][1] < 0.5 && top[k2][1] < 0.5) continue;
      const nx = k === 1 ? 1 : k === 3 ? -1 : 0, nz = k === 2 ? 1 : k === 0 ? -1 : 0;
      G.quad(bot[k], top[k], top[k2], bot[k2], [nx, 0, nz], c, null);
    }
    // жёлтые полосы по краям пандуса
    const yl = col('#c9a227');
    if (rp.axis === 'x') {
      for (const zz of [y + 1, y + h - 3]) G.quad([x, H(x, zz) + 0.4, zz], [x, H(x, zz) + 0.4, zz + 2], [x + w, H(x + w, zz) + 0.4, zz + 2], [x + w, H(x + w, zz) + 0.4, zz], up, yl, null);
    } else {
      for (const xx of [x + 1, x + w - 3]) G.quad([xx, H(xx, y) + 0.4, y], [xx + 2, H(xx, y) + 0.4, y], [xx + 2, H(xx, y + h) + 0.4, y + h], [xx, H(xx, y + h) + 0.4, y + h], up, yl, null);
    }
  }
  function addGarage(gr, solid, glow, wedge) {
    const dh = gr.dh, d = gr.deck;
    const conc = col('#55585e'), top = col('#3e4146'), line = col('#c8c8be');
    solid.box(d.x, dh - 4, d.y, d.x + d.w, dh, d.y + d.h, conc, top, null, true);
    for (const c of gr.cols) solid.box(c.x, 0, c.y, c.x + c.w, dh - 4, c.y + c.h, conc);
    for (const pp of gr.parapets) solid.box(pp.x, dh, pp.y, pp.x + pp.w, dh + 7, pp.y + pp.h, conc);
    // разметка мест наверху
    const long = gr.horiz;
    for (let k = 1; k < 10; k++) {
      const t = k / 10;
      if (long) { const x = d.x + d.w * t; solid.box(x - 0.7, dh, d.y + 6, x + 0.7, dh + 0.3, d.y + 50, line); solid.box(x - 0.7, dh, d.y + d.h - 50, x + 0.7, dh + 0.3, d.y + d.h - 6, line); }
      else { const z = d.y + d.h * t; solid.box(d.x + 6, dh, z - 0.7, d.x + 50, dh + 0.3, z + 0.7, line); solid.box(d.x + d.w - 50, dh, z - 0.7, d.x + d.w - 6, dh + 0.3, z + 0.7, line); }
    }
    // светильники на столбиках
    for (const [lx, ly] of gr.lights) {
      solid.box(lx - 1.2, dh, ly - 1.2, lx + 1.2, dh + 22, ly + 1.2, col('#4a4e56'));
      glow.box(lx - 4, dh + 20, ly - 4, lx + 4, dh + 23, ly + 4, glowCol('white', 2.4), glowCol('white', 2.4), null, true);
    }
    // лампы под плитой
    for (const c of gr.cols) glow.box(c.x + 10, dh - 5, c.y - 3, c.x + 22, dh - 4, c.y + 3, glowCol('white', 1.4), glowCol('white', 1.4), null, true);
    wedgeBox(wedge, B_ramp(gr), conc);
  }
  const B_ramp = (gr) => ({ ...gr.ramp, axis: gr.horiz ? 'x' : 'y', dir: gr.flip ? -1 : 1, dh: gr.dh });

  function addBuilding(b, solid, glow, glass, cranes, bill) {
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
      const tint = { green: '#1d5a3a', cyan: '#1d4a62', purple: '#3a2a5a', silver: '#34404e' }[b.glass];
      glass.box(x0, 0, z0, x1, h, z1, col(tint), col(tint), [0, 0, 1 / 48, 1 / 48]);
      // огни по рёбрам крыши
      const gc = glowCol('white', 2);
      for (let x = x0 + 4; x < x1 - 2; x += 14) { glow.cube(x, h + 1, z0, 2, gc); glow.cube(x, h + 1, z1, 2, gc); }
      for (let z = z0 + 4; z < z1 - 2; z += 14) { glow.cube(x0, h + 1, z, 2, gc); glow.cube(x1, h + 1, z, 2, gc); }
    } else {
      const wall = lighten(b.wall, '#4a4a6a', 0.5), roof = lighten(b.roof, '#4a5060', 0.25);
      const s = hashU(b.seed, 1, 2);
      const win = b.lit > 0 ? [((s % 32) * 2) / 64, (((s >>> 5) % 32) * 2) / 64, 1 / 7 / 64, 1 / 10 / 64] : null;
      if (b.lobby) {
        // верхние этажи на колоннах, внизу освещённый стеклянный холл
        const L = b.lobby;
        solid.box(x0, L, z0, x1, h, z1, wall, roof, win, true);
        const cs = 9;
        for (const [px, pz] of [[x0, z0], [x1 - cs, z0], [x1 - cs, z1 - cs], [x0, z1 - cs]]) solid.box(px, 0, pz, px + cs, L, pz + cs, wall);
        solid.box(x0 + 6, 0, z0 + 6, x1 - 6, 0.6, z1 - 6, col('#c8bca0', 0.7));
        const lc = glowCol('warm', 1.8);
        for (let x = x0 + 22; x < x1 - 12; x += 34) for (let z = z0 + 22; z < z1 - 12; z += 34) glow.box(x - 5, L - 1.6, z - 5, x + 5, L - 0.6, z + 5, lc, lc, null, true);
      } else solid.box(x0, 0, z0, x1, h, z1, wall, roof, win);
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
    if (b.tune) tuneDress(b, solid, glow);
    if (b.style === 'canopy') glow.box(x0 + 4, h - 2, z0 + 4, x1 - 4, h - 1, z1 - 4, glowCol('white', 1.6), glowCol('white', 1.6), null, true);
    if (h > 150) neonDress(b, solid, glow, bill);
  }

  // Мастерская «Неон-тюн»: тёмные ворота в неоновой раме, светящийся козырёк и полоса по крыше
  function tuneDress(b, solid, glow) {
    const T = b.tune, D = T.door, h = b.height;
    const pink = glowCol('pink', 2), cyan = glowCol('cyan', 1.6), dim = glowCol('purple', 0.9);
    // локальные координаты: u — от фасада наружу к улице, v — вдоль ворот от их края
    const fx = D.x + D.w / 2, fz = D.y + D.h / 2, along = T.nx ? D.h : D.w;
    const at = (u, v) => (T.nx ? [fx - T.nx * u, D.y + v] : [D.x + v, fz - T.ny * u]);
    const R = (u0, u1, v0, v1, y0, y1, c, g) => {
      const [x0, z0] = at(u0, v0), [x1, z1] = at(u1, v1);
      (g || glow).box(Math.min(x0, x1), y0, Math.min(z0, z1), Math.max(x0, x1), y1, Math.max(z0, z1), c, c, null, true);
    };
    R(-0.5, 1.5, 0, along, 0, 30, col('#07060a'), solid);       // проём
    R(0, 2.5, -3, 0, 0, 33, pink); R(0, 2.5, along, along + 3, 0, 33, pink); R(0, 2.5, -3, along + 3, 30, 33, pink);
    R(2, 18, -10, along + 10, 36, 38, cyan);                    // козырёк
    for (let k = 1; k < 5; k++) R(1.6, 2, (along * k) / 5 - 0.5, (along * k) / 5 + 0.5, 2, 29, dim); // ламели ворот
    const c = cyan;
    glow.box(b.x, h, b.y, b.x + b.w, h + 2, b.y + 1.5, c, c, null, true); glow.box(b.x, h, b.y + b.h - 1.5, b.x + b.w, h + 2, b.y + b.h, c, c, null, true);
    glow.box(b.x, h, b.y, b.x + 1.5, h + 2, b.y + b.h, c, c, null, true); glow.box(b.x + b.w - 1.5, h, b.y, b.x + b.w, h + 2, b.y + b.h, c, c, null, true);
  }

  // Киберпанк-фасад: неоновые пояса, вертикальные вывески, голограммы, шпили с огнями
  const NEONS = ['pink', 'cyan', 'purple', 'green', 'yellow', 'blue', 'orange'];
  // грани здания: центр грани, наружная нормаль и направление «вправо» для зрителя снаружи
  function faces(b) {
    const x0 = b.x, z0 = b.y, x1 = b.x + b.w, z1 = b.y + b.h;
    return [
      { cx: (x0 + x1) / 2, cz: z0, nx: 0, nz: -1, rx: -1, rz: 0, len: b.w },
      { cx: (x0 + x1) / 2, cz: z1, nx: 0, nz: 1, rx: 1, rz: 0, len: b.w },
      { cx: x0, cz: (z0 + z1) / 2, nx: -1, nz: 0, rx: 0, rz: 1, len: b.h },
      { cx: x1, cz: (z0 + z1) / 2, nx: 1, nz: 0, rx: 0, rz: -1, len: b.h },
    ];
  }
  function neonDress(b, solid, glow, bill) {
    const h = b.height, x0 = b.x, z0 = b.y, x1 = b.x + b.w, z1 = b.y + b.h;
    const H = (k) => hashU(b.seed & 0xffffff, k, 4321);
    const R = (k) => (H(k) % 10000) / 10000;
    const F = faces(b);
    // светящиеся пояса через несколько этажей
    if (R(1) < 0.45) {
      const c = glowCol(NEONS[H(2) % NEONS.length], 1.5);
      const step = 120 + R(3) * 260;
      for (let y = 60 + R(4) * 80; y < h - 20; y += step) {
        glow.box(x0 - 1, y, z0 - 1, x1 + 1, y + 1.6, z0 + 0.6, c, c); glow.box(x0 - 1, y, z1 - 0.6, x1 + 1, y + 1.6, z1 + 1, c, c);
        glow.box(x0 - 1, y, z0, x0 + 0.6, y + 1.6, z1, c, c); glow.box(x1 - 0.6, y, z0, x1 + 1, y + 1.6, z1, c, c);
      }
    }
    // светящиеся рёбра
    if (R(5) < 0.35) {
      const c = glowCol(NEONS[H(6) % NEONS.length], 1.3);
      for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) glow.box(px - 1, 30, pz - 1, px + 1, h, pz + 1, c, c);
    }
    // вертикальная вывеска-«лезвие» у угла на нижних этажах
    if (R(7) < 0.6) {
      const f = F[H(8) % 4];
      const c = glowCol(NEONS[H(9) % NEONS.length], 1.8), dark = col('#0a0812');
      const len = Math.min(h - 40, 80 + R(10) * 180);
      const along = (R(11) - 0.5) * f.len * 0.7;
      const bx = f.cx + f.rx * along, bz = f.cz + f.rz * along;
      const ox = f.nx, oz = f.nz;
      // плоскость вывески перпендикулярна стене
      const ax0 = Math.min(bx, bx + ox * 22), ax1 = Math.max(bx, bx + ox * 22), az0 = Math.min(bz, bz + oz * 22), az1 = Math.max(bz, bz + oz * 22);
      const thin = (a0, a1) => (a1 - a0 < 1 ? [a0 - 1.2, a1 + 1.2] : [a0, a1]);
      const [sx0, sx1] = thin(ax0, ax1), [sz0, sz1] = thin(az0, az1);
      solid.box(sx0, 34, sz0, sx1, 34 + len, sz1, dark);
      const [ex0, ex1] = thin(ax0 - 0.3, ax1 + 0.3), [ez0, ez1] = thin(az0 - 0.3, az1 + 0.3);
      glow.box(ex0, 34, ez0, ex1, 36, ez1, c, c); glow.box(ex0, 32 + len, ez0, ex1, 34 + len, ez1, c, c);
      for (let y = 46; y < 30 + len; y += 18) glow.box(ex0 + (ox ? 4 : 0), y, ez0 + (oz ? 4 : 0), ex1 - (ox ? 4 : 0), y + 9, ez1 - (oz ? 4 : 0), c, c);
    }
    // голограмма-реклама на одной-двух гранях
    const nb = h > 400 ? 1 + (R(12) < 0.5 ? 1 : 0) : R(12) < 0.45 ? 1 : 0;
    for (let k = 0; k < nb; k++) {
      const f = F[(H(13) + k * 2) % 4];
      if (f.len < 50) continue;
      const w = Math.min(f.len * 0.8, 90 + R(14 + k) * 110), hh = w * 0.5;
      const y = 50 + R(16 + k) * Math.max(10, Math.min(h - hh - 30, 520) - 50);
      const ad = H(18 + k) % ADS.length;
      const u0 = (ad % 2) * 0.5, v1 = 1 - ((ad / 2) | 0) * 0.25, v0 = v1 - 0.25;
      const cx = f.cx + f.nx * 4, cz = f.cz + f.nz * 4;
      const L = [cx - f.rx * w / 2, cz - f.rz * w / 2], Rt = [cx + f.rx * w / 2, cz + f.rz * w / 2];
      bill.quad([L[0], y, L[1]], [L[0], y + hh, L[1]], [Rt[0], y + hh, Rt[1]], [Rt[0], y, Rt[1]], [f.nx, 0, f.nz], col('#ffffff'),
        [u0, v0, u0, v1, u0 + 0.5, v1, u0 + 0.5, v0]);
    }
    // шпиль с мигающим огнём на самых высоких
    if (h > 900 && b.w > 50 && b.h > 50) {
      const sh = 80 + R(20) * 260;
      solid.box(b.cx - 3, h, b.cy - 3, b.cx + 3, h + sh, b.cy + 3, col('#3a3e48'));
      glow.cube(b.cx, h + sh + 3, b.cy, 7, glowCol('red', 3.2));
      const c = glowCol(NEONS[H(21) % NEONS.length], 1.6);
      glow.box(x0, h + 2, z0, x1, h + 4, z0 + 1.5, c, c); glow.box(x0, h + 2, z1 - 1.5, x1, h + 4, z1, c, c);
      glow.box(x0, h + 2, z0, x0 + 1.5, h + 4, z1, c, c); glow.box(x1 - 1.5, h + 2, z0, x1, h + 4, z1, c, c);
    }
  }
  function dropBlock(e) {
    scene.remove(e.grp);
    e.grp.traverse((o) => { if (o.geometry && o.geometry !== unitBox) o.geometry.dispose(); });
  }

  function manage(T, budget) {
    // земля
    const need = [];
    const cx0 = Math.floor((T.x - CHUNK_R) / CS), cx1 = Math.floor((T.x + CHUNK_R) / CS);
    const cy0 = Math.floor((T.z - CHUNK_R) / CS), cy1 = Math.floor((T.z + CHUNK_R) / CS);
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
    }
    // кварталы
    const bneed = [];
    const bwant = new Set();
    for (let i = W.colAt(T.x - BLOCK_R); i <= W.colAt(T.x + BLOCK_R); i++) {
      for (let j = W.rowAt(T.z - BLOCK_R); j <= W.rowAt(T.z + BLOCK_R); j++) {
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
    for (const c of [...st.traffic, ...st.cops]) {
      let m = cars.get(c);
      if (!m) {
        m = carModel(c.kind, c.color, false);
        scene.add(m);
        cars.set(c, m);
      }
      m.position.set(c.x, c.z || 0, c.y);
      m.rotation.set(0, -c.a, c.pitch || 0);
      // за туманом машину не рисуем
      m.visible = Math.abs(c.x - camera.position.x) + Math.abs(c.y - camera.position.z) < 3000;
      if (!m.visible) { seen.add(c); continue; }
      const tm = c.brake ? glowMat('red', 3) : glowMat('red', 1);
      for (const t of m.userData.tail) t.material = tm;
      if (c.hazard) { // аварийка
        const on = Math.sin(st.time * 7) > 0, hm = on ? glowMat('orange', 3) : glowMat('red', 0.4);
        for (const t of m.userData.tail) t.material = hm;
        for (const t of m.userData.heads) t.material = on ? glowMat('orange', 3) : glowMat('white', 0.6);
      }
      if (m.userData.bar) {
        const on = !c.wreck && Math.sin(st.time * 14 + (c.cop ? 1 : 0)) > 0;
        m.userData.bar[0].visible = on; m.userData.bar[1].visible = !on && !c.wreck;
      }
      if (m.userData.beacon) { const on = Math.sin(st.time * 9 + c.x * 0.01) > 0.2; for (const b of m.userData.beacon) b.visible = on; }
      if (m.userData.spin) m.userData.spin.rotation.y = st.time * 2.5;
      if (c.cop) { applyDamage(m, c); }
      seen.add(c);
    }
    for (const [c, m] of cars) if (!seen.has(c)) { scene.remove(m); cars.delete(c); }
    const P = st.player;
    if (!playerModel || playerGen !== P.gen || playerCol !== P.color) {
      if (playerModel) scene.remove(playerModel);
      playerCol = P.color;
      playerModel = carModel('delorean', P.color || '#c8ccd4', true); scene.add(playerModel); playerGen = P.gen;
    }
    // выхлоп нитро
    if (P.boosting) for (const s of [-1, 1]) {
      const bx = P.x - Math.cos(P.a) * 26 - Math.sin(P.a) * s * 6, bz = P.y - Math.sin(P.a) * 26 + Math.cos(P.a) * s * 6;
      fire(bx, (P.z || 0) + 6, bz, 1, 2);
    }
    applyDamage(playerModel, P);
    playerModel.position.set(P.x, P.z, P.y);
    playerModel.rotation.set(0, -P.a, P.pitch);
    // тень под машиной в прыжке
    const sh = W.surfaceAt(P.x, P.y, P.z);
    shadow.visible = P.z - sh > 2;
    shadow.position.set(P.x, sh + 0.8, P.y);
    shadow.rotation.set(-Math.PI / 2, 0, P.a);
    shadow.material.opacity = Math.max(0.1, 0.5 - (P.z - sh) / 200);
    const tm = P.brake ? glowMat('red', 3.5) : glowMat('red', 1.2);
    for (const t of playerModel.userData.tail) t.material = tm;
  }

  // маркеры заданий: световые столбы с кольцом на земле, вращающиеся бонусы, стрелки над целями
  const markPool = [];
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
  const ringGeo = new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2);
  const arrowGeo = new THREE.ConeGeometry(9, 18, 4).rotateX(Math.PI);
  const pickGeo = new THREE.OctahedronGeometry(9);
  // ---------------------------------------------------------------- ремонт дорог
  const works = new Map();
  const coneGeo = new THREE.ConeGeometry(4, 12, 8), bandGeo = new THREE.CylinderGeometry(2.6, 3.1, 2.2, 8);
  let boardMat = null, floodTex = null;
  function buildWorks(z) {
    const g = new THREE.Group();
    g.position.set(z.x, 0, z.y); g.rotation.y = -z.a;
    scene.add(g);
    // ось v модели направлена в (-uy, ux); знак — где ось дороги
    const iv = z.ix * -z.uy + z.iy * z.ux;
    const local = (x, y) => { const rx = x - z.x, ry = y - z.y; return [rx * z.ux + ry * z.uy, rx * -z.uy + ry * z.ux]; };
    const W2 = z.hw * 2 - 4;
    part(g, lambert('#2e241c'), (z.pit.u0 + z.pit.u1) / 2, 0.5, -iv * 0.1 * z.hw, z.pit.u1 - z.pit.u0, 1, W2 * 0.8);
    part(g, lambert('#0e0f12'), (z.fresh.u0 + z.fresh.u1) / 2, 0.45, 0, z.fresh.u1 - z.fresh.u0, 0.9, W2);
    part(g, lambert('#6a5a48'), z.pit.u0 - 14, 3, -iv * z.hw * 0.4, 18, 6, 14);
    part(g, lambert('#7a6a58'), z.pit.u0 - 14, 7, -iv * z.hw * 0.4, 10, 3, 8);
    // прожекторы на стойках и пятна света под ними
    if (!floodTex) { floodTex = new THREE.CanvasTexture(S.glow.warm); floodTex.colorSpace = THREE.SRGBColorSpace; }
    const pool = new THREE.MeshBasicMaterial({ map: floodTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9, toneMapped: false });
    for (const [lx, ly] of z.lamps) {
      const [u, v] = local(lx, ly);
      part(g, lambert('#3a3e44'), u, 20, v, 2, 40, 2);
      part(g, glowMat('warm', 3.2), u, 40, v + iv * 2, 3, 4, 6);
      const p = new THREE.Mesh(new THREE.PlaneGeometry(190, 190), pool);
      p.rotation.x = -Math.PI / 2; p.position.set(u, 1.4, v + iv * 18);
      g.add(p);
    }
    const e = { g, cones: [], boards: [], machines: [], workers: [], local };
    const orange = emiss('#ff6a14', 0.55), white = emiss('#f4f4f4', 0.7);
    for (const c of z.cones) {
      const m = new THREE.Group();
      const body = new THREE.Mesh(coneGeo, orange); body.position.y = 6; m.add(body);
      const band = new THREE.Mesh(bandGeo, white); band.position.y = 6.5; m.add(band);
      part(m, orange, 0, 0.6, 0, 8, 1.2, 8);
      g.add(m); e.cones.push(m);
    }
    if (!boardMat) boardMat = stripeMat();
    for (const b of z.boards) {
      const m = new THREE.Group();
      const [u, v] = local(b.x, b.y);
      m.position.set(u, 0, v); m.rotation.y = -(b.a - z.a);
      part(m, boardMat, 0, 10, 0, b.L, 8, 1.5);
      for (const sd of [-1, 1]) part(m, lambert('#2a2e34'), sd * (b.L / 2 - 2), 5, 0, 1.5, 10, 6);
      m.userData.blink = [-1, 1].map((sd) => part(m, glowMat('yellow', 3.4), sd * (b.L / 2 - 2), 16, 0, 3, 3, 3));
      g.add(m); e.boards.push(m);
    }
    for (const sm of z.solid) {
      const m = sm.kind === 'excavator' ? excavatorModel('#e8a81c') : carModel(sm.kind, sm.kind === 'roller' ? '#e8c020' : '#e8781c');
      if (m.userData.cones) for (const c of m.userData.cones) c.visible = false;
      if (m.userData.heads) for (const h of m.userData.heads) h.visible = false;
      if (m.userData.body) m.traverse((o) => { if (o.material === m.userData.body) o.material = emiss(sm.kind === 'roller' ? '#e8c020' : '#e8781c', 0.3); });
      const [u, v] = local(sm.x, sm.y);
      m.position.set(u, 0, v); m.rotation.y = -(sm.a - z.a);
      g.add(m); e.machines.push(m);
    }
    const vest = emiss('#ff7a1a', 0.5), helmet = emiss('#ffd21a', 0.45), skin = lambert('#d8a080'), pants = lambert('#2a3040');
    for (const w of z.workers) {
      const m = new THREE.Group();
      part(m, pants, 0, 3.5, 0, 3, 7, 5);
      part(m, vest, 0, 10, 0, 3.5, 7, 6);
      part(m, glowMat('white', 1.3), 0, 10, 0, 3.7, 1, 6.2);
      part(m, skin, 0, 15, 0, 3, 3, 3);
      part(m, helmet, 0, 17, 0, 4, 1.5, 4);
      g.add(m); e.workers.push(m);
    }
    return e;
  }
  function syncWorks(st) {
    const list = st.works || [];
    const seen = new Set(list);
    for (const [z, e] of works) if (!seen.has(z)) { scene.remove(e.g); works.delete(z); }
    const P = st.player;
    for (const z of list) {
      let e = works.get(z);
      if (!e) { e = buildWorks(z); works.set(z, e); }
      e.g.visible = Math.abs(z.x - P.x) < 4200 && Math.abs(z.y - P.y) < 4200;
      if (!e.g.visible) continue;
      z.cones.forEach((c, k) => {
        const m = e.cones[k];
        const [u, v] = e.local(c.x, c.y);
        m.position.set(u, c.z, v);
        if (c.down) { m.rotation.set(Math.PI / 2 * Math.sin(c.tip), c.rot, Math.PI / 2 * Math.cos(c.tip)); m.position.y = c.z + 3.5; }
      });
      const blink = Math.sin(st.time * 7) > 0;
      z.boards.forEach((b, k) => {
        const m = e.boards[k];
        for (const l of m.userData.blink) l.visible = blink && !b.down;
        if (b.down) m.rotation.x = -b.fall * Math.PI / 2 * Math.sign(Math.cos(b.fallA - b.a + Math.PI / 2) || 1);
      });
      const t = st.time + z.id * 10;
      z.solid.forEach((sm, k) => {
        const m = e.machines[k], d = m.userData;
        if (d.beacon) for (const b of d.beacon) b.visible = Math.sin(t * 9) > 0.2;
        if (d.tur) {
          d.tur.rotation.y = Math.sin(t * 0.35) * 0.3;
          d.boom.rotation.z = 0.35 + Math.sin(t * 0.8) * 0.25;
          d.arm.rotation.z = -1.5 + Math.sin(t * 0.8 + 1.2) * 0.45;
          d.bucket.rotation.z = -0.4 + Math.sin(t * 0.8 + 2) * 0.5;
        }
        const [u, v] = e.local(sm.x, sm.y);
        m.position.set(u, 0, v);
      });
      z.workers.forEach((w, k) => {
        const m = e.workers[k];
        const [u, v] = e.local(w.x, w.y);
        m.position.set(u, 0, v);
        if (w.down > 0) m.rotation.set(0, -(w.a - z.a), Math.PI / 2);
        else m.rotation.set(0, -(w.a - z.a) + Math.sin(w.phase * 0.7) * 0.6, Math.sin(w.phase * 3) * 0.12);
      });
    }
  }
  function markMesh() {
    const add = (geo, opacity) => { const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false })); scene.add(m); return m; };
    return { beam: add(beamGeo, 0.22), ring: add(ringGeo, 0.9), arrow: add(arrowGeo, 0.95), pick: add(pickGeo, 0.95) };
  }
  function syncMarkers(st) {
    const list = st.markers || [];
    while (markPool.length < list.length) markPool.push(markMesh());
    markPool.forEach((m, k) => {
      const mk = list[k];
      const on = !!mk;
      for (const o of Object.values(m)) o.visible = false;
      if (!on) return;
      const c = glowCol('white', 1).set(mk.col).multiplyScalar(mk.k || 2);
      for (const o of Object.values(m)) o.material.color.copy(c);
      const pulse = 1 + Math.sin(st.time * 5) * 0.06;
      if (mk.kind === 'beam' || mk.kind === 'shop') {
        // столб света бледный и гаснет вблизи, чтобы не закрывать обзор; у мастерской — только кольцо
        const d = Math.hypot(mk.x - st.player.x, mk.y - st.player.y);
        m.beam.visible = mk.kind === 'beam' && d > 160;
        m.beam.material.opacity = 0.075 * Math.min(1, (d - 160) / 600);
        m.ring.visible = true;
        m.ring.material.opacity = mk.kind === 'shop' ? 0.55 : 0.7;
        m.beam.position.set(mk.x, 0, mk.y); m.beam.scale.set(mk.r * 0.45, 260, mk.r * 0.45);
        m.ring.position.set(mk.x, 1.5, mk.y); m.ring.scale.set(mk.r * pulse, 1, mk.r * pulse);
      } else if (mk.kind === 'pickup') {
        m.pick.visible = m.ring.visible = true;
        m.pick.position.set(mk.x, 16 + Math.sin(st.time * 3 + mk.x) * 3, mk.y); m.pick.rotation.y = st.time * 2.5;
        m.ring.position.set(mk.x, 1.5, mk.y); m.ring.scale.set(mk.r * 0.7 * pulse, 1, mk.r * 0.7 * pulse);
      } else {
        m.arrow.visible = true;
        m.arrow.position.set(mk.x, 52 + Math.sin(st.time * 6) * 5, mk.y); m.arrow.rotation.y = st.time * 2;
      }
    });
  }

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

  // ---------------------------------------------------------------- горизонт гигаполиса
  // За пределами дымки — бесконечное поле мегабашен в километры высотой: тёмные силуэты
  // с редкими окнами и красными огнями. Пересобирается, когда игрок уходит на 2 км.
  const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: skylineAtlas(), fog: false });
  const skyGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
  let skyline = null, skyKey = '';
  function syncSkyline(px, pz) {
    const SNAP = 2000, C = 760;
    const ci = Math.round(px / SNAP), cj = Math.round(pz / SNAP);
    const key = ci + ',' + cj;
    if (key === skyKey) return;
    skyKey = key;
    if (skyline) { scene.remove(skyline); skyline.traverse((o) => o.geometry && o.geometry.dispose()); }
    const cx = ci * SNAP, cz = cj * SNAP, R0 = FOG_FAR + SNAP * 0.75, R1 = 9500;
    const g = new Geo(), gl = new Geo();
    const haze = new THREE.Color(1.5, 0.75, 1.7), near = new THREE.Color(0.95, 0.9, 1.05), c = new THREE.Color();
    for (let a = Math.floor((cx - R1) / C); a <= Math.floor((cx + R1) / C); a++) {
      for (let b = Math.floor((cz - R1) / C); b <= Math.floor((cz + R1) / C); b++) {
        const h0 = hashU(a, b, 4242), h1 = hashU(a, b, 4343);
        if (h0 % 10 < 2) continue;
        const w = 160 + (h1 % 360), d = 160 + ((h1 >>> 9) % 360);
        const x = a * C + (h0 % 400) - 200, z = b * C + ((h0 >>> 9) % 400) - 200;
        const dist = Math.hypot(x - cx, z - cz);
        if (dist < R0 || dist > R1) continue;
        const k = ((h0 >>> 3) % 1000) / 1000;
        const ht = 1200 + k * k * 6500 + (h1 % 7 === 0 ? 3000 : 0);
        const t = (dist - R0) / (R1 - R0);
        c.copy(near).lerp(haze, t * 0.7).multiplyScalar(1 - 0.55 * t);
        const u = (h1 % 64) / 64, win = [u, 0, 1 / 40 / 64, 1 / 60 / 64];
        g.box(x - w / 2, 0, z - d / 2, x + w / 2, ht, z + d / 2, c, col('#0a0810'), win);
        // ступенчатая верхушка и огни
        const stepped = h1 % 3 === 0;
        if (stepped) g.box(x - w * 0.3, ht, z - d * 0.3, x + w * 0.3, ht * 1.08, z + d * 0.3, c, col('#0a0810'), win);
        gl.cube(x, ht * (stepped ? 1.08 : 1) + 8, z, 18, glowCol('red', 2.4));
        if (h0 % 4 === 0) {
          const nc = glowCol(['pink', 'cyan', 'purple', 'blue'][h1 % 4], 1.1);
          for (let y = 300 + (h0 % 300); y < ht - 100; y += 500 + (h1 % 400)) gl.box(x - w / 2 - 2, y, z - d / 2 - 2, x + w / 2 + 2, y + 8, z + d / 2 + 2, nc, nc);
        }
      }
    }
    skyline = new THREE.Group();
    skyline.add(new THREE.Mesh(g.build(), skyMat));
    if (!gl.empty()) skyline.add(new THREE.Mesh(gl.build(), skyGlowMat));
    scene.add(skyline);
  }

  // ---------------------------------------------------------------- летающие машины
  // Воздушные коридоры над улицами на нескольких высотах
  const FLY = 90;
  const flyBody = new THREE.InstancedMesh(unitBox, new THREE.MeshLambertMaterial({ color: 0x22202c, emissive: 0x0c0818 }), FLY);
  const flyLight = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ toneMapped: false }), FLY * 3);
  for (const m of [flyBody, flyLight]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; scene.add(m); }
  const FLY_COL = ['pink', 'cyan', 'red', 'purple', 'white'].map((n) => glowCol(n, 3));
  const flyHead = glowCol('white', 3.5);
  const flyers = [];
  const flyS = new THREE.Vector3();
  function spawnFlyer(f, px, pz, edge) {
    f.vert = Math.random() < 0.5;
    const off = Math.round((Math.random() - 0.5) * 7);
    f.c = (f.vert ? W.roadX(W.colAt(px) + off) : W.roadY(W.rowAt(pz) + off)) + (Math.random() - 0.5) * 50;
    f.v = (Math.random() < 0.5 ? -1 : 1) * (450 + Math.random() * 800);
    const along = f.vert ? pz : px;
    f.t = edge ? along - Math.sign(f.v) * (2600 + Math.random() * 400) : along + (Math.random() - 0.5) * 5000;
    f.z = [180, 320, 520, 800, 1150][(Math.random() * 5) | 0] + (Math.random() - 0.5) * 40;
    f.col = FLY_COL[(Math.random() * FLY_COL.length) | 0];
    f.L = 34 + Math.random() * 20;
  }
  function syncFlyers(st, px, pz) {
    const dt = st.dt || 0;
    while (flyers.length < FLY) { const f = {}; spawnFlyer(f, px, pz, false); flyers.push(f); }
    flyers.forEach((f, k) => {
      f.t += f.v * dt;
      const along = f.vert ? pz : px, cross = f.vert ? px : pz;
      if (Math.abs(f.t - along) > 3200 || Math.abs(f.c - cross) > 3200) spawnFlyer(f, px, pz, true);
      const x = f.vert ? f.c : f.t, z = f.vert ? f.t : f.c;
      const a = f.vert ? (f.v > 0 ? Math.PI / 2 : -Math.PI / 2) : (f.v > 0 ? 0 : Math.PI);
      const fx = Math.cos(a), fz = Math.sin(a);
      const y = f.z + Math.sin(st.time * 1.3 + k) * 3;
      tmpE.set(0, -a, 0); tmpQ.setFromEuler(tmpE);
      const put = (mesh, n, ox, oy, sx, sy, sz, c) => {
        tmpP.set(x + fx * ox, y + oy, z + fz * ox); flyS.set(sx, sy, sz);
        tmpM.compose(tmpP, tmpQ, flyS); mesh.setMatrixAt(n, tmpM);
        if (c) mesh.setColorAt(n, c);
      };
      put(flyBody, k, 0, 0, f.L, 9, 18);
      put(flyLight, k * 3, f.L / 2, 0, 2, 3, 14, flyHead);
      put(flyLight, k * 3 + 1, -f.L / 2, 0, 2, 3, 16, f.col);
      put(flyLight, k * 3 + 2, 0, -5.5, f.L * 0.7, 1.2, 12, f.col);
    });
    flyBody.count = flyers.length; flyLight.count = flyers.length * 3;
    flyBody.instanceMatrix.needsUpdate = flyLight.instanceMatrix.needsUpdate = true;
    if (flyLight.instanceColor) flyLight.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- штабы банд
  // Столб света до неба и голограмма с названием видны сквозь дымку; реакторы пульсируют цветом банды
  const hqVis = new Map();
  function gangTex(text, color) {
    const c = canvas(512, 128), g = c.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 54px "Trebuchet MS", sans-serif';
    g.shadowColor = color; g.shadowBlur = 22;
    g.fillStyle = color; g.fillText(text.toUpperCase(), 256, 60);
    g.shadowBlur = 6; g.fillStyle = '#ffffff'; g.fillText(text.toUpperCase(), 256, 60);
    g.strokeStyle = color; g.lineWidth = 4; g.shadowBlur = 16; g.strokeRect(8, 8, 496, 112);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const pylonCore = new THREE.CylinderGeometry(5, 5, 46, 10);
  function buildHQ(h) {
    const add = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false };
    const c = new THREE.Color(h.col);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 4000, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(1.2), opacity: 0.07, fog: false, ...add }));
    beam.position.set(h.x, 2000, h.y);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(440, 110), new THREE.MeshBasicMaterial({ map: gangTex(h.name, h.col), opacity: 0.95, fog: false, ...add }));
    sign.position.set(h.x, 460, h.y);
    scene.add(beam, sign);
    const coreMat = new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(2.6), toneMapped: false });
    const pyl = h.pylons.map((p) => {
      const g = new THREE.Group();
      g.position.set(p.x, 0, p.y);
      const base = part(g, lambert('#1a1824'), 0, 4, 0, 18, 8, 18);
      const core = new THREE.Mesh(pylonCore, coreMat); core.position.y = 31; g.add(core);
      const cap = part(g, lambert('#2a2834'), 0, 56, 0, 14, 4, 14);
      const ring = part(g, glowMat('white', 2.2), 0, 9, 0, 19, 1.5, 19);
      scene.add(g);
      return { g, core, cap, ring, base };
    });
    return { beam, sign, pyl, coreMat };
  }
  function syncHQ(st) {
    const P = st.player;
    for (const h of st.hqs || []) {
      let v = hqVis.get(h);
      const d = Math.hypot(h.x - P.x, h.y - P.y);
      const show = !h.state.dead && (h.state.intel >= 3 || d < 1600);
      if (!v) { if (!show && d > 2600) continue; v = buildHQ(h); hqVis.set(h, v); }
      v.sign.visible = show;
      v.beam.visible = show && d > 900; // вблизи столб не мешает смотреть на реакторы
      // голограмма поворачивается к камере
      v.sign.rotation.y = Math.atan2(camera.position.x - h.x, camera.position.z - h.y);
      v.sign.material.opacity = 0.85 + Math.sin(st.time * 19 + h.k) * 0.08;
      const near = d < 2600;
      h.pylons.forEach((p, m) => {
        const q = v.pyl[m];
        q.g.visible = near;
        if (!near) return;
        q.core.visible = q.ring.visible = q.cap.visible = !p.dead;
        if (p.dead) { if (Math.random() < st.dt * 4) smoke(p.x, 12, p.y, true); return; }
        const pulse = 1 + Math.sin(st.time * 6 + m) * 0.12;
        q.core.scale.set(pulse, 1, pulse);
      });
    }
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

  let W0 = 0, H0 = 0, camA = null, camY = 50;
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
      const P = st.player, dt = st.dt || 0;
      const T = { x: P.x, z: P.y, vx: P.vx, vy: P.vy };
      const pending = manage(T, first ? 400 : 3);
      // камера от третьего лица: позади и чуть выше, плавно догоняет поворот машины
      const sp = Math.hypot(P.vx, P.vy);
      if (camA === null || first) camA = P.a;
      camA += Math.atan2(Math.sin(P.a - camA), Math.cos(P.a - camA)) * Math.min(1, dt * (P.drift ? 2.5 : 4.5));
      const fx = Math.cos(camA), fz = Math.sin(camA);
      const back = 130 + sp * 0.09, up = 46 + sp * 0.025, pz = P.z || 0;
      camY += (pz + up - camY) * Math.min(1, dt * 6);
      const sh = st.shake || 0;
      camera.position.set(P.x - fx * back + (Math.random() - 0.5) * sh, Math.max(12, camY) + (Math.random() - 0.5) * sh, P.y - fz * back + (Math.random() - 0.5) * sh);
      camera.lookAt(P.x + fx * 140, pz + 34, P.y + fz * 140);
      const fov = 62 + Math.min(1, sp / 580) * 14;
      if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = fov; camera.updateProjectionMatrix(); }
      sky.position.copy(camera.position);
      syncSkyline(P.x, P.y);
      syncFlyers(st, P.x, P.y);
      holoMat.opacity = 0.82 + Math.sin(st.time * 23) * 0.04 + (Math.random() < 0.02 ? -0.3 : 0);
      for (const e of blocks.values()) for (const c of e.cranes) c.jib.rotation.y = -(c.c.a0 + st.time * c.c.speed);
      syncCars(st);
      syncPeds(st);
      syncTrains(st);
      syncRain(st);
      syncSkids(st);
      syncMarkers(st);
      syncWorks(st);
      syncHQ(st);
      syncSignals(st, T);
      handleFx(st, st.dt);
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
