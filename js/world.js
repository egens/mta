// Процедурный бесконечный город: сетка улиц, проспекты, диагонали, реки, ж/д,
// и наполнение кварталов. Всё вычисляется детерминированно из координат.
import { hash, hashU, rng, noise1, noise2, fbm2, clamp, lerp } from './util.js';

export const G = 760;          // средний шаг сетки улиц
export const SW = 18;          // ширина тротуара
export const ROAD_W = 84;
export const AVE_W = 140;
export const DIAG_W = 100;
export const RAIL_W = 62;
export const RP = 5200;        // период полос, в которых может течь река
const DS = 3600;               // шаг диагональных проспектов
const RAILG = 13;              // группа колонок, в которой может быть одна ж/д

export const PAL = {
  sidewalk: '#55575c', curb: '#74767b', asphalt: '#2c2e33', mark: '#d6d6cc',
  grass: '#3d5a31', yard: '#456235', dirt: '#6b5536', sand: '#9c8458',
  paving: '#7a746b', water: '#10304a', bank: '#77736c', concrete: '#7a7b7e',
  rubber: '#7c4636', gravel: '#57524a', court: '#4b4c50', lotAsph: '#45464a',
};

// ---------------------------------------------------------------- сетка улиц
export const roadX = (i) => i * G + (hash(i, 1, 101) - 0.5) * 200;
export const roadY = (j) => j * G + (hash(j, 2, 101) - 0.5) * 200;
export const aveX = (i) => hash(i, 1, 102) < 0.22;
export const aveY = (j) => hash(j, 2, 102) < 0.22;
export const widthX = (i) => (aveX(i) ? AVE_W : ROAD_W);
export const widthY = (j) => (aveY(j) ? AVE_W : ROAD_W);

export function colAt(x) {
  let i = Math.floor(x / G);
  while (roadX(i) > x) i--;
  while (roadX(i + 1) <= x) i++;
  return i;
}
export function rowAt(y) {
  let j = Math.floor(y / G);
  while (roadY(j) > y) j--;
  while (roadY(j + 1) <= y) j++;
  return j;
}

// ---------------------------------------------------------------- реки
export const riverExists = (m) => hash(m, 3, 201) < 0.5;
// Река течёт посередине ряда кварталов (между двумя горизонтальными улицами)
// и время от времени переходит в соседний ряд крутым изгибом посреди квартала.
// Так она пересекает улицы только под большим углом, и на каждом пересечении стоит мост.
const RIVER_GRP = 3;
const riverRowOff = (m, g) => { const h = hash(g, m, 210); return h < 0.3 ? -1 : h < 0.7 ? 0 : 1; };
const rowMid = (j) => (roadY(j) + roadY(j + 1)) / 2;
const riverColCache = new Map();
function riverCol(m, i) {
  const key = m * 1000003 + i;
  let c = riverColCache.get(key);
  if (!c) {
    if (riverColCache.size > 50000) riverColCache.clear();
    const jr = rowAt(m * RP + RP * 0.5);
    const g = Math.floor(i / RIVER_GRP);
    const cur = rowMid(jr + riverRowOff(m, g));
    const trans = i === g * RIVER_GRP;
    const xa = roadX(i), xb = roadX(i + 1);
    const pad = (xb - xa) * 0.18;
    c = { cur, prev: trans ? rowMid(jr + riverRowOff(m, g - 1)) : cur, xa: xa + pad, span: xb - xa - 2 * pad };
    riverColCache.set(key, c);
  }
  return c;
}
export function riverY(m, x) {
  const c = riverCol(m, colAt(x));
  let y = c.cur;
  if (c.prev !== c.cur) {
    const t = clamp((x - c.xa) / c.span, 0, 1);
    y = c.prev + (c.cur - c.prev) * t * t * (3 - 2 * t);
  }
  return y + (noise1(x * 0.004, m * 13 + 2) - 0.5) * 36;
}
export const riverHW = (m, x) => 85 + noise1(x * 0.0006, m * 13 + 3) * 65;
const riverSlope = (m, x) => (riverY(m, x + 6) - riverY(m, x - 6)) / 12;
// половина толщины реки по вертикали (на крутых участках она больше нормальной ширины)
export function riverHV(m, x) {
  const s = riverSlope(m, x);
  return riverHW(m, x) * Math.sqrt(1 + s * s);
}
// расстояние до берега (отрицательное — в воде)
export function riverDist(x, y) {
  const m = Math.floor(y / RP);
  if (!riverExists(m)) return 1e9;
  const dy = y - riverY(m, x);
  if (Math.abs(dy) > 1400) return 1e9;
  const s = riverSlope(m, x);
  return Math.abs(dy) / Math.sqrt(1 + s * s) - riverHW(m, x);
}

// диапазон y, который занимает река m в полосе [xa, xb]
export function riverSpan(m, xa, xb) {
  let lo = Infinity, hi = -Infinity;
  for (let x = xa; x <= xb + 0.1; x += Math.max(4, (xb - xa) / 6)) {
    const ry = riverY(m, x), hv = riverHV(m, x);
    lo = Math.min(lo, ry - hv); hi = Math.max(hi, ry + hv);
  }
  return [lo, hi];
}

// ---------------------------------------------------------------- диагонали
export const diagC = (fam, k) => k * DS + (hash(k, fam, 301) - 0.5) * 1400;
export const diagExists = (fam, k) => hash(k, fam, 302) < 0.3;
export function diagsInRect(x0, y0, x1, y1, pad = 0) {
  const out = [];
  const p = pad * Math.SQRT2;
  for (let fam = 0; fam < 2; fam++) {
    const umin = fam === 0 ? x0 + y0 : x0 - y1;
    const umax = fam === 0 ? x1 + y1 : x1 - y0;
    const k0 = Math.floor((umin - p - 800) / DS), k1 = Math.ceil((umax + p + 800) / DS);
    for (let k = k0; k <= k1; k++) {
      if (!diagExists(fam, k)) continue;
      const c = diagC(fam, k);
      if (c >= umin - p && c <= umax + p) out.push({ fam, k, c });
    }
  }
  return out;
}
export const diagSigned = (d, x, y) => ((d.fam === 0 ? x + y : x - y) - d.c) / Math.SQRT2;
// направление и нормаль диагонали
export const diagDir = (d) => (d.fam === 0 ? [Math.SQRT1_2, -Math.SQRT1_2] : [Math.SQRT1_2, Math.SQRT1_2]);
export const diagNorm = (d) => (d.fam === 0 ? [Math.SQRT1_2, Math.SQRT1_2] : [Math.SQRT1_2, -Math.SQRT1_2]);
export const diagOrigin = (d) => (d.fam === 0 ? [d.c / 2, d.c / 2] : [d.c / 2, -d.c / 2]);

// ---------------------------------------------------------------- железная дорога
function railColOfGroup(g) {
  if (hash(g, 5, 401) > 0.6) return null;
  return g * RAILG + 2 + Math.floor(hash(g, 5, 402) * (RAILG - 4));
}
export const hasRail = (i) => railColOfGroup(Math.floor(i / RAILG)) === i;
export const railX = (i) => (roadX(i) + roadX(i + 1)) / 2;
export function railsInRange(x0, x1) {
  const out = [];
  const g0 = Math.floor(colAt(x0) / RAILG) - 1, g1 = Math.floor(colAt(x1) / RAILG) + 1;
  for (let g = g0; g <= g1; g++) {
    const i = railColOfGroup(g);
    if (i === null) continue;
    const x = railX(i);
    if (x > x0 - RAIL_W && x < x1 + RAIL_W) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------- вода и мосты
export function onBridge(x, y) {
  // каждая улица, пересекающая реку, идёт по мосту
  const i = colAt(x), j = rowAt(y);
  for (const ii of [i, i + 1]) if (Math.abs(x - roadX(ii)) < widthX(ii) / 2 + 12) return true;
  for (const jj of [j, j + 1]) if (Math.abs(y - roadY(jj)) < widthY(jj) / 2 + 12) return true;
  for (const d of diagsInRect(x, y, x, y, DIAG_W)) {
    if (Math.abs(diagSigned(d, x, y)) < DIAG_W / 2 + SW) return true;
  }
  if (hasRail(i) && Math.abs(x - railX(i)) < RAIL_W / 2 + 6) return true;
  return false;
}
export function isWater(x, y) {
  if (riverDist(x, y) < 0 && !onBridge(x, y)) return true;
  const b = getBlock(colAt(x), rowAt(y));
  for (const p of b.ponds) {
    const dx = (x - p.x) / p.rx, dy = (y - p.y) / p.ry;
    if (dx * dx + dy * dy < 0.82) return true;
  }
  return false;
}

// ---------------------------------------------------------------- граф для трафика
// Все улицы непрерывны: реки пересекаются по мостам.
export const hSegExists = () => true;
export const vSegExists = () => true;

// ---------------------------------------------------------------- зоны и районы
export function zoneAt(x, y) {
  return {
    dens: fbm2(x / 6500 + 100, y / 6500 + 100, 11),
    ind: fbm2(x / 9000 - 50, y / 9000 + 30, 21),
    park: noise2(x / 3300 + 7, y / 3300 - 3, 31),
  };
}

const DISTRICTS = ['Заречье', 'Нагорный', 'Сокольники', 'Старый город', 'Черёмушки', 'Фабричный',
  'Кирпичный', 'Речной порт', 'Ясенево', 'Лефортово', 'Вокзальный', 'Садовый', 'Тополиный',
  'Северный', 'Южный порт', 'Солнечный', 'Огни', 'Каменка', 'Рябиновка', 'Затон', 'Слобода',
  'Полянка', 'Хамовники', 'Марьино', 'Текстильщики', 'Дубки', 'Пресня', 'Кузьминки',
  'Зелёный', 'Сосновый бор', 'Мосты', 'Литейный', 'Сити', 'Набережный', 'Гавань', 'Химики'];
export function districtAt(x, y) {
  return DISTRICTS[hashU(Math.floor(x / 3200), Math.floor(y / 3200), 555) % DISTRICTS.length];
}

// ---------------------------------------------------------------- кварталы
const blockCache = new Map();
export function getBlock(i, j) {
  const key = i + ',' + j;
  let b = blockCache.get(key);
  if (!b) {
    if (blockCache.size > 3000) {
      let n = 0;
      for (const k of blockCache.keys()) { blockCache.delete(k); if (++n > 800) break; }
    }
    b = genBlock(i, j);
    blockCache.set(key, b);
  }
  return b;
}
export const blockAt = (x, y) => getBlock(colAt(x), rowAt(y));

const ROOFS = ['#1c1e23', '#212328', '#18191d', '#23221f', '#1c2028', '#151619', '#26272b', '#1f1d1b'];
const WALLS = ['#0d0f13', '#121316', '#0e1118', '#141216', '#101315'];
const HOUSE_ROOFS = ['#2e221d', '#25262b', '#222a22', '#33271f', '#2b2421', '#22242c'];
const CONT = ['#7a2e2a', '#2e4f7a', '#2f6a3a', '#8a6a2a', '#5a5a5e', '#7a4a1e', '#2e6a6a'];
const NEON = ['pink', 'cyan', 'green', 'purple', 'yellow', 'blue'];

function genBlock(i, j) {
  const bx0 = roadX(i) + widthX(i) / 2, bx1 = roadX(i + 1) - widthX(i + 1) / 2;
  const by0 = roadY(j) + widthY(j) / 2, by1 = roadY(j + 1) - widthY(j + 1) / 2;
  const r = rng(hashU(i, j, 999));
  const B = {
    i, j, x0: bx0, y0: by0, x1: bx1, y1: by1,
    lx0: bx0 + SW, ly0: by0 + SW, lx1: bx1 - SW, ly1: by1 - SW,
    cx: (bx0 + bx1) / 2, cy: (by0 + by1) / 2,
    lotColor: PAL.court, ground: [], buildings: [], trees: [], lamps: [], parked: [],
    props: [], boxes: [], circles: [], ponds: [], type: '',
  };
  B.diags = diagsInRect(bx0, by0, bx1, by1, DIAG_W / 2 + SW + 10);
  B.rail = hasRail(i) ? railX(i) : null;
  B.river = false;
  for (let m = Math.floor((by0 - 300) / RP); m <= Math.floor((by1 + 300) / RP); m++) {
    if (!riverExists(m)) continue;
    const [lo, hi] = riverSpan(m, bx0, bx1);
    if (hi + 40 > by0 && lo - 40 < by1) B.river = true;
  }

  const z = zoneAt(B.cx, B.cy);
  const cut = B.diags.length > 0 || B.rail !== null;
  let type;
  if (B.river) type = 'riverside';
  else if (z.park > 0.8) type = 'park';
  else if (z.ind > 0.63 && z.dens < 0.56) type = r() < 0.15 ? 'construction' : 'industrial';
  else {
    const s = r();
    if (s < 0.06) type = 'construction';
    else if (s < 0.11) type = 'park';
    else if (s < 0.13 && z.dens < 0.55) type = 'stadium';
    else if (s < 0.33) type = 'mixed';
    else if (z.dens > 0.65) type = 'towers';
    else if (z.dens > 0.55) type = 'perimeter';
    else if (z.dens > 0.47) type = 'micro';
    else if (z.dens > 0.41) type = 'mixed';
    else type = 'houses';
  }
  if (cut && (type === 'perimeter' || type === 'micro' || type === 'stadium' || type === 'construction')) type = 'mixed';
  B.type = type;
  B.dens = z.dens;
  B.streetTrees = type !== 'industrial' && type !== 'park' && r() < 0.6;

  LAYOUT[type](B, r, z.dens);
  if (B.rail !== null) railFences(B);
  streetLamps(B, r);
  B.ped = { x0: bx0 + 8, y0: by0 + 8, x1: bx1 - 8, y1: by1 - 8 };
  return B;
}

// ---------------------------------------------------------------- проверки размещения
function rectClear(B, x, y, w, h, margin = 4, inLot = true) {
  if (inLot && (x < B.lx0 - 0.01 || y < B.ly0 - 0.01 || x + w > B.lx1 + 0.01 || y + h > B.ly1 + 0.01)) return false;
  for (const d of B.diags) {
    const pad = (DIAG_W / 2 + SW + margin) * Math.SQRT2;
    let umin, umax;
    if (d.fam === 0) { umin = x + y; umax = x + w + y + h; } else { umin = x - (y + h); umax = x + w - y; }
    if (d.c > umin - pad && d.c < umax + pad) return false;
  }
  if (B.rail !== null && x < B.rail + RAIL_W / 2 + 14 + margin && x + w > B.rail - RAIL_W / 2 - 14 - margin) return false;
  if (B.river) {
    const nx = Math.max(2, Math.ceil(w / 50)), ny = Math.max(2, Math.ceil(h / 50));
    for (let a = 0; a <= nx; a++) for (let b = 0; b <= ny; b++) {
      if (riverDist(x + (w * a) / nx, y + (h * b) / ny) < margin + 26) return false;
    }
  }
  for (const p of B.ponds) {
    const qx = clamp(p.x, x, x + w), qy = clamp(p.y, y, y + h);
    const dx = (qx - p.x) / (p.rx + margin + 10), dy = (qy - p.y) / (p.ry + margin + 10);
    if (dx * dx + dy * dy < 1) return false;
  }
  return true;
}
function hitsSolid(B, x, y, w, h, m = 0) {
  for (const b of B.boxes) if (x < b.x + b.w + m && x + w > b.x - m && y < b.y + b.h + m && y + h > b.y - m) return true;
  return false;
}
function inKeepout(B, x, y, rad) {
  if (!B.keep) return false;
  for (const k of B.keep) if (x + rad > k.x && x - rad < k.x + k.w && y + rad > k.y && y - rad < k.y + k.h) return true;
  return false;
}
const keep = (B, x, y, w, h) => (B.keep || (B.keep = [])).push({ x, y, w, h });

// ---------------------------------------------------------------- добавление объектов
const op = (B, o) => B.ground.push(o);

function addBuilding(B, r, x, y, w, h, height, style, o = {}) {
  if (w < 8 || h < 8) return null;
  if (!rectClear(B, x, y, w, h, o.margin ?? 4)) return null;
  if (o.noOverlap && hitsSolid(B, x, y, w, h, 2)) return null;
  const b = {
    x, y, w, h, cx: x + w / 2, cy: y + h / 2, height, style, seed: (r() * 2147483647) | 0,
    roof: o.roof || r.pick(ROOFS), wall: o.wall || r.pick(WALLS),
    lit: 0, floorH: 20, details: [], glows: [], gable: false,
  };
  const S = STYLE[style];
  if (S) S(b, r);
  B.buildings.push(b);
  if (!o.noCollide) B.boxes.push({ x, y, w, h });
  return b;
}

function addTree(B, x, y, rad, kind) {
  if (!rectClear(B, x - rad * 0.5, y - rad * 0.5, rad, rad, 0)) return false;
  if (hitsSolid(B, x - rad * 0.6, y - rad * 0.6, rad * 1.2, rad * 1.2, 2)) return false;
  if (inKeepout(B, x, y, rad * 0.7)) return false;
  for (const t of B.trees) { const dx = t.x - x, dy = t.y - y; if (dx * dx + dy * dy < (t.r + rad) * (t.r + rad) * 0.35) return false; }
  B.trees.push({ x, y, r: rad, kind, v: (hash(x | 0, y | 0, 5) * 4) | 0 });
  B.circles.push({ x, y, r: rad * 0.38 });
  return true;
}
function scatterTrees(B, r, x, y, w, h, count, rmin = 14, rmax = 26, conifer = 0.2) {
  let placed = 0;
  for (let n = 0; n < count * 3 && placed < count; n++) {
    const rad = r.range(rmin, rmax);
    if (addTree(B, r.range(x + rad * 0.5, x + w - rad * 0.5), r.range(y + rad * 0.5, y + h - rad * 0.5), rad, r() < conifer ? 1 : 0)) placed++;
  }
}

function addLamp(B, x, y, lx, ly, rad, c, i = 1, pole = true, blink = 0, dot = false) {
  // столбы сталкиваются через списки фонарей чанков (car.js), чтобы их можно было сломать
  B.lamps.push({ x, y, lx, ly, r: rad, c, i, pole, blink, dot, broken: false });
}

const CAR_L = 46, CAR_W = 22;
function addParked(B, r, cx, cy, vertical, kind = 'car') {
  const L = kind === 'truck' ? 84 : CAR_L, W = kind === 'truck' ? 26 : CAR_W;
  const w = vertical ? W : L, h = vertical ? L : W;
  const x = cx - w / 2, y = cy - h / 2;
  if (!rectClear(B, x, y, w, h, 2)) return false;
  if (hitsSolid(B, x, y, w, h, 3)) return false;
  const a = (vertical ? Math.PI / 2 : 0) + (r() < 0.5 ? Math.PI : 0);
  B.parked.push({ x: cx, y: cy, a, kind, spr: (r() * 1000) | 0 });
  B.boxes.push({ x, y, w, h });
  return true;
}

// ---------------------------------------------------------------- стили зданий (крыши)
const STYLE = {
  tower(b, r) {
    b.lit = r.range(0.25, 0.6); b.floorMode = true; b.floorH = 18;
    b.details.push({ t: 'rs', x: b.x + 5, y: b.y + 5, w: b.w - 10, h: b.h - 10, c: '#0f1013', lw: 2 });
    if (r() < 0.35 && b.w > 70 && b.h > 70) {
      b.details.push({ t: 'c', x: b.cx, y: b.cy, r: Math.min(b.w, b.h) * 0.3, c: '#202226' });
      b.details.push({ t: 'H', x: b.cx, y: b.cy, s: Math.min(b.w, b.h) * 0.18 });
      b.glows.push({ x: b.cx, y: b.cy, r: Math.min(b.w, b.h) * 0.35, c: 'yellow', i: 0.25 });
    } else {
      roofBoxes(b, r, r.int(2, 6));
    }
    if (b.height > 260) {
      for (const [px, py] of corners(b, 6)) b.glows.push({ x: px, y: py, r: 22, c: 'red', i: 0.9, blink: 1.2 });
    }
    if (r() < 0.45) { b.glass = r.pick(['green', 'silver', 'silver', 'cyan', 'purple']); b.lit = 0; }
    else if (r() < 0.15) b.crown = r.pick(NEON);
    if (r() < 0.12) b.details.push({ t: 'r', x: b.x + b.w * 0.2, y: b.y + b.h * 0.2, w: b.w * 0.6, h: b.h * 0.35, c: '#17241a' });
  },
  office(b, r) {
    b.lit = r.range(0.2, 0.5); b.floorMode = true; b.floorH = 18;
    b.details.push({ t: 'rs', x: b.x + 4, y: b.y + 4, w: b.w - 8, h: b.h - 8, c: '#0f1013', lw: 2 });
    roofBoxes(b, r, r.int(2, 5));
    if (r() < 0.35) { b.glass = r.pick(['silver', 'silver', 'green', 'cyan']); b.lit = 0; }
    else if (r() < 0.12) b.crown = r.pick(NEON);
  },
  resid(b, r) {
    b.lit = r.range(0.2, 0.5); b.floorH = 20;
    roofBoxes(b, r, r.int(1, 3));
    if (r() < 0.5) b.details.push({ t: 'ant', x: b.x + r.range(8, b.w - 8), y: b.y + r.range(8, b.h - 8) });
  },
  panel(b, r) {
    b.lit = r.range(0.15, 0.45); b.floorH = 18;
    const long = b.w > b.h;
    const n = Math.max(1, Math.round((long ? b.w : b.h) / 90));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const cx = long ? b.x + b.w * t : b.cx, cy = long ? b.cy : b.y + b.h * t;
      b.details.push({ t: 'r', x: cx - 8, y: cy - 7, w: 16, h: 14, c: '#26282d' });
    }
    b.details.push({ t: 'rs', x: b.x + 3, y: b.y + 3, w: b.w - 6, h: b.h - 6, c: '#2a2c31', lw: 1.5 });
  },
  house(b, r) {
    b.lit = r.range(0.2, 0.6); b.floorH = b.height / 2; b.gable = true;
    b.roof = r.pick(HOUSE_ROOFS); b.wall = '#2b2724';
    b.details.push({ t: 'r', x: b.x + b.w * r.range(0.15, 0.75), y: b.y + b.h * r.range(0.15, 0.7), w: 7, h: 7, c: '#3a2a24' });
  },
  warehouse(b, r) {
    b.lit = 0.04; b.floorH = b.height;
    b.roof = r.pick(['#4b4f55', '#55534d', '#3f4a52']);
    const long = b.w > b.h;
    const step = 22;
    const len = long ? b.w : b.h;
    for (let s = step; s < len - 4; s += step) {
      b.details.push(long ? { t: 'r', x: b.x + s, y: b.y + 2, w: 1.5, h: b.h - 4, c: '#3a3d42' } : { t: 'r', x: b.x + 2, y: b.y + s, w: b.w - 4, h: 1.5, c: '#3a3d42' });
    }
    const nsky = r.int(2, 6);
    for (let k = 0; k < nsky; k++) {
      const t = (k + 0.5) / nsky;
      const sx = long ? b.x + b.w * t - 7 : b.cx - 12, sy = long ? b.cy - 12 : b.y + b.h * t - 7;
      const w = long ? 14 : 24, h = long ? 24 : 14;
      b.details.push({ t: 'r', x: sx, y: sy, w, h, c: '#c8a860' });
      b.glows.push({ x: sx + w / 2, y: sy + h / 2, r: 26, c: 'sodium', i: 0.35 });
    }
  },
  container(b, r) { b.roof = r.pick(CONT); b.wall = '#1c1c1e'; b.lit = 0; b.floorH = b.height;
    const long = b.w > b.h;
    for (let s = 6; s < (long ? b.w : b.h) - 3; s += 6) b.details.push(long ? { t: 'r', x: b.x + s, y: b.y + 1, w: 1, h: b.h - 2, c: 'rgba(0,0,0,0.25)' } : { t: 'r', x: b.x + 1, y: b.y + s, w: b.w - 2, h: 1, c: 'rgba(0,0,0,0.25)' });
  },
  cabin(b, r) { b.roof = r.pick(['#2f5a8a', '#3a6a9a', '#8a8a8a']); b.wall = '#1a2030'; b.lit = 0.5; b.floorH = b.height; },
  canopy(b) { b.roof = '#d0d0cc'; b.wall = '#30302e'; b.lit = 0; b.floorH = b.height;
    b.details.push({ t: 'rs', x: b.x + 2, y: b.y + 2, w: b.w - 4, h: b.h - 4, c: '#e8402a', lw: 4 });
  },
  shop(b, r) { b.lit = 0.55; b.floorH = 22; roofBoxes(b, r, r.int(1, 3)); if (r() < 0.12) { b.glass = r.pick(['silver', 'cyan']); b.lit = 0; } else if (r() < 0.15) b.crown = r.pick(NEON); },
  stall(b, r) { b.roof = r.pick(['#8a3a3a', '#3a6a8a', '#8a7a3a', '#3a8a5a', '#7a3a7a']); b.lit = 0; b.floorH = b.height;
    b.details.push({ t: 'r', x: b.x, y: b.cy - 0.75, w: b.w, h: 1.5, c: 'rgba(255,255,255,0.35)' });
  },
  stands(b, r) { b.roof = '#3a3d44'; b.wall = '#202228'; b.lit = 0.1; b.floorH = 10;
    const long = b.w > b.h;
    for (let s = 6; s < (long ? b.h : b.w); s += 7) b.details.push(long ? { t: 'r', x: b.x + 2, y: b.y + s, w: b.w - 4, h: 1.5, c: '#5a5d66' } : { t: 'r', x: b.x + s, y: b.y + 2, w: 1.5, h: b.h - 4, c: '#5a5d66' });
  },
  church(b, r) {
    b.roof = '#6a5a48'; b.wall = '#3a3430'; b.lit = 0.15; b.floorH = b.height / 3;
    const s = Math.min(b.w, b.h);
    b.details.push({ t: 'c', x: b.cx, y: b.cy, r: s * 0.3, c: '#c9a04a' });
    b.details.push({ t: 'c', x: b.cx - s * 0.08, y: b.cy - s * 0.08, r: s * 0.12, c: '#f0d27a' });
    b.details.push({ t: 'cross', x: b.cx, y: b.cy, s: s * 0.18 });
    b.glows.push({ x: b.cx, y: b.cy, r: s * 0.7, c: 'warm', i: 0.5 });
  },
  pavilion(b) { b.roof = '#5a6a5a'; b.lit = 0; b.floorH = b.height; },
  mast(b) { b.roof = '#666'; b.wall = '#333'; b.lit = 0; b.floorH = b.height; b.thin = true;
    b.glows.push({ x: b.cx, y: b.cy, r: 70, c: 'white', i: 1 });
    b.details.push({ t: 'r', x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8, c: '#f4f4ff' });
  },
  chimney(b, r) { b.cyl = true; b.roof = '#5a4a44'; b.wall = '#3a302c'; b.lit = 0;
    b.details.push({ t: 'c', x: b.cx, y: b.cy, r: b.w * 0.33, c: '#111' });
    b.glows.push({ x: b.cx + b.w * 0.5, y: b.cy, r: 24, c: 'red', i: 1, blink: 1.6 });
    b.glows.push({ x: b.cx - b.w * 0.5, y: b.cy, r: 24, c: 'red', i: 1, blink: 1.6 });
  },
  skeleton(b, r) { b.skeleton = true; b.floorH = 24; b.roof = '#6a6a6a'; b.wall = '#555'; },
  crane(b, r) {
    b.crane = { len: r.range(240, 340), back: r.range(70, 100), speed: r.range(0.04, 0.12) * (r() < 0.5 ? -1 : 1), a0: r() * 6.28 };
    b.roof = '#c9a227'; b.wall = '#7a6418'; b.lit = 0; b.floorH = b.height;
  },
};

function roofBoxes(b, r, n) {
  for (let k = 0; k < n; k++) {
    const w = r.range(8, Math.min(26, b.w * 0.35)), h = r.range(8, Math.min(26, b.h * 0.35));
    const x = r.range(b.x + 6, b.x + b.w - w - 6), y = r.range(b.y + 6, b.y + b.h - h - 6);
    b.details.push({ t: 'r', x, y, w, h, c: r.pick(['#2b2d32', '#26282c', '#313338']) });
    if (r() < 0.5) b.details.push({ t: 'c', x: x + w / 2, y: y + h / 2, r: Math.min(w, h) * 0.3, c: '#141518' });
  }
}
const corners = (b, ins) => [[b.x + ins, b.y + ins], [b.x + b.w - ins, b.y + ins], [b.x + b.w - ins, b.y + b.h - ins], [b.x + ins, b.y + b.h - ins]];

// ---------------------------------------------------------------- вспомогательное
function bsp(rect, min, depth, r) {
  const { x, y, w, h } = rect;
  if (depth <= 0 || (w < min * 2 && h < min * 2)) return [rect];
  const horiz = w < min * 2 ? false : h < min * 2 ? true : w > h ? true : w < h ? false : r() < 0.5;
  if (horiz) {
    const s = r.range(Math.max(min, w * 0.35), Math.min(w - min, w * 0.65));
    return [...bsp({ x, y, w: s, h }, min, depth - 1, r), ...bsp({ x: x + s, y, w: w - s, h }, min, depth - 1, r)];
  }
  const s = r.range(Math.max(min, h * 0.35), Math.min(h - min, h * 0.65));
  return [...bsp({ x, y, w, h: s }, min, depth - 1, r), ...bsp({ x, y: y + s, w, h: h - s }, min, depth - 1, r)];
}
const lot = (B) => ({ x: B.lx0, y: B.ly0, w: B.lx1 - B.lx0, h: B.ly1 - B.ly0 });

function shopLights(B, r, x, y, w, h, tol = 2, p = 0.5) {
  // цепочки ярких LED-точек и витрины вдоль фасадов, обращённых к улице
  const sides = [];
  if (y - B.ly0 < tol) sides.push([x, y - 7, x + w, y - 7]);
  if (B.ly1 - (y + h) < tol) sides.push([x, y + h + 7, x + w, y + h + 7]);
  if (x - B.lx0 < tol) sides.push([x - 7, y, x - 7, y + h]);
  if (B.lx1 - (x + w) < tol) sides.push([x + w + 7, y, x + w + 7, y + h]);
  for (const [ax, ay, bx, by] of sides) {
    const len = Math.hypot(bx - ax, by - ay);
    if (r() < p) {
      const c = r.pick(LED);
      const t0 = r.range(0, len * 0.4), t1 = r.range(len * 0.6, len);
      const step = r.range(13, 19);
      for (let t = t0 + 6; t < t1 - 6; t += step) {
        const px = ax + ((bx - ax) * t) / len, py = ay + ((by - ay) * t) / len;
        addLamp(B, px, py, px, py, 26, c, 0.9, false, 0, true);
      }
    } else if (r() < 0.5) {
      const t = r.range(20, Math.max(21, len - 20));
      const px = ax + ((bx - ax) * t) / len, py = ay + ((by - ay) * t) / len;
      addLamp(B, px, py, px, py, r.range(40, 60), r() < 0.6 ? 'warm' : r.pick(NEON), 0.6, false);
    }
  }
}
const LED = ['white', 'white', 'white', 'purple', 'purple', 'pink', 'cyan', 'warm'];

// ---------------------------------------------------------------- планировки
const LAYOUT = {
  perimeter(B, r, dens) {
    B.lotColor = PAL.court;
    const L = lot(B);
    const d = r.range(80, 110);
    const hBase = lerp(80, 150, clamp((dens - 0.5) / 0.15, 0, 1));
    const gapSide = r.int(0, 3);
    const sides = [
      { a: L.x, b: L.x + L.w, horiz: true, fixed: L.y, out: -1 },
      { a: L.x, b: L.x + L.w, horiz: true, fixed: L.y + L.h, out: 1 },
      { a: L.y + d, b: L.y + L.h - d, horiz: false, fixed: L.x, out: -1 },
      { a: L.y + d, b: L.y + L.h - d, horiz: false, fixed: L.x + L.w, out: 1 },
    ];
    sides.forEach((s, si) => {
      const gapAt = si === gapSide ? lerp(s.a, s.b, r.range(0.3, 0.6)) : Infinity;
      let pos = s.a;
      const ht = hBase * r.range(0.85, 1.15);
      while (pos < s.b - 1) {
        let seg = r.range(90, 200);
        if (s.b - pos - seg < 70) seg = s.b - pos;
        let end = pos + seg;
        let next = end;
        if (pos <= gapAt && end > gapAt) { end = gapAt; next = gapAt + 46; }
        const len = end - pos;
        if (len > 24) {
          const dd = d - r.range(0, 14);
          const height = ht * r.range(0.85, 1.12);
          let x, y, w, h;
          if (s.horiz) { x = pos; w = len; h = dd; y = s.out < 0 ? s.fixed : s.fixed - dd; }
          else { y = pos; h = len; w = dd; x = s.out < 0 ? s.fixed : s.fixed - dd; }
          if (addBuilding(B, r, x, y, w, h, height, 'resid')) shopLights(B, r, x, y, w, h);
        }
        pos = next;
      }
    });
    const ix = L.x + d, iy = L.y + d, iw = L.w - 2 * d, ih = L.h - 2 * d;
    courtyard(B, r, ix, iy, iw, ih);
  },

  towers(B, r, dens) {
    B.lotColor = PAL.paving;
    const parcels = bsp(lot(B), 200, 2, r);
    for (const P of parcels) {
      const roll = r();
      if (roll < 0.7) {
        const ins = r.range(16, 40);
        const x = P.x + ins, y = P.y + ins, w = P.w - 2 * ins, h = P.h - 2 * ins;
        if (w < 60 || h < 60) continue;
        const height = lerp(240, 520, clamp((dens - 0.6) / 0.15, 0, 1)) * r.range(0.65, 1.15);
        if (r() < 0.35 && w > 150 && h > 150) {
          addBuilding(B, r, x, y, w, h, r.range(40, 70), 'office');
          const ti = r.range(25, 45);
          addBuilding(B, r, x + ti, y + ti, w - 2 * ti, h - 2 * ti, height, 'tower', { noCollide: true });
        } else {
          addBuilding(B, r, x, y, w, h, height, r() < 0.7 ? 'tower' : 'office');
        }
        shopLights(B, r, x, y, w, h, 60, 0.6);
        scatterTrees(B, r, P.x, P.y, P.w, P.h, 4, 10, 16, 0);
      } else if (roll < 0.85) plaza(B, r, P);
      else parking(B, r, P);
    }
  },

  micro(B, r) {
    B.lotColor = PAL.yard;
    const V = r() < 0.5;
    const Lw = B.lx1 - B.lx0, Lh = B.ly1 - B.ly0;
    const U = V ? Lh : Lw, VV = V ? Lw : Lh;
    const map = (u, v, uw, vh) => (V ? { x: B.lx0 + v, y: B.ly0 + u, w: vh, h: uw } : { x: B.lx0 + u, y: B.ly0 + v, w: uw, h: vh });
    const n = clamp(Math.floor(VV / 210), 2, 3);
    const band = VV / n;
    for (let k = 0; k < n; k++) {
      const depth = r.range(46, 58);
      const len = U * r.range(0.55, 0.85);
      const u0 = r.range(10, U - len - 10);
      const v0 = k * band + r.range(18, Math.max(20, band - depth - 96));
      const s = map(u0, v0, len, depth);
      if (r() < 0.25) {
        // точечная башня вместо пластины
        const t = map(u0 + len * 0.3, v0 - 10, 70, 70);
        addBuilding(B, r, t.x, t.y, t.w, t.h, r.range(220, 300), 'panel');
      } else addBuilding(B, r, s.x, s.y, s.w, s.h, r.range(140, 230), 'panel');
      // проезд вдоль дома и парковка
      const dv = v0 + depth + 16;
      const dr = map(0, dv, U, 30);
      op(B, { t: 'r', ...dr, c: PAL.lotAsph });
      keep(B, dr.x, dr.y, dr.w, dr.h);
      for (let u = 30; u < U - 30; u += 28) {
        if (r() < 0.45) continue;
        const c = map(u, dv + 30 + 25, 0, 0);
        if (r() < 0.9) addParked(B, r, c.x, c.y, !V);
      }
      for (let u = 60; u < U - 40; u += 150) {
        const p = map(u, dv - 6, 0, 0);
        addLamp(B, p.x, p.y, p.x, p.y, 130, 'sodium', 0.8);
      }
    }
    const pg = map(r.range(20, U - 110), r.range(20, VV - 110), 80, 80);
    if (rectClear(B, pg.x, pg.y, pg.w, pg.h) && !hitsSolid(B, pg.x, pg.y, pg.w, pg.h, 4) && !inKeepout(B, pg.x + 40, pg.y + 40, 40)) playground(B, r, pg);
    scatterTrees(B, r, B.lx0, B.ly0, Lw, Lh, Math.floor((Lw * Lh) / 9000), 14, 26, 0.25);
  },

  houses(B, r) {
    B.lotColor = PAL.yard;
    const V = r() < 0.5;
    const Lw = B.lx1 - B.lx0, Lh = B.ly1 - B.ly0;
    const U = V ? Lh : Lw, VV = V ? Lw : Lh;
    const map = (u, v, uw, vh) => (V ? { x: B.lx0 + v, y: B.ly0 + u, w: vh, h: uw } : { x: B.lx0 + u, y: B.ly0 + v, w: uw, h: vh });
    const lane = VV > 380;
    const laneW = 30;
    const halves = lane ? [[0, VV / 2 - laneW / 2], [VV / 2 + laneW / 2, VV]] : [[0, VV]];
    if (lane) {
      const lr = map(0, VV / 2 - laneW / 2, U, laneW);
      op(B, { t: 'r', ...lr, c: PAL.lotAsph });
      keep(B, lr.x, lr.y, lr.w, lr.h);
      for (let u = 80; u < U - 40; u += 170) { const p = map(u, VV / 2 - laneW / 2 - 4, 0, 0); addLamp(B, p.x, p.y, p.x, p.y + 0, 110, 'sodium', 0.7); }
    }
    for (const [va, vb] of halves) {
      const rows = Math.max(1, Math.floor((vb - va) / 140));
      const rh = (vb - va) / rows;
      const cols = Math.max(1, Math.floor(U / r.range(120, 160)));
      const cw = U / cols;
      for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
        const P = map(cc * cw, va + rr * rh, cw, rh);
        op(B, { t: 'rs', x: P.x + 2, y: P.y + 2, w: P.w - 4, h: P.h - 4, c: '#5c5040', lw: 1.5 });
        const hw = Math.min(P.w - 34, r.range(50, 80)), hh = Math.min(P.h - 40, r.range(44, 70));
        if (hw < 30 || hh < 30) continue;
        const hx = r.range(P.x + 12, P.x + P.w - hw - 12), hy = r.range(P.y + 12, P.y + P.h - hh - 12);
        const b = addBuilding(B, r, hx, hy, hw, hh, r.range(30, 46), 'house');
        if (!b) continue;
        if (r() < 0.5) addLamp(B, hx + hw / 2, hy + hh + 6, hx + hw / 2, hy + hh + 6, 60, 'warm', 0.5, false);
        // бассейн
        if (r() < 0.25) {
          const pw = 26, ph = 40;
          const px = hx + hw + 14 + pw < P.x + P.w - 6 ? hx + hw + 12 : hx - pw - 12;
          const py = clamp(hy, P.y + 8, P.y + P.h - ph - 8);
          if (px > P.x + 6 && px + pw < P.x + P.w - 6) {
            op(B, { t: 'r', x: px - 3, y: py - 3, w: pw + 6, h: ph + 6, c: '#9a968c' });
            op(B, { t: 'r', x: px, y: py, w: pw, h: ph, c: '#2aa5c0' });
            addLamp(B, px + pw / 2, py + ph / 2, px + pw / 2, py + ph / 2, 55, 'cyan', 0.8, false);
            keep(B, px - 3, py - 3, pw + 6, ph + 6);
          }
        }
        if (r() < 0.4) addParked(B, r, clamp(hx - 18, P.x + 14, P.x + P.w - 14), clamp(hy + hh / 2, P.y + 26, P.y + P.h - 26), true);
        scatterTrees(B, r, P.x + 6, P.y + 6, P.w - 12, P.h - 12, r.int(1, 3), 10, 18, 0.3);
      }
    }
  },

  industrial(B, r) {
    B.lotColor = PAL.lotAsph;
    const parcels = bsp(lot(B), 220, 2, r);
    for (const P of parcels) {
      const roll = r();
      if (roll < 0.5) {
        const ins = r.range(16, 30);
        addBuilding(B, r, P.x + ins, P.y + ins, P.w - 2 * ins, P.h - 2 * ins, r.range(48, 76), 'warehouse');
      } else if (roll < 0.8) {
        const vert = r() < 0.5;
        const cw = vert ? 18 : 50, ch = vert ? 50 : 18;
        for (let y = P.y + 20; y + ch < P.y + P.h - 16; y += ch + (vert ? 22 : 6)) {
          for (let x = P.x + 20; x + cw < P.x + P.w - 16; x += cw + (vert ? 4 : 22)) {
            if (r() < 0.2) continue;
            addBuilding(B, r, x, y, cw, ch, r() < 0.5 ? 16 : 32, 'container', { margin: 2 });
          }
        }
      } else {
        for (let x = P.x + 30; x < P.x + P.w - 30; x += 40) if (r() < 0.6) addParked(B, r, x, P.y + P.h / 2, true, 'truck');
        if (r() < 0.5) {
          const s = r.range(26, 34);
          addBuilding(B, r, P.x + 20, P.y + 20, s, s, r.range(320, 460), 'chimney');
        }
      }
    }
    const n = r.int(3, 5);
    for (let k = 0; k < n; k++) {
      const x = r.range(B.lx0 + 10, B.lx1 - 10), y = r.range(B.ly0 + 10, B.ly1 - 10);
      if (!hitsSolid(B, x - 4, y - 4, 8, 8)) addLamp(B, x, y, x, y, 240, 'white', 0.9);
    }
  },

  park(B, r) {
    B.lotColor = PAL.grass;
    parkIn(B, r, lot(B), true);
  },

  construction(B, r) {
    B.lotColor = PAL.dirt;
    const L = lot(B);
    constructionIn(B, r, L);
  },

  stadium(B, r) {
    B.lotColor = PAL.paving;
    const L = lot(B);
    const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
    const rx = Math.min(L.w * 0.36, L.w / 2 - 92), ry = Math.min(L.h * 0.3, L.h / 2 - 92);
    op(B, { t: 'e', x: cx, y: cy, rx: rx + 34, ry: ry + 34, c: PAL.rubber });
    op(B, { t: 'e', x: cx, y: cy, rx, ry, c: '#3f6a34' });
    const fw = rx * 1.3, fh = ry * 1.25;
    op(B, { t: 'rs', x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh, c: '#e8e8e0', lw: 2 });
    op(B, { t: 'l', pts: [cx, cy - fh / 2, cx, cy + fh / 2], c: '#e8e8e0', lw: 2 });
    op(B, { t: 'cs', x: cx, y: cy, r: Math.min(fw, fh) * 0.16, c: '#e8e8e0', lw: 2 });
    for (let k = 0; k < 4; k++) op(B, { t: 'e', x: cx, y: cy, rx: rx + 8 + k * 8, ry: ry + 8 + k * 8, c: 'rgba(255,255,255,0.35)', stroke: 1 });
    const sd = 40;
    addBuilding(B, r, cx - rx, cy - ry - 34 - sd - 6, rx * 2, sd, 34, 'stands');
    addBuilding(B, r, cx - rx, cy + ry + 34 + 6, rx * 2, sd, 34, 'stands');
    addBuilding(B, r, cx - rx - 34 - sd - 6, cy - ry * 0.7, sd, ry * 1.4, 30, 'stands');
    addBuilding(B, r, cx + rx + 34 + 6, cy - ry * 0.7, sd, ry * 1.4, 30, 'stands');
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const mx = cx + sx * (rx + 40), my = cy + sy * (ry + 40);
      addBuilding(B, r, mx - 6, my - 6, 12, 12, 220, 'mast', { margin: 0 });
      addLamp(B, mx, my, cx + sx * rx * 0.4, cy + sy * ry * 0.4, 380, 'white', 0.9, false);
    }
  },

  mixed(B, r) {
    B.lotColor = PAL.court;
    let rects = [lot(B)];
    if (B.rail !== null) {
      const L = lot(B);
      const a = B.rail - RAIL_W / 2 - 16, b = B.rail + RAIL_W / 2 + 16;
      rects = [{ x: L.x, y: L.y, w: a - L.x, h: L.h }, { x: b, y: L.y, w: L.x + L.w - b, h: L.h }];
    }
    const subs = ['shops', 'shops', 'shops', 'office', 'office', 'parking', 'parking', 'gas', 'square', 'playground', 'church', 'market', 'smallpark', 'smallpark', 'build'];
    for (const R of rects) {
      for (const P of bsp(R, 180, 2, r)) {
        if (P.w < 60 || P.h < 60) continue;
        SUB[r.pick(subs)](B, r, P);
      }
    }
    if (B.diags.length) {
      // клинья у диагоналей — газоны с деревьями
      scatterTrees(B, r, B.lx0, B.ly0, B.lx1 - B.lx0, B.ly1 - B.ly0, 10, 12, 22, 0.2);
    }
  },

  riverside(B, r) {
    B.lotColor = PAL.grass;
    // набережные: прогулочная дорожка и фонари вдоль берега
    for (let m = Math.floor((B.y0 - 300) / RP); m <= Math.floor((B.y1 + 300) / RP); m++) {
      if (!riverExists(m)) continue;
      for (const side of [-1, 1]) {
        const pts = [];
        const lampPts = [];
        for (let x = B.lx0; x <= B.lx1; x += 12) {
          const ry = riverY(m, x), hw = riverHV(m, x);
          const y = ry + side * (hw + 30);
          if (y > B.ly0 + 8 && y < B.ly1 - 8) { pts.push(x, y); if (Math.round(x - B.lx0) % 96 < 12) lampPts.push([x, ry + side * (hw + 14)]); }
          else if (pts.length) { op(B, { t: 'l', pts: pts.slice(), c: PAL.paving, lw: 24 }); pts.length = 0; }
        }
        if (pts.length > 2) op(B, { t: 'l', pts, c: PAL.paving, lw: 24 });
        for (const [x, y] of lampPts) if (y > B.ly0 && y < B.ly1) addLamp(B, x, y, x, y, 130, 'warm', 0.85);
      }
    }
    const L = lot(B);
    for (let k = 0; k < 3; k++) {
      const w = r.range(40, 70), h = r.range(40, 70);
      addBuilding(B, r, r.range(L.x, L.x + L.w - w), r.range(L.y, L.y + L.h - h), w, h, r.range(30, 60), 'shop', { margin: 40, noOverlap: true });
    }
    scatterTrees(B, r, L.x, L.y, L.w, L.h, Math.floor((L.w * L.h) / 7000), 14, 26, 0.25);
  },
};

// ---------------------------------------------------------------- под-участки смешанных кварталов
const SUB = {
  shops(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.paving });
    const parts = bsp({ x: P.x + 8, y: P.y + 8, w: P.w - 16, h: P.h - 16 }, 70, 2, r);
    for (const Q of parts) {
      const ins = r.range(4, 12);
      const x = Q.x + ins, y = Q.y + ins, w = Q.w - 2 * ins, h = Q.h - 2 * ins;
      const b = addBuilding(B, r, x, y, w, h, r.range(40, 110), r() < 0.5 ? 'shop' : 'resid');
      if (b) shopLights(B, r, x, y, w, h);
    }
  },
  office(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.lotAsph });
    const ins = r.range(20, 40);
    const b = addBuilding(B, r, P.x + ins, P.y + ins, P.w - 2 * ins, P.h - 2 * ins, r.range(90, 230), 'office');
    if (!b) { SUB.smallpark(B, r, P); return; }
    for (let x = P.x + 20; x < P.x + P.w - 20; x += 28) if (r() < 0.5) addParked(B, r, x, P.y + ins / 2 + 2, true);
    addLamp(B, P.x + 8, P.y + 8, P.x + 8, P.y + 8, 120, 'white', 0.7);
  },
  parking(B, r, P) { parking(B, r, P); },
  gas(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.concrete });
    const cw = Math.min(P.w - 40, 130), ch = Math.min(P.h - 60, 80);
    const cx = P.x + 20, cy = P.y + 20;
    if (cw > 60 && ch > 40) {
      const c = addBuilding(B, r, cx, cy, cw, ch, 26, 'canopy', { noCollide: true });
      if (c) {
        for (let k = 0; k < 3; k++) {
          const px = cx + (cw * (k + 0.5)) / 3;
          op(B, { t: 'r', x: px - 4, y: cy + ch / 2 - 8, w: 8, h: 16, c: '#c83a2a' });
          B.boxes.push({ x: px - 4, y: cy + ch / 2 - 8, w: 8, h: 16 });
        }
        addLamp(B, cx + cw / 2, cy + ch / 2, cx + cw / 2, cy + ch / 2, 230, 'white', 1, false);
        c.glows.push({ x: cx + 10, y: cy + 10, r: 30, c: r.pick(['green', 'red', 'yellow']), i: 0.8 });
      }
    }
    addBuilding(B, r, P.x + P.w - 70, P.y + P.h - 60, 50, 40, 28, 'shop');
    if (r() < 0.6) addParked(B, r, P.x + P.w - 110, P.y + P.h - 40, false);
  },
  square(B, r, P) { plaza(B, r, P); },
  playground(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.grass });
    const s = Math.min(90, P.w - 20, P.h - 20);
    playground(B, r, { x: P.x + (P.w - s) / 2, y: P.y + (P.h - s) / 2, w: s, h: s });
    scatterTrees(B, r, P.x, P.y, P.w, P.h, 6, 12, 22);
  },
  church(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.paving });
    const s = Math.min(P.w, P.h) * 0.5;
    if (s < 50) return SUB.smallpark(B, r, P);
    const b = addBuilding(B, r, P.x + (P.w - s) / 2, P.y + (P.h - s) / 2, s, s, r.range(60, 90), 'church');
    if (b) for (const [px, py] of corners(b, -14)) addLamp(B, px, py, b.cx + (px - b.cx) * 0.5, b.cy + (py - b.cy) * 0.5, 120, 'warm', 0.8, false);
    scatterTrees(B, r, P.x, P.y, P.w, P.h, 8, 12, 18, 0.5);
  },
  market(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.paving });
    for (let y = P.y + 16; y + 26 < P.y + P.h - 10; y += 50) {
      for (let x = P.x + 16; x + 30 < P.x + P.w - 10; x += 36) {
        if (r() < 0.15) continue;
        addBuilding(B, r, x, y, 30, 26, 14, 'stall', { margin: 2 });
      }
      for (let x = P.x + 20; x < P.x + P.w - 20; x += 18) addLamp(B, x, y + 38, x, y + 38, 26, r.pick(['yellow', 'pink', 'cyan', 'warm']), 0.6, false);
    }
  },
  smallpark(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.grass });
    parkIn(B, r, P, P.w > 220 && P.h > 220);
  },
  build(B, r, P) {
    op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.dirt });
    constructionIn(B, r, P);
  },
};

function courtyard(B, r, x, y, w, h) {
  if (w < 60 || h < 60) return;
  const ng = r.int(1, 3);
  for (let k = 0; k < ng; k++) {
    const gw = r.range(w * 0.25, w * 0.5), gh = r.range(h * 0.25, h * 0.5);
    op(B, { t: 'r', x: r.range(x + 10, x + w - gw - 10), y: r.range(y + 10, y + h - gh - 10), w: gw, h: gh, c: PAL.grass });
  }
  const s = Math.min(80, w * 0.3, h * 0.3);
  if (s > 40) playground(B, r, { x: x + r.range(10, w - s - 10), y: y + r.range(10, h - s - 10), w: s, h: s });
  for (let u = x + 30; u < x + w - 30; u += 28) if (r() < 0.55) addParked(B, r, u, y + 30, true);
  for (let u = x + 30; u < x + w - 30; u += 28) if (r() < 0.4) addParked(B, r, u, y + h - 30, true);
  scatterTrees(B, r, x + 10, y + 60, w - 20, h - 120, Math.floor((w * h) / 9000), 14, 24, 0.15);
  const nl = r.int(2, 4);
  for (let k = 0; k < nl; k++) {
    const px = r.range(x + 20, x + w - 20), py = r.range(y + 20, y + h - 20);
    if (!hitsSolid(B, px - 4, py - 4, 8, 8)) addLamp(B, px, py, px, py, 120, 'warm', 0.7);
  }
}

function playground(B, r, P) {
  op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.rubber });
  op(B, { t: 'r', x: P.x + 6, y: P.y + 6, w: P.w * 0.35, h: P.h * 0.35, c: PAL.sand });
  for (let k = 0; k < 4; k++) {
    const w = r.range(8, 20), h = r.range(8, 20);
    op(B, { t: 'r', x: r.range(P.x + 4, P.x + P.w - w - 4), y: r.range(P.y + 4, P.y + P.h - h - 4), w, h, c: r.pick(['#d0402a', '#2a7ad0', '#e0c02a', '#3aa04a']) });
  }
  keep(B, P.x, P.y, P.w, P.h);
}

function plaza(B, r, P) {
  op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.paving });
  for (let x = P.x + 20; x < P.x + P.w; x += 40) op(B, { t: 'r', x, y: P.y, w: 1, h: P.h, c: 'rgba(0,0,0,0.12)' });
  for (let y = P.y + 20; y < P.y + P.h; y += 40) op(B, { t: 'r', x: P.x, y, w: P.w, h: 1, c: 'rgba(0,0,0,0.12)' });
  const cx = P.x + P.w / 2, cy = P.y + P.h / 2;
  const fr = Math.min(36, Math.min(P.w, P.h) * 0.12);
  if (fr > 14 && rectClear(B, cx - fr, cy - fr, fr * 2, fr * 2)) {
    op(B, { t: 'c', x: cx, y: cy, r: fr + 6, c: '#9a948a' });
    op(B, { t: 'c', x: cx, y: cy, r: fr, c: '#2a8aa8' });
    op(B, { t: 'c', x: cx, y: cy, r: fr * 0.3, c: '#cfeaf2' });
    B.circles.push({ x: cx, y: cy, r: fr + 6 });
    addLamp(B, cx, cy, cx, cy, fr * 2.6, 'cyan', 0.6, false);
    keep(B, cx - fr - 10, cy - fr - 10, fr * 2 + 20, fr * 2 + 20);
  }
  const ring = Math.min(P.w, P.h) * 0.36;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    addTree(B, cx + Math.cos(a) * ring, cy + Math.sin(a) * ring, 13, 0);
  }
  for (const [px, py] of [[P.x + 12, P.y + 12], [P.x + P.w - 12, P.y + P.h - 12], [P.x + P.w - 12, P.y + 12], [P.x + 12, P.y + P.h - 12]]) addLamp(B, px, py, px, py, 120, 'white', 0.8);
}

function parking(B, r, P) {
  op(B, { t: 'r', x: P.x, y: P.y, w: P.w, h: P.h, c: PAL.lotAsph });
  const rowH = 50, aisle = 40;
  for (let y = P.y + 10; y + rowH <= P.y + P.h - 10; y += rowH * 2 + aisle) {
    for (let k = 0; k < 2; k++) {
      const ry = y + k * rowH;
      if (ry + rowH > P.y + P.h - 6) break;
      for (let x = P.x + 10; x + 26 <= P.x + P.w - 10; x += 28) {
        op(B, { t: 'r', x, y: ry, w: 1.5, h: rowH, c: 'rgba(230,230,220,0.7)' });
        if (r() < 0.55) addParked(B, r, x + 14, ry + rowH / 2, true);
      }
    }
  }
  for (let x = P.x + 40; x < P.x + P.w - 20; x += 140) for (let y = P.y + 30; y < P.y + P.h - 20; y += 160) {
    if (!hitsSolid(B, x - 4, y - 4, 8, 8)) addLamp(B, x, y, x, y, 160, 'white', 0.8);
  }
}

function parkIn(B, r, P, big) {
  const cx0 = P.x + P.w / 2, cy0 = P.y + P.h / 2;
  let cx = cx0, cy = cy0;
  if (big && r() < 0.6) {
    const rx = r.range(60, Math.min(170, P.w * 0.28)), ry = r.range(50, Math.min(140, P.h * 0.25));
    const px = r.range(P.x + rx + 40, P.x + P.w - rx - 40), py = r.range(P.y + ry + 40, P.y + P.h - ry - 40);
    if (rectClear(B, px - rx, py - ry, rx * 2, ry * 2, 10)) {
      op(B, { t: 'pond', x: px, y: py, rx, ry, seed: (r() * 1000) | 0 });
      B.ponds.push({ x: px, y: py, rx, ry });
      cx = cx0 + (cx0 - px) * 0.5; cy = cy0 + (cy0 - py) * 0.5;
      cx = clamp(cx, P.x + 60, P.x + P.w - 60); cy = clamp(cy, P.y + 60, P.y + P.h - 60);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * 6.283 + 0.3;
        const lx = px + Math.cos(a) * (rx + 18), ly = py + Math.sin(a) * (ry + 18);
        addLamp(B, lx, ly, lx, ly, 90, 'warm', 0.75);
      }
    }
  }
  // дорожки
  const ends = [[cx0, P.y], [cx0, P.y + P.h], [P.x, cy0], [P.x + P.w, cy0]];
  const pathPts = [];
  for (const [ex, ey] of ends) {
    if (r() < 0.2) continue;
    const mx = (ex + cx) / 2 + r.range(-60, 60), my = (ey + cy) / 2 + r.range(-60, 60);
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      pts.push(a * ex + b * mx + c * cx, a * ey + b * my + c * cy);
    }
    op(B, { t: 'l', pts, c: '#857d70', lw: 12 });
    for (let k = 0; k < pts.length; k += 2) pathPts.push([pts[k], pts[k + 1]]);
    let acc = 40;
    for (let k = 2; k < pts.length - 2; k += 2) {
      acc += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
      if (acc < 110) continue;
      acc = 0;
      addLamp(B, pts[k] + 9, pts[k + 1] + 9, pts[k] + 9, pts[k + 1] + 9, 110, 'warm', 0.7);
    }
  }
  op(B, { t: 'c', x: cx, y: cy, r: 26, c: '#857d70' });
  if (r() < 0.35) {
    op(B, { t: 'c', x: cx, y: cy, r: 14, c: '#9a948a' });
    op(B, { t: 'c', x: cx, y: cy, r: 10, c: '#2a8aa8' });
    addLamp(B, cx, cy, cx, cy, 60, 'cyan', 0.8, false);
    B.circles.push({ x: cx, y: cy, r: 14 });
  }
  B.paths = (B.paths || []).concat(pathPts);
  const count = Math.floor((P.w * P.h) / 3600);
  let placed = 0;
  for (let n = 0; n < count * 3 && placed < count; n++) {
    const rad = r.range(12, 28);
    const x = r.range(P.x + rad * 0.5, P.x + P.w - rad * 0.5), y = r.range(P.y + rad * 0.5, P.y + P.h - rad * 0.5);
    let ok = Math.hypot(x - cx, y - cy) > rad + 30;
    if (ok) for (const [px, py] of pathPts) if (Math.abs(px - x) < rad + 8 && Math.abs(py - y) < rad + 8) { ok = false; break; }
    if (ok && addTree(B, x, y, rad, r() < 0.3 ? 1 : 0)) placed++;
  }
}

function constructionIn(B, r, P) {
  const L = { x: P.x + 4, y: P.y + 4, w: P.w - 8, h: P.h - 8 };
  // забор с воротами
  const gate = r.int(0, 3);
  const gpos = r.range(0.3, 0.6);
  const fence = (ax, ay, bx, by, g) => {
    const segs = [];
    if (g) {
      const mx = ax + (bx - ax) * gpos, my = ay + (by - ay) * gpos;
      const len = Math.hypot(bx - ax, by - ay);
      const gx = ((bx - ax) / len) * 30, gy = ((by - ay) / len) * 30;
      segs.push([ax, ay, mx - gx, my - gy], [mx + gx, my + gy, bx, by]);
    } else segs.push([ax, ay, bx, by]);
    for (const [x0, y0, x1, y1] of segs) {
      op(B, { t: 'l', pts: [x0, y0, x1, y1], c: '#8f8f7c', lw: 3, cap: 'butt' });
      const bx0 = Math.min(x0, x1) - 2, by0 = Math.min(y0, y1) - 2;
      B.boxes.push({ x: bx0, y: by0, w: Math.abs(x1 - x0) + 4, h: Math.abs(y1 - y0) + 4 });
      const len = Math.hypot(x1 - x0, y1 - y0);
      for (let t = 30; t < len; t += 120) addLamp(B, x0 + ((x1 - x0) * t) / len, y0 + ((y1 - y0) * t) / len, x0 + ((x1 - x0) * t) / len, y0 + ((y1 - y0) * t) / len, 22, 'yellow', 0.9, false, 1);
    }
  };
  fence(L.x, L.y, L.x + L.w, L.y, gate === 0);
  fence(L.x + L.w, L.y, L.x + L.w, L.y + L.h, gate === 1);
  fence(L.x, L.y + L.h, L.x + L.w, L.y + L.h, gate === 2);
  fence(L.x, L.y, L.x, L.y + L.h, gate === 3);
  // кучи песка/щебня
  for (let k = 0; k < r.int(2, 5); k++) {
    const rr = r.range(14, 30);
    op(B, { t: 'c', x: r.range(L.x + 30, L.x + L.w - 30), y: r.range(L.y + 30, L.y + L.h - 30), r: rr, c: r.pick([PAL.sand, '#7a7468', '#8a6a48']) });
  }
  const ins = r.range(50, 90);
  const sw = L.w - 2 * ins, sh = L.h - 2 * ins;
  if (sw > 80 && sh > 80) {
    const w = Math.min(sw, r.range(140, 260)), h = Math.min(sh, r.range(120, 220));
    const x = L.x + ins + r.range(0, sw - w), y = L.y + ins + r.range(0, sh - h);
    op(B, { t: 'r', x: x - 6, y: y - 6, w: w + 12, h: h + 12, c: '#5a554e' });
    addBuilding(B, r, x, y, w, h, r.range(48, 220), 'skeleton');
    const cx = x + w + 30 < L.x + L.w - 10 ? x + w + 20 : x - 36;
    addBuilding(B, r, cx, y + h / 2 - 8, 16, 16, r.range(380, 480), 'crane', { margin: 0 });
  }
  // бытовки
  for (let k = 0; k < r.int(2, 4); k++) {
    const vert = r() < 0.5;
    addBuilding(B, r, r.range(L.x + 10, L.x + L.w - 50), r.range(L.y + 10, L.y + L.h - 50), vert ? 18 : 40, vert ? 40 : 18, 16, 'cabin', { noOverlap: true });
  }
  if (r() < 0.8) {
    const ex = r.range(L.x + 40, L.x + L.w - 40), ey = r.range(L.y + 40, L.y + L.h - 40);
    if (!hitsSolid(B, ex - 20, ey - 20, 40, 40)) {
      B.props.push({ t: 'excavator', x: ex, y: ey, a: r() * 6.28 });
      B.circles.push({ x: ex, y: ey, r: 16 });
    }
  }
  for (const [px, py] of [[L.x + 10, L.y + 10], [L.x + L.w - 10, L.y + L.h - 10]]) addLamp(B, px, py, px + (L.w > 0 ? 40 : 0), py + 40, 280, 'white', 0.9);
}

function railFences(B) {
  for (const s of [-1, 1]) {
    const x = B.rail + s * (RAIL_W / 2 + 12);
    op(B, { t: 'l', pts: [x, B.y0, x, B.y1], c: '#5a5c58', lw: 2, cap: 'butt', dash: [6, 3] });
  }
}

function streetLamps(B, r) {
  const { i, j } = B;
  const sides = [
    [B.x0, B.y0 + 5, B.x1, B.y0 + 5, 0, -1, aveY(j), 60, j * 2],
    [B.x0, B.y1 - 5, B.x1, B.y1 - 5, 0, 1, aveY(j + 1), 122, j * 2 + 2],
    [B.x0 + 5, B.y0, B.x0 + 5, B.y1, -1, 0, aveX(i), 60, i * 2 + 1],
    [B.x1 - 5, B.y0, B.x1 - 5, B.y1, 1, 0, aveX(i + 1), 122, i * 2 + 3],
  ];
  const sp = 150;
  for (const [ax, ay, bx, by, nx, ny, ave, off, road] of sides) {
    const sodium = !ave && hash(road, 0, 808) < 0.3;
    const len = Math.hypot(bx - ax, by - ay);
    const dx = (bx - ax) / len, dy = (by - ay) / len;
    const bad = (x, y) => {
      if (riverDist(x, y) < 20) return true;
      for (const d of B.diags) if (Math.abs(diagSigned(d, x, y)) < DIAG_W / 2 + SW + 6) return true;
      if (B.rail !== null && Math.abs(x - B.rail) < RAIL_W / 2 + 12) return true;
      return false;
    };
    for (let t = off; t < len - 40; t += sp) {
      const x = ax + dx * t, y = ay + dy * t;
      if (!bad(x, y)) addLamp(B, x, y, x + nx * 20, y + ny * 20, ave ? 140 : 125, sodium ? 'sodium' : 'white', 0.85);
      if (B.streetTrees) {
        const tt = t + sp / 2;
        if (tt < len - 40) {
          const tx = ax + dx * tt - nx * 5, ty = ay + dy * tt - ny * 5;
          if (!bad(tx, ty) && !hitsSolid(B, tx - 8, ty - 8, 16, 16)) {
            B.trees.push({ x: tx, y: ty, r: r.range(12, 16), kind: 0, v: (r() * 4) | 0 });
            B.circles.push({ x: tx, y: ty, r: 5 });
          }
        }
      }
    }
  }
}
