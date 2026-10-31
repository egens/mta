// Трафик и пешеходы на карте Москвы: машины ездят по графу улиц OSM
// (с односторонним движением и светофорами), пешеходы — по тротуарам и дорожкам.
import * as OSM from './osm.js';
import { CAR_COLORS, CAR_DIM, BUS_COLORS, WORK_COLORS } from './sprites.js';
import { hashU } from './util.js';
import { obbObb, collideStatic } from './car.js';
import { busStop } from './traffic.js';
import { worksSteer } from './roadworks.js';

const MAX_CARS = 30, MAX_PEDS = 40;
const CRUISE = { motorway: 330, trunk: 300, primary: 260, secondary: 230, tertiary: 200, residential: 150, unclassified: 150, living_street: 90, service: 90 };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function signalGreen(id, ax, t) {
  const ph = ((hashU(id % 1000003, 7, 7) % 1000) / 1000) * 16;
  const p = (t + ph) % 16;
  const s = p < 6.5 ? 0 : p < 8 ? 1 : p < 14.5 ? 2 : 3;
  return ax === 'h' ? s === 0 : s === 2;
}

function setSeg(c, from, to) {
  const e = from.adj.get(to.id);
  c.from = from; c.to = to; c.road = e.road;
  c.len = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
  c.s = 0;
  const r = e.road;
  c.off = r.oneway ? (r.w > 100 ? (c.laneK - 0.5) * r.w * 0.4 : 0) : r.w / 4;
  c.cruise = (CRUISE[r.hw.replace('_link', '')] || 150) * c.var;
}

function pickNext(c) {
  const opts = [...c.to.adj.keys()].filter((id) => id !== c.from.id).map((id) => OSM.graph.get(id)).filter(Boolean);
  if (!opts.length) {
    const back = c.to.adj.has(c.from.id) ? c.from : null;
    return back;
  }
  // предпочитаем ехать прямо
  const a0 = Math.atan2(c.to.y - c.from.y, c.to.x - c.from.x);
  let tot = 0;
  const w = opts.map((n) => { const d = Math.abs(wrap(Math.atan2(n.y - c.to.y, n.x - c.to.x) - a0)); const v = d < 0.5 ? 4 : d < 2 ? 1 : 0.2; tot += v; return v; });
  let r = Math.random() * tot;
  for (let k = 0; k < opts.length; k++) { r -= w[k]; if (r <= 0) return opts[k]; }
  return opts[0];
}

function pickKind(c) {
  const r = Math.random();
  const pick = (a) => a[(Math.random() * a.length) | 0];
  if (r < 0.05) { c.kind = 'truck'; c.color = pick(['#9aa0a8', '#c84a2a', '#2a5aa8', '#e0e0e0']); c.heavy = true; c.var *= 0.8; }
  else if (r < 0.14) { c.kind = 'bus'; c.color = pick(BUS_COLORS); c.heavy = true; c.var *= 0.75; c.stopIn = 6 + Math.random() * 14; }
  else if (r < 0.19) { c.kind = pick(['dump', 'dump', 'mixer', 'roller']); c.color = pick(WORK_COLORS); c.heavy = true; c.var *= c.kind === 'roller' ? 0.5 : 0.72; }
  else if (r < 0.36) { c.kind = 'taxi'; c.color = '#e8b81c'; }
  else if (r < 0.39) { c.kind = 'police'; c.color = '#e8e8ee'; c.police = true; }
  else { c.kind = pick(['sedan', 'sedan', 'sedan', 'hatch', 'van']); c.color = pick(CAR_COLORS); }
  [c.L, c.W] = CAR_DIM[c.kind];
}

function spawnCar(st) {
  const P = st.player;
  const R = st.viewR + 900;
  const cand = [...OSM.nodesIn(P.x - R, P.y - R, P.x + R, P.y + R)].filter((n) => {
    const d = Math.hypot(n.x - P.x, n.y - P.y);
    return n.adj.size && d > st.viewR * 0.75 && d < R;
  });
  if (!cand.length) return;
  const from = cand[(Math.random() * cand.length) | 0];
  const ids = [...from.adj.keys()];
  const to = OSM.graph.get(ids[(Math.random() * ids.length) | 0]);
  if (!to) return;
  const c = { x: 0, y: 0, a: 0, speed: 0, mode: 'drive', vx: 0, vy: 0, av: 0, brake: false, var: 0.85 + Math.random() * 0.3, laneK: Math.random() < 0.5 ? 0 : 1 };
  pickKind(c);
  setSeg(c, from, to);
  c.s = Math.random() * c.len;
  place(c, 1);
  for (const o of st.traffic) if (Math.abs(o.x - c.x) < 70 && Math.abs(o.y - c.y) < 70) return;
  c.speed = c.cruise * 0.7;
  st.traffic.push(c);
}

function basePos(c) {
  const dx = (c.to.x - c.from.x) / c.len, dy = (c.to.y - c.from.y) / c.len;
  return [c.from.x + dx * c.s - dy * c.off, c.from.y + dy * c.s + dx * c.off];
}
function place(c, k) {
  const dx = (c.to.x - c.from.x) / c.len, dy = (c.to.y - c.from.y) / c.len;
  const [bx, by] = basePos(c);
  const tx = bx + (c.wx || 0), ty = by + (c.wy || 0);
  c.x += (tx - c.x) * k; c.y += (ty - c.y) * k;
  const a = Math.atan2(dy, dx);
  c.a = k >= 1 ? a : c.a + wrap(a - c.a) * Math.min(1, k * 1.5);
}

export function updateTrafficOSM(st, dt) {
  const P = st.player;
  if (st.traffic.length < MAX_CARS) for (let k = 0; k < 2; k++) spawnCar(st);
  const far = st.viewR + 1500;
  st.traffic = st.traffic.filter((c) => Math.abs(c.x - P.x) < far && Math.abs(c.y - P.y) < far && (c.mode !== 'drive' || c.to));
  for (const c of st.traffic) {
    if (c.mode !== 'drive') {
      c.x += c.vx * dt; c.y += c.vy * dt; c.a += c.av * dt;
      const k = Math.exp(-2.2 * dt);
      c.vx *= k; c.vy *= k; c.av *= Math.exp(-3 * dt);
      c.hitT = (c.hitT || 0) + dt; c.speed = 0; c.brake = true;
      collideStatic(c, null, false);
      continue;
    }
    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    let target = Math.min(c.cruise, c.wcap || Infinity);
    // светофор и поворот впереди
    const rem = c.len - c.s;
    if (busStop(c, dt, c.s > 100 && rem > 200)) target = 0;
    if (c.to.signal && rem < 160) {
      const ax = Math.abs(c.to.x - c.from.x) > Math.abs(c.to.y - c.from.y) ? 'h' : 'v';
      if (!signalGreen(c.to.id, ax, st.time)) target = Math.min(target, Math.sqrt(2 * 380 * Math.max(0, rem - 70)));
    }
    if (rem < 90) target = Math.min(target, 140);
    const check = (o, any) => {
      const rx = o.x - c.x, ry = o.y - c.y;
      const along = rx * fx + ry * fy;
      if (along <= 0 || along > 150) return;
      if (Math.abs(-rx * fy + ry * fx) > (any ? 24 : 16)) return;
      if (!any && o.mode === 'drive' && Math.cos(o.a - c.a) < 0.3) return;
      target = Math.min(target, Math.max(0, along - (c.L + (o.L || 46)) / 2 - 10) * 2.2);
    };
    for (const o of st.traffic) if (o !== c && Math.abs(o.x - c.x) < 160 && Math.abs(o.y - c.y) < 160) check(o, o.mode !== 'drive');
    if ((P.z || 0) < 10) check(P, true);
    for (const o of st.cops) if (Math.abs(o.x - c.x) < 160 && Math.abs(o.y - c.y) < 160) check(o, true);
    for (const p of st.peds) {
      if (p.down > 0) continue;
      const rx = p.x - c.x, ry = p.y - c.y, along = rx * fx + ry * fy;
      if (along > 0 && along < 70 && Math.abs(-rx * fy + ry * fx) < 16) target = 0;
    }
    const acc = target > c.speed ? 140 : 420;
    c.speed = Math.max(0, c.speed + Math.max(-acc * dt, Math.min(acc * dt, target - c.speed)));
    c.brake = target < c.speed - 4 || c.speed < 3;
    c.s += c.speed * dt;
    while (c.s >= c.len) {
      const extra = c.s - c.len;
      const nxt = pickNext(c);
      if (!nxt) { c.to = null; break; }
      setSeg(c, c.to, nxt);
      c.s = extra;
    }
    if (c.to) { const [bx, by] = basePos(c); c.wcap = worksSteer(st, c, bx, by, dt); place(c, Math.min(1, dt * 10)); }
  }
  // столкновения машин после аварии
  for (const c of st.traffic) {
    if (c.mode === 'drive') continue;
    for (const o of st.traffic) {
      if (o === c || Math.abs(o.x - c.x) > 80 || Math.abs(o.y - c.y) > 80) continue;
      const h = obbObb(c, o);
      if (!h) continue;
      c.x += h.nx * h.d * 0.5; c.y += h.ny * h.d * 0.5;
      if (o.mode !== 'drive') { o.x -= h.nx * h.d * 0.5; o.y -= h.ny * h.d * 0.5; }
      else { o.mode = 'hit'; o.vx = Math.cos(o.a) * o.speed; o.vy = Math.sin(o.a) * o.speed; o.av = (Math.random() - 0.5) * 2; o.hitT = 0; }
    }
  }
}

// ---------------------------------------------------------------- пешеходы
const HAIR = ['#2a1a10', '#5a3a1a', '#d8c070', '#1a1a1a', '#8a8a8a', '#a04a20'];

function spawnPed(st) {
  const P = st.player;
  const R = st.viewR * 1.2;
  const x = P.x + (Math.random() * 2 - 1) * R, y = P.y + (Math.random() * 2 - 1) * R;
  const paths = [...OSM.pathsIn(x - 300, y - 300, x + 300, y + 300)];
  const roads = [...OSM.roadsIn(x - 300, y - 300, x + 300, y + 300)].filter((r) => r.kind === 'car' && r.rank >= 3);
  let line, off;
  if (paths.length && Math.random() < 0.6) { line = paths[(Math.random() * paths.length) | 0]; off = 0; }
  else if (roads.length) { line = roads[(Math.random() * roads.length) | 0]; off = (line.w / 2 + 14) * (Math.random() < 0.5 ? 1 : -1); }
  else return;
  const seg = 1 + ((Math.random() * (line.pts.length / 2 - 1)) | 0);
  const p = { line, seg, t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1, off, x: 0, y: 0, a: 0, sp: 22 + Math.random() * 20, col: (Math.random() * 8) | 0, hair: HAIR[(Math.random() * HAIR.length) | 0], phase: 0, down: 0, vx: 0, vy: 0 };
  pedPlace(p, 1);
  if (Math.hypot(p.x - P.x, p.y - P.y) < 300 || OSM.isWater(p.x, p.y)) return;
  st.peds.push(p);
}
function pedPlace(p, k) {
  const pts = p.line.pts;
  const ax = pts[p.seg * 2 - 2], ay = pts[p.seg * 2 - 1], bx = pts[p.seg * 2], by = pts[p.seg * 2 + 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const dx = (bx - ax) / len, dy = (by - ay) / len;
  const tx = ax + (bx - ax) * p.t - dy * p.off, ty = ay + (by - ay) * p.t + dx * p.off;
  p.x += (tx - p.x) * k; p.y += (ty - p.y) * k;
  p.a = Math.atan2(dy * p.dir, dx * p.dir);
  return len;
}

export function updatePedsOSM(st, dt) {
  const P = st.player;
  if (st.peds.length < MAX_PEDS) spawnPed(st);
  const far = st.viewR + 900;
  st.peds = st.peds.filter((p) => Math.abs(p.x - P.x) < far && Math.abs(p.y - P.y) < far);
  const pv = Math.hypot(P.vx, P.vy);
  const fx = Math.cos(P.a), fy = Math.sin(P.a);
  for (const p of st.peds) {
    if (p.down > 0) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      const k = Math.exp(-4 * dt); p.vx *= k; p.vy *= k;
      p.down -= dt;
      continue;
    }
    const rx = p.x - P.x, ry = p.y - P.y;
    const along = rx * fx + ry * fy, lat = -rx * fy + ry * fx;
    if ((P.z || 0) < 10 && Math.abs(along) < P.L / 2 + 4 && Math.abs(lat) < P.W / 2 + 4 && pv > 70) {
      p.down = 4; p.vx = P.vx * 0.8; p.vy = P.vy * 0.8; p.a = Math.atan2(p.vy, p.vx);
      st.onPedHit(p);
      continue;
    }
    if (Math.hypot(rx, ry) < 110 && pv > 90 && along > -20) {
      const s = lat > 0 ? 1 : -1;
      p.x += -fy * s * 160 * dt; p.y += fx * s * 160 * dt;
      p.phase += dt * 20;
      continue;
    }
    const len = pedPlace(p, Math.min(1, dt * 6));
    p.t += (p.dir * p.sp * dt) / len;
    const n = p.line.pts.length / 2;
    if (p.t > 1) { if (p.seg < n - 1) { p.seg++; p.t = 0; } else { p.t = 1; p.dir = -1; } }
    if (p.t < 0) { if (p.seg > 1) { p.seg--; p.t = 1; } else { p.t = 0; p.dir = 1; } }
    p.phase += dt * p.sp * 0.25;
  }
}
