// Отрисовка земли (дороги, кварталы, реки, мосты) в кэшируемые тайлы-чанки.
import * as W from './world.js';
import { PAL, SW, DIAG_W, RAIL_W, RP } from './world.js';
import { drawCarSprite, spriteFor } from './sprites.js';
import { hash } from './util.js';

export const CS = 512;
const MAX_CHUNKS = 96;
const TAU = Math.PI * 2;
const cache = new Map();
let tick = 0;

export function chunkKey(cx, cy) { return cx + ',' + cy; }
export function peekChunk(cx, cy) {
  const ch = cache.get(chunkKey(cx, cy));
  if (ch) ch.used = tick;
  return ch || null;
}
export function buildChunkAt(cx, cy) {
  const key = chunkKey(cx, cy);
  let ch = cache.get(key);
  if (ch) return ch;
  ch = buildChunk(cx, cy);
  ch.used = tick;
  cache.set(key, ch);
  if (cache.size > MAX_CHUNKS) {
    let oldK = null, oldU = Infinity;
    for (const [k, v] of cache) if (v.used < oldU) { oldU = v.used; oldK = k; }
    if (oldK !== null) cache.delete(oldK);
  }
  return ch;
}
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
  drawGridRoads(g, R, i0, i1, j0, j1);
  drawRivers(g, R);
  drawBridges(g, R, i0, i1, lamps, inChunk);
  for (const d of diags) drawDiag(g, d, R, 'road', lamps, inChunk);
  for (const i of rails) drawRailTracks(g, W.railX(i), R, j0, j1);
  for (const B of blocks) drawBlockObjects(g, B);
  for (const B of blocks) for (const l of B.lamps) {
    if (l.pole) drawPole(g, l);
    if (inChunk(l.x, l.y)) lamps.push(l);
  }
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

const TREE_COLS = [['#2d5a2a', '#3f7a34'], ['#2a4f30', '#3a6a3c'], ['#3a5a26', '#507a30'], ['#30492a', '#47683a']];
function drawTree(g, t) {
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath(); g.arc(t.x + 4, t.y + 5, t.r, 0, TAU); g.fill();
  if (t.kind === 1) {
    for (const [s, c] of [[1, '#1d452c'], [0.62, '#2a5a38']]) {
      g.beginPath();
      for (let k = 0; k < 18; k++) {
        const a = (k / 18) * TAU, rr = (k % 2 ? 0.62 : 1) * t.r * s;
        const x = t.x + Math.cos(a) * rr, y = t.y + Math.sin(a) * rr;
        if (k) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath(); g.fillStyle = c; g.fill();
    }
    return;
  }
  const [c0, c1] = TREE_COLS[t.v % 4];
  g.fillStyle = c0;
  g.beginPath(); g.arc(t.x, t.y, t.r, 0, TAU); g.fill();
  for (let k = 0; k < 4; k++) {
    const a = k * 1.7 + t.v;
    g.beginPath(); g.arc(t.x + Math.cos(a) * t.r * 0.45, t.y + Math.sin(a) * t.r * 0.45, t.r * 0.55, 0, TAU); g.fill();
  }
  g.fillStyle = c1;
  g.beginPath(); g.arc(t.x - t.r * 0.25, t.y - t.r * 0.25, t.r * 0.5, 0, TAU); g.fill();
}

function drawBlockObjects(g, B) {
  for (const p of B.parked) drawCarSprite(g, spriteFor(p.kind, p.spr), p.x, p.y, p.a);
  for (const p of B.props) if (p.t === 'excavator') drawExcavator(g, p);
  for (const t of B.trees) drawTree(g, t);
}

function drawExcavator(g, p) {
  g.save(); g.translate(p.x, p.y); g.rotate(p.a);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(-14, -12, 32, 28);
  g.fillStyle = '#2a2a2a'; g.fillRect(-18, -15, 34, 7); g.fillRect(-18, 8, 34, 7);
  g.fillStyle = '#d8a520'; g.fillRect(-12, -10, 24, 20);
  g.fillStyle = '#1a2430'; g.fillRect(2, -9, 8, 8);
  g.strokeStyle = '#c89515'; g.lineWidth = 5; g.beginPath(); g.moveTo(8, 4); g.lineTo(34, 8); g.lineTo(44, 0); g.stroke();
  g.fillStyle = '#555'; g.fillRect(42, -6, 7, 12);
  g.restore();
}

function drawPole(g, l) {
  if (l.lx !== l.x || l.ly !== l.y) {
    g.strokeStyle = '#5c5e62'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(l.x + (l.lx - l.x) * 0.85, l.y + (l.ly - l.y) * 0.85); g.stroke();
  }
  g.fillStyle = '#2a2b2e';
  g.beginPath(); g.arc(l.x + 1, l.y + 1.5, 3, 0, TAU); g.fill();
  g.fillStyle = '#8a8c90';
  g.beginPath(); g.arc(l.x, l.y, 2.6, 0, TAU); g.fill();
}

// ---------------------------------------------------------------- улицы
function drawGridRoads(g, R, i0, i1, j0, j1) {
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
      const ry = W.riverY(m, x), hw = W.riverHW(m, x);
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

function drawBridges(g, R, i0, i1, lamps, inChunk) {
  for (let i = i0; i <= i1 + 1; i++) {
    const x = W.roadX(i), w = W.widthX(i);
    const dw = w + 28;
    if (x + dw / 2 + 30 < R.x0 || x - dw / 2 - 30 > R.x1) continue;
    for (let m = Math.floor((R.y0 - 1500) / RP); m <= Math.floor((R.y1 + 1500) / RP); m++) {
      if (!W.riverExists(m) || !W.bridgeAt(i, m)) continue;
      const [lo, hi] = W.riverSpan(m, x - dw / 2, x + dw / 2);
      const ya = lo - 24, yb = hi + 24;
      if (yb < R.y0 - 40 || ya > R.y1 + 40) continue;
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x - dw / 2 + 12, ya + 10, dw, yb - ya);
      g.fillStyle = PAL.sidewalk; g.fillRect(x - dw / 2, ya, dw, yb - ya);
      g.fillStyle = PAL.asphalt; g.fillRect(x - w / 2, ya, w, yb - ya);
      g.fillStyle = PAL.mark;
      if (W.aveX(i)) { g.fillRect(x - 3, ya, 2, yb - ya); g.fillRect(x + 1, ya, 2, yb - ya); }
      else for (let v = Math.ceil(ya / 40) * 40; v < yb - 20; v += 40) g.fillRect(x - 1, v, 2, 20);
      g.fillStyle = '#a4a6aa';
      g.fillRect(x - dw / 2, ya, 3, yb - ya); g.fillRect(x + dw / 2 - 3, ya, 3, yb - ya);
      for (let v = ya; v < yb; v += 18) { g.fillRect(x - dw / 2 - 1, v, 5, 3); g.fillRect(x + dw / 2 - 4, v, 5, 3); }
      for (let v = Math.ceil(ya / 110) * 110, k = 0; v < yb - 10; v += 110, k++) {
        const s = (Math.round(v / 110) % 2) ? -1 : 1;
        const l = { x: x + s * (dw / 2 - 6), y: v, lx: x + s * (w / 2 - 12), ly: v, r: 140, c: 'white', i: 0.85, pole: true };
        drawPole(g, l);
        if (inChunk(l.x, l.y)) lamps.push(l);
      }
    }
  }
}

// ---------------------------------------------------------------- диагонали
function drawDiag(g, d, R, pass, lamps, inChunk) {
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
  seg(ta, tb, DIAG_W / 2 - 1, 2, PAL.curb);
  seg(ta, tb, -(DIAG_W / 2 - 1), 2, PAL.curb);
  seg(ta, tb, -3, 2, PAL.mark); seg(ta, tb, 3, 2, PAL.mark);
  seg(ta, tb, DIAG_W / 4 + 1, 2, PAL.mark, [20, 20]);
  seg(ta, tb, -(DIAG_W / 4 + 1), 2, PAL.mark, [20, 20]);
  // фонари
  for (let k = Math.ceil(ta / 130); k * 130 < tb; k++) {
    const t = k * 130;
    const s = k % 2 ? 1 : -1;
    const [px, py] = P(t, s * (DIAG_W / 2 + 8));
    if (nearGridRoad(px, py) < 10) continue;
    const [lx, ly] = P(t, s * (DIAG_W / 2 - 16));
    const l = { x: px, y: py, lx, ly, r: 140, c: 'white', i: 0.85, pole: true };
    drawPole(g, l);
    if (inChunk(px, py)) lamps.push(l);
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
