// Городской трафик по сетке улиц, пешеходы на тротуарах и поезда.
import * as W from './world.js';
import { CAR_COLORS, CAR_DIM, BUS_COLORS, WORK_COLORS } from './sprites.js';
import { hashU } from './util.js';
import { obbObb, collideStatic } from './car.js';
import { worksSteer } from './roadworks.js';

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const MAX_CARS = 34;
const MAX_PEDS = 46;

// светофор: 0 — зелёный по горизонтали, 1 — жёлтый гориз., 2 — зелёный по вертикали, 3 — жёлтый верт.
export function signalState(i, j, t) {
  const off = ((hashU(i, j, 707) % 1000) / 1000) * 16;
  const p = (t + off) % 16;
  return p < 6.5 ? 0 : p < 8 ? 1 : p < 14.5 ? 2 : 3;
}

function edgeExists(i, j, d) {
  if (d === 0) return W.hSegExists(i, j);
  if (d === 2) return W.hSegExists(i - 1, j);
  if (d === 1) return W.vSegExists(i, j);
  return W.vSegExists(i, j - 1);
}
const horiz = (d) => d === 0 || d === 2;
const nodePos = (i, j) => [W.roadX(i), W.roadY(j)];

function laneOffset(i, j, d, lane) {
  const ave = horiz(d) ? W.aveY(j) : W.aveX(i);
  return ave ? 6 + 32 * (lane + 0.5) : 21;
}
// полуширина поперечной дороги в узле для направления d
const crossHalf = (i, j, d) => (horiz(d) ? W.widthX(i) / 2 : W.widthY(j) / 2);

function makeStraight(c, i, j, d) {
  // отрезок от узла (i,j) к соседу в направлении d
  const ni = i + DX[d], nj = j + DY[d];
  const [ax, ay] = nodePos(i, j), [bx, by] = nodePos(ni, nj);
  const o = laneOffset(i, j, d, c.lane);
  const rx = -DY[d], ry = DX[d];
  const sx = ax + DX[d] * (crossHalf(i, j, d) + 6) + rx * o, sy = ay + DY[d] * (crossHalf(i, j, d) + 6) + ry * o;
  const ex = bx - DX[d] * (crossHalf(ni, nj, d) + 30) + rx * o, ey = by - DY[d] * (crossHalf(ni, nj, d) + 30) + ry * o;
  c.seg = { kind: 's', sx, sy, ex, ey, len: Math.max(1, Math.hypot(ex - sx, ey - sy)), s: 0 };
  c.i = i; c.j = j; c.d = d; c.ni = ni; c.nj = nj;
}

function chooseNext(c) {
  const opts = [];
  const back = (c.d + 2) & 3;
  for (let d = 0; d < 4; d++) {
    if (d === back) continue;
    if (!edgeExists(c.ni, c.nj, d)) continue;
    opts.push([d, d === c.d ? 3 : 1]);
  }
  if (!opts.length) return back;
  let tot = 0;
  for (const o of opts) tot += o[1];
  let r = Math.random() * tot;
  for (const o of opts) { r -= o[1]; if (r <= 0) return o[0]; }
  return opts[0][0];
}

function makeTurn(c, d2) {
  const { ni, nj, d } = c;
  const [bx, by] = nodePos(ni, nj);
  const lane2 = W.aveY(nj) || W.aveX(ni) ? (d2 === ((d + 1) & 3) ? 1 : d2 === ((d + 3) & 3) ? 0 : c.lane) : 0;
  const o2 = laneOffset(ni, nj, d2, lane2);
  const r2x = -DY[d2], r2y = DX[d2];
  const p0x = c.seg.ex, p0y = c.seg.ey;
  const h2 = crossHalf(ni, nj, d2) + 6;
  const p2x = bx + DX[d2] * h2 + r2x * o2, p2y = by + DY[d2] * h2 + r2y * o2;
  let p1x, p1y;
  if (d2 === d) { p1x = (p0x + p2x) / 2; p1y = (p0y + p2y) / 2; }
  else if (d2 === ((d + 2) & 3)) { p1x = bx + DX[d] * 10; p1y = by + DY[d] * 10; }
  else if (horiz(d)) { p1x = p2x; p1y = p0y; }
  else { p1x = p0x; p1y = p2y; }
  c.seg = { kind: 'c', p0x, p0y, p1x, p1y, p2x, p2y, t: 0, d2, lane2 };
}

function pickSprite(c) {
  const r = Math.random();
  c.heavy = false; c.police = false;
  const pick = (a) => a[(Math.random() * a.length) | 0];
  if (r < 0.06) { c.kind = 'truck'; c.color = pick(['#9aa0a8', '#c84a2a', '#2a5aa8', '#e0e0e0']); c.heavy = true; c.cruise *= 0.8; }
  else if (r < 0.15) { c.kind = 'bus'; c.color = pick(BUS_COLORS); c.heavy = true; c.cruise *= 0.75; c.stopIn = 6 + Math.random() * 14; }
  else if (r < 0.2) { c.kind = pick(['dump', 'dump', 'mixer', 'roller']); c.color = pick(WORK_COLORS); c.heavy = true; c.cruise *= c.kind === 'roller' ? 0.5 : 0.72; }
  else if (r < 0.38) { c.kind = 'taxi'; c.color = '#e8b81c'; }
  else if (r < 0.41) { c.kind = 'police'; c.color = '#e8e8ee'; c.police = true; }
  else { c.kind = pick(['sedan', 'sedan', 'sedan', 'hatch', 'van']); c.color = pick(CAR_COLORS); }
  [c.L, c.W] = CAR_DIM[c.kind];
}

function spawnCar(st) {
  const { cam } = st;
  const minR = st.viewR + 120, maxR = st.viewR + 900;
  const ang = Math.random() * Math.PI * 2, dist = minR + Math.random() * (maxR - minR);
  const px = cam.x + Math.cos(ang) * dist, py = cam.y + Math.sin(ang) * dist;
  const i = W.colAt(px), j = W.rowAt(py);
  const d = (Math.random() * 4) | 0;
  if (!edgeExists(i, j, d)) return;
  const c = { x: 0, y: 0, a: 0, speed: 0, cruise: 150 + Math.random() * 110, lane: Math.random() < 0.5 ? 0 : 1, mode: 'drive', vx: 0, vy: 0, av: 0, brake: false };
  pickSprite(c);
  makeStraight(c, i, j, d);
  c.seg.s = c.seg.len * (0.1 + Math.random() * 0.7);
  placeOnSeg(c);
  for (const o of st.traffic) if (Math.abs(o.x - c.x) < 80 && Math.abs(o.y - c.y) < 80) return;
  if (Math.hypot(c.x - st.player.x, c.y - st.player.y) < st.viewR) return;
  c.speed = c.cruise * 0.8;
  st.traffic.push(c);
}

function placeOnSeg(c) {
  const g = c.seg;
  if (g.kind === 's') {
    const t = g.s / g.len;
    c.x = g.sx + (g.ex - g.sx) * t; c.y = g.sy + (g.ey - g.sy) * t;
    c.a = Math.atan2(g.ey - g.sy, g.ex - g.sx);
  } else {
    const t = g.t, u = 1 - t;
    c.x = u * u * g.p0x + 2 * u * t * g.p1x + t * t * g.p2x;
    c.y = u * u * g.p0y + 2 * u * t * g.p1y + t * t * g.p2y;
    const dx = 2 * u * (g.p1x - g.p0x) + 2 * t * (g.p2x - g.p1x), dy = 2 * u * (g.p1y - g.p0y) + 2 * t * (g.p2y - g.p1y);
    if (dx * dx + dy * dy > 1e-6) c.a = Math.atan2(dy, dx);
  }
}

// автобус время от времени встаёт на остановку посреди квартала
export function busStop(c, dt, canStop) {
  if (c.kind !== 'bus') return false;
  if (c.stopT > 0) { c.stopT -= dt; return true; }
  c.stopIn -= dt;
  if (c.stopIn <= 0 && canStop) { c.stopT = 3.5 + Math.random() * 3; c.stopIn = 18 + Math.random() * 20; return true; }
  return false;
}

function mustStop(c, time) {
  const s = signalState(c.ni, c.nj, time);
  const dist = c.seg.len - c.seg.s;
  if (horiz(c.d)) return s === 0 ? false : s === 1 ? dist > 45 : true;
  return s === 2 ? false : s === 3 ? dist > 45 : true;
}

export function updateTraffic(st, dt) {
  const { player: P, time } = st;
  if (st.traffic.length < MAX_CARS) for (let k = 0; k < 3; k++) spawnCar(st);
  const far = st.viewR + 1400;
  st.traffic = st.traffic.filter((c) => Math.abs(c.x - P.x) < far && Math.abs(c.y - P.y) < far);

  for (const c of st.traffic) {
    if (c.mode !== 'drive') {
      c.x += c.vx * dt; c.y += c.vy * dt;
      c.a += c.av * dt;
      const k = Math.exp(-2.2 * dt);
      c.vx *= k; c.vy *= k; c.av *= Math.exp(-3 * dt);
      c.hitT += dt;
      c.speed = 0;
      c.brake = true;
      collideStatic(c, null, false);
      continue;
    }
    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    let target = Math.min(c.cruise, c.wcap || Infinity);
    const g = c.seg;
    if (busStop(c, dt, g.kind === 's' && g.s > 120 && g.len - g.s > 200)) target = 0;
    if (g.kind === 's') {
      if (g.s > g.len - 160 && mustStop(c, time)) {
        const dist = Math.max(0, g.len - g.s - 2);
        target = Math.min(target, Math.sqrt(2 * 380 * dist));
      }
      if (g.kind === 's' && g.len - g.s < 120 && c.nextD === undefined) c.nextD = chooseNext(c);
    }
    // впереди кто-то есть?
    const check = (o, any) => {
      const rx = o.x - c.x, ry = o.y - c.y;
      const along = rx * fx + ry * fy;
      if (along <= 0 || along > 150) return;
      const lat = Math.abs(-rx * fy + ry * fx);
      if (lat > (any ? 26 : 16)) return;
      if (!any && o.mode === 'drive' && Math.cos(o.a - c.a) < 0.3) return;
      const gap = along - (c.L + (o.L || 46)) / 2 - 10;
      target = Math.min(target, Math.max(0, gap) * 2.2);
    };
    for (const o of st.traffic) if (o !== c && Math.abs(o.x - c.x) < 160 && Math.abs(o.y - c.y) < 160) check(o, o.mode !== 'drive');
    check(P, true);
    for (const o of st.cops) if (Math.abs(o.x - c.x) < 160 && Math.abs(o.y - c.y) < 160) check(o, true);
    for (const t of st.trains) {
      const ax = c.x + fx * 70, ay = c.y + fy * 70;
      if (ax > t.x - 60 && ax < t.x + 60 && ay > t.y0 - 260 && ay < t.y0 + t.len + 260) target = 0;
    }
    for (const p of st.peds) {
      if (p.down > 0) continue;
      const rx = p.x - c.x, ry = p.y - c.y;
      const along = rx * fx + ry * fy;
      if (along > 0 && along < 70 && Math.abs(-rx * fy + ry * fx) < 16) target = Math.min(target, 0);
    }
    const acc = target > c.speed ? 140 : 420;
    c.speed += Math.max(-acc * dt, Math.min(acc * dt, target - c.speed));
    if (c.speed < 0) c.speed = 0;
    c.brake = target < c.speed - 4 || c.speed < 3;
    let ds = c.speed * dt;
    if (g.kind === 's') {
      g.s += ds;
      if (g.s >= g.len) {
        const d2 = c.nextD !== undefined ? c.nextD : chooseNext(c);
        c.nextD = undefined;
        makeTurn(c, d2);
      }
    } else {
      const t = g.t, u = 1 - t;
      const dx = 2 * u * (g.p1x - g.p0x) + 2 * t * (g.p2x - g.p1x), dy = 2 * u * (g.p1y - g.p0y) + 2 * t * (g.p2y - g.p1y);
      g.t += ds / Math.max(8, Math.hypot(dx, dy));
      if (g.t >= 1) {
        const d2 = g.d2;
        c.lane = g.lane2;
        makeStraight(c, c.ni, c.nj, d2);
      }
    }
    placeOnSeg(c);
    c.wcap = worksSteer(st, c, c.x, c.y, dt);
    c.x += c.wx; c.y += c.wy;
  }
  // машины после аварии мешают друг другу
  for (let a = 0; a < st.traffic.length; a++) {
    const c = st.traffic[a];
    if (c.mode === 'drive') continue;
    for (let b = 0; b < st.traffic.length; b++) {
      if (a === b) continue;
      const o = st.traffic[b];
      if (Math.abs(o.x - c.x) > 80 || Math.abs(o.y - c.y) > 80) continue;
      const h = obbObb(c, o);
      if (!h) continue;
      c.x += h.nx * h.d * 0.5; c.y += h.ny * h.d * 0.5;
      if (o.mode !== 'drive') { o.x -= h.nx * h.d * 0.5; o.y -= h.ny * h.d * 0.5; }
      else {
        const rel = c.vx * h.nx + c.vy * h.ny;
        if (rel < -40) { o.mode = 'hit'; o.vx = Math.cos(o.a) * o.speed - h.nx * rel * 0.5; o.vy = Math.sin(o.a) * o.speed - h.ny * rel * 0.5; o.av = (Math.random() - 0.5) * 2; o.hitT = 0; }
        c.vx *= 0.6; c.vy *= 0.6;
      }
    }
  }
}

// ---------------------------------------------------------------- пешеходы
const HAIR = ['#2a1a10', '#5a3a1a', '#d8c070', '#1a1a1a', '#8a8a8a', '#a04a20'];
function ringLen(r) { return 2 * (r.x1 - r.x0 + r.y1 - r.y0); }
function ringPos(r, u) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  u = ((u % (2 * (w + h))) + 2 * (w + h)) % (2 * (w + h));
  if (u < w) return [r.x0 + u, r.y0, 0];
  u -= w; if (u < h) return [r.x1, r.y0 + u, Math.PI / 2];
  u -= h; if (u < w) return [r.x1 - u, r.y1, Math.PI];
  u -= w; return [r.x0, r.y1 - u, -Math.PI / 2];
}
function ringU(r, x, y) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const cands = [
    [Math.abs(y - r.y0), Math.min(Math.max(x - r.x0, 0), w)],
    [Math.abs(x - r.x1), w + Math.min(Math.max(y - r.y0, 0), h)],
    [Math.abs(y - r.y1), w + h + Math.min(Math.max(r.x1 - x, 0), w)],
    [Math.abs(x - r.x0), 2 * w + h + Math.min(Math.max(r.y1 - y, 0), h)],
  ];
  cands.sort((a, b) => a[0] - b[0]);
  return cands[0][1];
}

export function updatePeds(st, dt) {
  const { player: P, cam } = st;
  if (st.peds.length < MAX_PEDS) {
    for (let k = 0; k < 2; k++) {
      const ang = Math.random() * Math.PI * 2, dist = st.viewR * (0.3 + Math.random() * 1.0);
      const x = cam.x + Math.cos(ang) * dist, y = cam.y + Math.sin(ang) * dist;
      const B = W.blockAt(x, y);
      if (B.type === 'industrial' && Math.random() < 0.7) continue;
      const u = Math.random() * ringLen(B.ped);
      const [px, py] = ringPos(B.ped, u);
      if (W.riverDist(px, py) < 10) continue;
      if (Math.hypot(px - P.x, py - P.y) < 300) continue;
      st.peds.push({ B, u, x: px, y: py, a: 0, dir: Math.random() < 0.5 ? 1 : -1, sp: 22 + Math.random() * 22, col: (Math.random() * 8) | 0, hair: HAIR[(Math.random() * HAIR.length) | 0], phase: 0, down: 0, vx: 0, vy: 0, side: (Math.random() - 0.5) * 8, flee: 0 });
    }
  }
  const far = st.viewR + 900;
  st.peds = st.peds.filter((p) => Math.abs(p.x - P.x) < far && Math.abs(p.y - P.y) < far);
  const pv = Math.hypot(P.vx, P.vy);
  for (const p of st.peds) {
    if (p.down > 0) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      const k = Math.exp(-4 * dt); p.vx *= k; p.vy *= k;
      p.down -= dt;
      if (p.down <= 0) { p.u = ringU(p.B.ped, p.x, p.y); p.side = 0; }
      continue;
    }
    // удар машиной
    const fx = Math.cos(P.a), fy = Math.sin(P.a);
    const rx = p.x - P.x, ry = p.y - P.y;
    const along = rx * fx + ry * fy, lat = -rx * fy + ry * fx;
    if ((P.z || 0) < 10 && Math.abs(along) < P.L / 2 + 4 && Math.abs(lat) < P.W / 2 + 4) {
      if (pv > 70) {
        p.down = 4; p.vx = P.vx * 0.8 + (Math.random() - 0.5) * 80; p.vy = P.vy * 0.8 + (Math.random() - 0.5) * 80; p.a = Math.atan2(p.vy, p.vx);
        st.onPedHit(p);
        continue;
      }
      p.x += (lat > 0 ? -fy : fy) * 4; p.y += (lat > 0 ? fx : -fx) * 4;
    }
    // уворачиваемся от машины
    const d = Math.hypot(rx, ry);
    if (d < 110 && pv > 90 && along > -20) {
      const s = lat > 0 ? 1 : -1;
      p.x += -fy * s * 160 * dt; p.y += fx * s * 160 * dt;
      p.flee = 0.6;
      p.phase += dt * 20;
      p.a = Math.atan2(fx * s, -fy * s);
      continue;
    }
    if (p.flee > 0) {
      p.flee -= dt;
      if (p.flee <= 0) p.u = ringU(p.B.ped, p.x, p.y);
      continue;
    }
    p.u += p.dir * p.sp * dt;
    const [x, y, a] = ringPos(p.B.ped, p.u);
    const nx = x + Math.cos(a + Math.PI / 2) * p.side, ny = y + Math.sin(a + Math.PI / 2) * p.side;
    p.x += (nx - p.x) * Math.min(1, dt * 6); p.y += (ny - p.y) * Math.min(1, dt * 6);
    p.a = a + (p.dir < 0 ? Math.PI : 0);
    p.phase += dt * p.sp * 0.25;
  }
}

// ---------------------------------------------------------------- поезда
const TRAIN_SPEED = 300, TRAIN_GAP = 16000, TRAIN_CARS = 7, CAR_LEN = 110;
export function updateTrains(st) {
  const { cam, time } = st;
  const R = st.viewR + 1500;
  st.trains = [];
  for (const i of W.railsInRange(cam.x - R, cam.x + R)) {
    const x0 = W.railX(i);
    for (const dir of [1, -1]) {
      const x = x0 + (dir > 0 ? -15 : 15);
      const off = (i * 7919 + (dir > 0 ? 0 : 5000)) % TRAIN_GAP;
      const base = (((dir * TRAIN_SPEED * time + off) % TRAIN_GAP) + TRAIN_GAP) % TRAIN_GAP;
      const len = TRAIN_CARS * CAR_LEN;
      for (let n = Math.floor((cam.y - R) / TRAIN_GAP) - 1; n <= Math.floor((cam.y + R) / TRAIN_GAP) + 1; n++) {
        const hy = n * TRAIN_GAP + base;
        const y0 = dir > 0 ? hy - len : hy;
        if (y0 + len < cam.y - R || y0 > cam.y + R) continue;
        st.trains.push({ x, y0, hy, len, dir, speed: TRAIN_SPEED, cars: TRAIN_CARS, carL: CAR_LEN });
      }
    }
  }
}
