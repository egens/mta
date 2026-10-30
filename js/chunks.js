// Отрисовка земли (дороги, кварталы, реки, мосты) в кэшируемые тайлы-чанки.
import * as W from './world.js';
import { PAL, SW, DIAG_W, RAIL_W, RP } from './world.js';
import { hash } from './util.js';

export const CS = 512;
const MAX_CHUNKS = 700;
const TAU = Math.PI * 2;
const cache = new Map();
let tick = 0;

export function chunkKey(cx, cy) { return cx + ',' + cy; }
export function peekChunk(cx, cy) {
  const ch = cache.get(chunkKey(cx, cy));
  if (ch) ch.used = tick;
  return ch || null;
}
// Чанк хранит список фонарей (с состоянием «сломан») дольше, чем свою текстуру:
// после запекания текстура освобождается, а при повторном запросе перерисовывается
// без пересоздания фонарей.
export function buildChunkAt(cx, cy) {
  const key = chunkKey(cx, cy);
  let ch = cache.get(key);
  if (ch && ch.canvas) { ch.used = tick; return ch; }
  const fresh = buildChunk(cx, cy);
  if (ch) { ch.canvas = fresh.canvas; ch.used = tick; return ch; }
  ch = fresh;
  ch.used = tick;
  cache.set(key, ch);
  if (cache.size > MAX_CHUNKS) {
    let oldK = null, oldU = Infinity;
    for (const [k, v] of cache) if (v.used < oldU) { oldU = v.used; oldK = k; }
    if (oldK !== null) cache.delete(oldK);
  }
  return ch;
}
export function releaseCanvas(ch) { ch.canvas = null; }
export function nextTick() { tick++; }

function buildChunk(cx, cy) {
  const x0 = cx * CS, y0 = cy * CS, x1 = x0 + CS, y1 = y0 + CS;
  const cv = document.createElement('canvas');
  cv.width = cv.height = CS;
  const g = cv.getContext('2d');
  g.translate(-x0, -y0);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const lamps = [];
  const R = { x0, y0, x1, y1 };
  const inChunk = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;

  g.fillStyle = PAL.sidewalk;
  g.fillRect(x0, y0, CS, CS);
  const i0 = W.colAt(x0 - 140), i1 = W.colAt(x1 + 140), j0 = W.rowAt(y0 - 140), j1 = W.rowAt(y1 + 140);
  const blocks = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) blocks.push(W.getBlock(i, j));

  for (const B of blocks) drawBlockGround(g, B);
  const diags = W.diagsInRect(x0, y0, x1, y1, DIAG_W + 80);
  for (const d of diags) drawDiag(g, d, R, 'sidewalk');
  const rails = W.railsInRange(x0, x1);
  for (const i of rails) { g.fillStyle = PAL.gravel; g.fillRect(W.railX(i) - RAIL_W / 2, y0 - 2, RAIL_W, CS + 4); }
  drawGridAsphalt(g, R, i0, i1, j0, j1);
  // разметка сетки не заходит на диагональные проспекты
  g.save();
  for (const d of diags) clipOutside(g, R, diagBand(d, R, DIAG_W / 2 + SW));
  drawGridMarks(g, R, i0, i1, j0, j1);
  g.restore();
  drawRivers(g, R);
  drawBridges(g, R, i0, i1, j0, j1, lamps, inChunk);
  for (const d of diags) drawDiag(g, d, R, 'road', lamps, inChunk, i0, i1, j0, j1, diags);
  for (const i of rails) drawRailTracks(g, W.railX(i), R, j0, j1);
  for (const B of blocks) for (const l of B.lamps) if (inChunk(l.x, l.y)) lamps.push(l);
  return { cx, cy, canvas: cv, lamps };
}

// ---------------------------------------------------------------- кварталы
function drawBlockGround(g, B) {
  const w = B.x1 - B.x0, h = B.y1 - B.y0;
  g.fillStyle = PAL.sidewalk;
  g.fillRect(B.x0, B.y0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.10)';
  for (let x = B.x0 + 20; x < B.x1; x += 20) { g.fillRect(x, B.y0, 1, SW); g.fillRect(x, B.y1 - SW, 1, SW); }
  for (let y = B.y0 + 20; y < B.y1; y += 20) { g.fillRect(B.x0, y, SW, 1); g.fillRect(B.x1 - SW, y, SW, 1); }
  g.fillStyle = B.lotColor;
  g.fillRect(B.lx0, B.ly0, B.lx1 - B.lx0, B.ly1 - B.ly0);
  if (B.lotColor === PAL.grass || B.lotColor === PAL.yard || B.lotColor === PAL.dirt) {
    // лёгкая неоднородность травы/грунта
    for (let k = 0; k < 14; k++) {
      const hx = hash(B.i, B.j, 40 + k), hy = hash(B.i, B.j, 80 + k);
      g.fillStyle = k % 2 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.03)';
      g.beginPath();
      g.ellipse(B.lx0 + hx * (B.lx1 - B.lx0), B.ly0 + hy * (B.ly1 - B.ly0), 30 + hx * 60, 20 + hy * 50, hx * 3, 0, TAU);
      g.fill();
    }
  }
  drawOps(g, B.ground);
  g.strokeStyle = PAL.curb;
  g.lineWidth = 2;
  g.strokeRect(B.x0 + 1, B.y0 + 1, w - 2, h - 2);
}

function drawOps(g, ops) {
  for (const o of ops) {
    switch (o.t) {
      case 'r': g.fillStyle = o.c; g.fillRect(o.x, o.y, o.w, o.h); break;
      case 'rs': g.strokeStyle = o.c; g.lineWidth = o.lw || 1; g.strokeRect(o.x, o.y, o.w, o.h); break;
      case 'c': g.fillStyle = o.c; g.beginPath(); g.arc(o.x, o.y, o.r, 0, TAU); g.fill(); break;
      case 'cs': g.strokeStyle = o.c; g.lineWidth = o.lw || 1; g.beginPath(); g.arc(o.x, o.y, o.r, 0, TAU); g.stroke(); break;
      case 'e':
        g.beginPath(); g.ellipse(o.x, o.y, o.rx, o.ry, 0, 0, TAU);
        if (o.stroke) { g.strokeStyle = o.c; g.lineWidth = o.stroke; g.stroke(); } else { g.fillStyle = o.c; g.fill(); }
        break;
      case 'l': {
        g.strokeStyle = o.c; g.lineWidth = o.lw; g.lineCap = o.cap || 'round';
        if (o.dash) g.setLineDash(o.dash);
        g.beginPath(); g.moveTo(o.pts[0], o.pts[1]);
        for (let k = 2; k < o.pts.length; k += 2) g.lineTo(o.pts[k], o.pts[k + 1]);
        g.stroke();
        if (o.dash) g.setLineDash([]);
        g.lineCap = 'round';
        break;
      }
      case 'pond': drawPond(g, o); break;
    }
  }
}

function pondPath(g, o, s) {
  g.beginPath();
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * TAU;
    const q = 1 + 0.08 * Math.sin(3 * a + o.seed) + 0.06 * Math.sin(5 * a + o.seed * 2) + 0.04 * Math.sin(7 * a + o.seed * 3);
    const x = o.x + Math.cos(a) * o.rx * q * s, y = o.y + Math.sin(a) * o.ry * q * s;
    if (k) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath();
}
function drawPond(g, o) {
  pondPath(g, o, 1.12); g.fillStyle = '#6a6448'; g.fill();
  pondPath(g, o, 1.0); g.fillStyle = PAL.water; g.fill();
  pondPath(g, o, 0.6); g.fillStyle = '#0c2236'; g.fill();
}

// ---------------------------------------------------------------- улицы
// Обрезка «всё, кроме многоугольника»: пересечение нескольких таких обрезок исключает их все
function clipOutside(g, R, poly) {
  g.beginPath();
  g.rect(R.x0 - 100, R.y0 - 100, CS + 200, CS + 200);
  g.moveTo(poly[0][0], poly[0][1]);
  for (let k = 1; k < poly.length; k++) g.lineTo(poly[k][0], poly[k][1]);
  g.closePath();
  g.clip('evenodd');
}
function diagBand(d, R, half) {
  const [dx, dy] = W.diagDir(d), [nx, ny] = W.diagNorm(d), [ox, oy] = W.diagOrigin(d);
  const tc = (R.x0 + CS / 2 - ox) * dx + (R.y0 + CS / 2 - oy) * dy;
  const P = (t, u) => [ox + dx * t + nx * u, oy + dy * t + ny * u];
  return [P(tc - CS * 1.6, -half), P(tc + CS * 1.6, -half), P(tc + CS * 1.6, half), P(tc - CS * 1.6, half)];
}

function drawGridAsphalt(g, R, i0, i1, j0, j1) {
  g.fillStyle = PAL.asphalt;
  for (let i = i0; i <= i1 + 1; i++) {
    const x = W.roadX(i), w = W.widthX(i);
    if (x + w / 2 < R.x0 || x - w / 2 > R.x1) continue;
    g.fillRect(x - w / 2, R.y0 - 2, w, CS + 4);
  }
  for (let j = j0; j <= j1 + 1; j++) {
    const y = W.roadY(j), w = W.widthY(j);
    if (y + w / 2 < R.y0 || y - w / 2 > R.y1) continue;
    g.fillRect(R.x0 - 2, y - w / 2, CS + 4, w);
  }
  // трещины и пятна
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let k = 0; k < 40; k++) {
    const hx = hash(R.x0, R.y0, k * 2), hy = hash(R.x0, R.y0, k * 2 + 1);
    g.beginPath(); g.ellipse(R.x0 + hx * CS, R.y0 + hy * CS, 4 + hx * 14, 3 + hy * 8, hx * 6, 0, TAU); g.fill();
  }
}
function drawGridMarks(g, R, i0, i1, j0, j1) {
  for (let i = i0; i <= i1 + 1; i++) for (let j = j0 - 1; j <= j1 + 1; j++) segMarks(g, R, true, i, j);
  for (let j = j0; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) segMarks(g, R, false, i, j);
}

function segMarks(g, R, vert, i, j) {
  const c = vert ? W.roadX(i) : W.roadY(j);
  const w = vert ? W.widthX(i) : W.widthY(j);
  const ave = vert ? W.aveX(i) : W.aveY(j);
  const a = vert ? W.roadY(j) + W.widthY(j) / 2 : W.roadX(i) + W.widthX(i) / 2;
  const b = vert ? W.roadY(j + 1) - W.widthY(j + 1) / 2 : W.roadX(i + 1) - W.widthX(i + 1) / 2;
  if (vert) { if (c + w / 2 < R.x0 || c - w / 2 > R.x1 || b < R.y0 || a > R.y1) return; }
  else if (c + w / 2 < R.y0 || c - w / 2 > R.y1 || b < R.x0 || a > R.x1) return;
  const F = (u, v, du, dv) => (vert ? g.fillRect(c + u, v, du, dv) : g.fillRect(v, c + u, dv, du));
  const lo = vert ? R.y0 - 40 : R.x0 - 40, hi = vert ? R.y1 + 40 : R.x1 + 40;
  if (ave) {
    g.fillStyle = '#4b4d47';
    F(-6, a + 34, 12, b - a - 68);
    g.fillStyle = PAL.mark;
    F(-7.5, a + 34, 1.5, b - a - 68); F(6, a + 34, 1.5, b - a - 68);
    for (let v = a + 34; v < b - 54; v += 40) if (v > lo && v < hi) { F(-39, v, 2, 20); F(37, v, 2, 20); }
  } else {
    g.fillStyle = PAL.mark;
    for (let v = a + 30; v < b - 50; v += 40) if (v > lo && v < hi) F(-1, v, 2, 20);
  }
  g.fillStyle = 'rgba(225,225,215,0.85)';
  for (let u = -w / 2 + 5; u < w / 2 - 8; u += 11) { F(u, a + 4, 6, 18); F(u, b - 22, 6, 18); }
  g.fillStyle = PAL.mark;
  if (vert) { F(-w / 2 + 3, b - 29, w / 2 - 4, 3); F(1, a + 26, w / 2 - 4, 3); }
  else { F(1, b - 29, w / 2 - 4, 3); F(-w / 2 + 3, a + 26, w / 2 - 4, 3); }
}

// ---------------------------------------------------------------- реки и мосты
function drawRivers(g, R) {
  for (let m = Math.floor((R.y0 - 1500) / RP); m <= Math.floor((R.y1 + 1500) / RP); m++) {
    if (!W.riverExists(m)) continue;
    const xs = [], tops = [], bots = [];
    let any = false;
    for (let x = R.x0 - 32; x <= R.x1 + 32; x += 16) {
      const ry = W.riverY(m, x), hw = W.riverHV(m, x);
      xs.push(x); tops.push(ry - hw); bots.push(ry + hw);
      if (ry + hw + 20 > R.y0 && ry - hw - 20 < R.y1) any = true;
    }
    if (!any) continue;
    const poly = (o1, o2, k = 1) => {
      g.beginPath();
      for (let n = 0; n < xs.length; n++) {
        const mid = (tops[n] + bots[n]) / 2, hw = (bots[n] - tops[n]) / 2;
        const y = mid - hw * k - o1;
        n ? g.lineTo(xs[n], y) : g.moveTo(xs[n], y);
      }
      for (let n = xs.length - 1; n >= 0; n--) {
        const mid = (tops[n] + bots[n]) / 2, hw = (bots[n] - tops[n]) / 2;
        g.lineTo(xs[n], mid + hw * k + o2);
      }
      g.closePath();
    };
    poly(10, 10); g.fillStyle = PAL.bank; g.fill();
    poly(0, 0); g.fillStyle = PAL.water; g.fill();
    poly(0, 0, 0.55); g.fillStyle = '#0b2438'; g.fill();
    // парапет набережной
    g.strokeStyle = '#a19c92'; g.lineWidth = 2;
    for (const side of [-1, 1]) {
      g.beginPath();
      for (let n = 0; n < xs.length; n++) {
        const y = (side < 0 ? tops[n] - 9 : bots[n] + 9);
        n ? g.lineTo(xs[n], y) : g.moveTo(xs[n], y);
      }
      g.stroke();
    }
    // рябь
    g.fillStyle = 'rgba(160,200,230,0.07)';
    for (let n = 0; n < xs.length; n += 1) {
      const h = hash(xs[n] | 0, m, 9);
      if (h < 0.5) continue;
      const y = tops[n] + (bots[n] - tops[n]) * hash(xs[n] | 0, m, 10);
      g.fillRect(xs[n], y, 10 + h * 12, 1.5);
    }
  }
}

function drawBridges(g, R, i0, i1, j0, j1, lamps, inChunk) {
  // вертикальные улицы
  for (let i = i0; i <= i1 + 1; i++) {
    const x = W.roadX(i), w = W.widthX(i);
    const dw = w + 28;
    if (x + dw / 2 + 30 < R.x0 || x - dw / 2 - 30 > R.x1) continue;
    for (let m = Math.floor((R.y0 - 1500) / RP); m <= Math.floor((R.y1 + 1500) / RP); m++) {
      if (!W.riverExists(m)) continue;
      const [lo, hi] = W.riverSpan(m, x - dw / 2, x + dw / 2);
      const a = lo - 24, b = hi + 24;
      if (b < R.y0 - 40 || a > R.y1 + 40) continue;
      bridgeDeck(g, true, x, w, W.aveX(i), a, b, lamps, inChunk);
    }
  }
  // горизонтальные улицы: ищем участки над водой
  for (let j = j0; j <= j1 + 1; j++) {
    const y = W.roadY(j), w = W.widthY(j);
    const dw = w + 28;
    if (y + dw / 2 + 30 < R.y0 || y - dw / 2 - 30 > R.y1) continue;
    let s0 = null;
    const x0 = Math.floor((R.x0 - 300) / 8) * 8;
    for (let x = x0; x <= R.x1 + 300; x += 8) {
      const wet = W.riverDist(x, y - dw / 2) < 14 || W.riverDist(x, y) < 14 || W.riverDist(x, y + dw / 2) < 14;
      if (wet && s0 === null) s0 = x;
      if ((!wet || x + 8 > R.x1 + 300) && s0 !== null) {
        bridgeDeck(g, false, y, w, W.aveY(j), s0 - 24, x + 24, lamps, inChunk);
        s0 = null;
      }
    }
  }
}

// пролёт моста: c — ось улицы, a..b — участок вдоль неё
function bridgeDeck(g, vert, c, w, ave, a, b, lamps, inChunk) {
  const dw = w + 28;
  const F = (u, v, du, dv) => (vert ? g.fillRect(c + u, v, du, dv) : g.fillRect(v, c + u, dv, du));
  g.fillStyle = 'rgba(0,0,0,0.5)';
  if (vert) g.fillRect(c - dw / 2 + 12, a + 10, dw, b - a); else g.fillRect(a + 12, c - dw / 2 + 10, b - a, dw);
  g.fillStyle = PAL.sidewalk; F(-dw / 2, a, dw, b - a);
  g.fillStyle = PAL.asphalt; F(-w / 2, a, w, b - a);
  g.fillStyle = PAL.mark;
  if (ave) { F(-3, a, 2, b - a); F(1, a, 2, b - a); }
  else for (let v = Math.ceil(a / 40) * 40; v < b - 20; v += 40) F(-1, v, 2, 20);
  g.fillStyle = '#a4a6aa';
  F(-dw / 2, a, 3, b - a); F(dw / 2 - 3, a, 3, b - a);
  for (let v = Math.ceil(a / 18) * 18; v < b; v += 18) { F(-dw / 2 - 1, v, 5, 3); F(dw / 2 - 4, v, 5, 3); }
  for (let v = Math.ceil(a / 110) * 110; v < b - 10; v += 110) {
    const s = (Math.round(v / 110) % 2) ? -1 : 1;
    const l = vert
      ? { x: c + s * (dw / 2 - 6), y: v, lx: c + s * (w / 2 - 12), ly: v }
      : { x: v, y: c + s * (dw / 2 - 6), lx: v, ly: c + s * (w / 2 - 12) };
    Object.assign(l, { r: 140, c: 'white', i: 0.85, pole: true, broken: false });
    if (inChunk(l.x, l.y)) lamps.push(l);
  }
}

// ---------------------------------------------------------------- диагонали
function drawDiag(g, d, R, pass, lamps, inChunk, i0, i1, j0, j1, diags) {
  const [dx, dy] = W.diagDir(d), [nx, ny] = W.diagNorm(d), [ox, oy] = W.diagOrigin(d);
  const ccx = R.x0 + CS / 2, ccy = R.y0 + CS / 2;
  const tc = (ccx - ox) * dx + (ccy - oy) * dy;
  const ta = Math.floor((tc - CS) / 40) * 40, tb = tc + CS;
  const P = (t, off = 0) => [ox + dx * t + nx * off, oy + dy * t + ny * off];
  const seg = (t0, t1, off, lw, color, dash) => {
    g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'butt';
    if (dash) g.setLineDash(dash);
    const [ax, ay] = P(t0, off), [bx, by] = P(t1, off);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    if (dash) g.setLineDash([]);
    g.lineCap = 'round';
  };
  if (pass === 'sidewalk') {
    seg(ta, tb, 0, DIAG_W + 2 * SW, PAL.sidewalk);
    return;
  }
  // участки над водой — мост
  const spans = [];
  let s0 = null;
  for (let t = ta; t <= tb; t += 8) {
    const [px, py] = P(t);
    const wet = W.riverDist(px, py) < 14;
    if (wet && s0 === null) s0 = t;
    if (!wet && s0 !== null) { spans.push([s0, t]); s0 = null; }
  }
  if (s0 !== null) spans.push([s0, tb]);
  for (const [a, b] of spans) {
    const s = a - 26, e = b + 26;
    g.save(); g.translate(12, 10); seg(s, e, 0, DIAG_W + 2 * SW + 6, 'rgba(0,0,0,0.5)'); g.restore();
    seg(s, e, 0, DIAG_W + 2 * SW + 6, PAL.sidewalk);
    seg(s, e, DIAG_W / 2 + SW + 1, 3, '#a4a6aa');
    seg(s, e, -(DIAG_W / 2 + SW + 1), 3, '#a4a6aa');
  }
  seg(ta, tb, 0, DIAG_W, PAL.asphalt);
  // перекрёстки с сеткой: разметка диагонали обрывается перед зеброй, зебра идёт вдоль кромки улицы
  const roads = [];
  for (let i = i0; i <= i1 + 1; i++) roads.push([true, W.roadX(i), W.widthX(i) / 2]);
  for (let j = j0; j <= j1 + 1; j++) roads.push([false, W.roadY(j), W.widthY(j) / 2]);
  g.save();
  for (const [vert, c, h] of roads) {
    const p = 30;
    clipOutside(g, R, vert ? [[c - h - p, R.y0 - 200], [c + h + p, R.y0 - 200], [c + h + p, R.y1 + 200], [c - h - p, R.y1 + 200]]
      : [[R.x0 - 200, c - h - p], [R.x1 + 200, c - h - p], [R.x1 + 200, c + h + p], [R.x0 - 200, c + h + p]]);
  }
  for (const o of diags) if (o !== d) clipOutside(g, R, diagBand(o, R, DIAG_W / 2 + 4));
  seg(ta, tb, DIAG_W / 2 - 1, 2, PAL.curb);
  seg(ta, tb, -(DIAG_W / 2 - 1), 2, PAL.curb);
  seg(ta, tb, -3, 2, PAL.mark); seg(ta, tb, 3, 2, PAL.mark);
  seg(ta, tb, DIAG_W / 4 + 1, 2, PAL.mark, [20, 20]);
  seg(ta, tb, -(DIAG_W / 4 + 1), 2, PAL.mark, [20, 20]);
  g.restore();
  g.fillStyle = 'rgba(225,225,215,0.85)';
  const H = DIAG_W / 2;
  const quad = (t1, t2, u1, u2) => {
    const a = P(t1, u1), b = P(t2, u1), c = P(t2, u2), e = P(t1, u2);
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(e[0], e[1]); g.closePath();
  };
  g.beginPath();
  for (const [vert, c, h] of roads) {
    const dd = vert ? dx : dy, nn = vert ? nx : ny, oo = vert ? ox : oy;
    if (Math.abs(dd) < 1e-6) continue;
    const t0 = (c - oo) / dd;
    if (t0 < ta - 200 || t0 > tb + 200) continue;
    let skip = false;
    for (const o of diags) if (o !== d && Math.abs(W.diagSigned(o, ...P(t0))) < DIAG_W + SW * 2) skip = true;
    if (skip) continue;
    for (let u = -H + 5; u < H - 8; u += 11) {
      const um = u + 3;
      const e1 = (c + h - oo - nn * um) / dd, e2 = (c - h - oo - nn * um) / dd;
      const hi = Math.max(e1, e2), lo = Math.min(e1, e2);
      for (const [t1, t2] of [[hi + 8, hi + 26], [lo - 26, lo - 8]]) {
        // полоса зебры не должна лечь на другую улицу соседнего перекрёстка
        const [qx, qy] = P((t1 + t2) / 2, um);
        let onRoad = false;
        for (const [v2, c2, h2] of roads) if (Math.abs((v2 ? qx : qy) - c2) < h2 + 3) { onRoad = true; break; }
        if (!onRoad) quad(t1, t2, u, u + 6);
      }
    }
  }
  g.fill();
  // фонари
  for (let k = Math.ceil(ta / 130); k * 130 < tb; k++) {
    const t = k * 130;
    const s = k % 2 ? 1 : -1;
    const [px, py] = P(t, s * (DIAG_W / 2 + 8));
    if (nearGridRoad(px, py) < 10) continue;
    const [lx, ly] = P(t, s * (DIAG_W / 2 - 16));
    if (inChunk(px, py)) lamps.push({ x: px, y: py, lx, ly, r: 140, c: 'white', i: 0.85, pole: true, broken: false });
  }
}

function nearGridRoad(x, y) {
  const i = W.colAt(x), j = W.rowAt(y);
  return Math.min(
    Math.abs(x - W.roadX(i)) - W.widthX(i) / 2, Math.abs(x - W.roadX(i + 1)) - W.widthX(i + 1) / 2,
    Math.abs(y - W.roadY(j)) - W.widthY(j) / 2, Math.abs(y - W.roadY(j + 1)) - W.widthY(j + 1) / 2,
  );
}

// ---------------------------------------------------------------- железная дорога
function drawRailTracks(g, x, R, j0, j1) {
  // переезды
  for (let j = j0; j <= j1 + 1; j++) {
    const y = W.roadY(j), w = W.widthY(j);
    if (y + w / 2 < R.y0 || y - w / 2 > R.y1) continue;
    g.fillStyle = '#48494d'; g.fillRect(x - RAIL_W / 2, y - w / 2, RAIL_W, w);
    g.fillStyle = '#c8c8c0';
    for (const s of [-1, 1]) for (let u = -w / 2; u < w / 2; u += 12) g.fillRect(x + s * (RAIL_W / 2 + 4) - 2, y + u, 4, 6);
  }
  // мосты
  const spans = [];
  let s0 = null;
  for (let y = R.y0 - 40; y <= R.y1 + 40; y += 8) {
    const wet = W.riverDist(x, y) < 14 || W.riverDist(x - RAIL_W / 2, y) < 14 || W.riverDist(x + RAIL_W / 2, y) < 14;
    if (wet && s0 === null) s0 = y;
    if (!wet && s0 !== null) { spans.push([s0 - 20, y + 20]); s0 = null; }
  }
  if (s0 !== null) spans.push([s0 - 20, R.y1 + 40]);
  for (const [a, b] of spans) {
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x - RAIL_W / 2 + 12, a + 10, RAIL_W, b - a);
    g.fillStyle = '#3a3a3c'; g.fillRect(x - RAIL_W / 2, a, RAIL_W, b - a);
  }
  for (const tx of [x - 15, x + 15]) {
    g.fillStyle = '#4a3a2e';
    for (let y = Math.floor(R.y0 / 10) * 10; y < R.y1; y += 10) g.fillRect(tx - 11, y, 22, 4);
    g.fillStyle = '#a2a2aa';
    g.fillRect(tx - 8, R.y0, 2, CS); g.fillRect(tx + 6, R.y0, 2, CS);
  }
  for (const [a, b] of spans) {
    g.fillStyle = '#6e737a';
    g.fillRect(x - RAIL_W / 2 - 2, a, 6, b - a); g.fillRect(x + RAIL_W / 2 - 4, a, 6, b - a);
    g.strokeStyle = '#6e737a'; g.lineWidth = 2;
    g.beginPath();
    for (let y = a; y < b - 30; y += 30) {
      g.moveTo(x - RAIL_W / 2 + 1, y); g.lineTo(x - RAIL_W / 2 + 1, y + 30);
    }
    g.stroke();
  }
}
