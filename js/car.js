// Аркадная физика машины игрока и столкновения.
import * as W from './world.js';
import { clamp } from './util.js';

export const MAX_SPEED = 580;

export function createPlayer(x, y, a) {
  return { x, y, a, vx: 0, vy: 0, steer: 0, L: 48, W: 23, brake: false, reverse: false, drift: 0 };
}

export function updatePlayer(P, inp, dt, st) {
  const fx = Math.cos(P.a), fy = Math.sin(P.a);
  const rx = -fy, ry = fx;
  let vf = P.vx * fx + P.vy * fy;
  let vr = P.vx * rx + P.vy * ry;
  P.brake = false;
  if (inp.up) {
    if (vf < -8) { vf += 1000 * dt; P.brake = true; }
    else vf += 430 * (1 - Math.max(0, vf) / MAX_SPEED) * dt + 20 * dt;
  } else if (inp.down) {
    if (vf > 8) { vf -= 950 * dt; P.brake = true; }
    else vf = Math.max(-170, vf - 280 * dt);
  } else {
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), (40 + Math.abs(vf) * 0.5) * dt);
  }
  if (inp.hand) {
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), 260 * dt);
    P.brake = true;
  }
  P.reverse = vf < -8 && inp.down;
  const target = (inp.left ? -1 : 0) + (inp.right ? 1 : 0);
  P.steer += clamp(target - P.steer, -7 * dt, 7 * dt);
  const sp = Math.abs(vf);
  const turn = P.steer * 2.7 * clamp(vf / 130, -1, 1) / (1 + sp / 650) * (inp.hand ? 1.45 : 1);
  P.a += turn * dt;
  // сцепление шин
  const grip = inp.hand ? 1.4 : sp > 300 && Math.abs(P.steer) > 0.6 ? 7 : 11;
  vr *= Math.exp(-grip * dt);
  P.drift = Math.abs(vr);
  const nfx = Math.cos(P.a), nfy = Math.sin(P.a);
  P.vx = nfx * vf - nfy * vr;
  P.vy = nfy * vf + nfx * vr;

  const px = P.x, py = P.y;
  P.x += P.vx * dt;
  P.y += P.vy * dt;

  // следы шин
  if ((P.drift > 70 || (inp.hand && sp > 120) || (P.brake && sp > 260)) && st) {
    for (const s of [-1, 1]) {
      const wx = P.x - nfx * 16 - nfy * s * 8, wy = P.y - nfy * 16 + nfx * s * 8;
      const ox = px - Math.cos(P.a - turn * dt) * 16 - nfy * s * 8, oy = py - Math.sin(P.a - turn * dt) * 16 + nfx * s * 8;
      st.skids.push([ox, oy, wx, wy]);
    }
    if (st.skids.length > 1600) st.skids.splice(0, 200);
    if (Math.random() < 0.5) st.smoke.push({ x: P.x - nfx * 20, y: P.y - nfy * 20, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, s: 8, life: 1.2 });
  }

  // вода
  if (inWater(P)) {
    P.x = px; P.y = py;
    P.vx *= -0.3; P.vy *= -0.3;
    st && st.onImpact(150, P.x, P.y, false);
  }
}

function inWater(c) {
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  const hl = c.L / 2 - 4, hw = c.W / 2 - 3;
  const pts = [[c.x, c.y], [c.x + fx * hl - fy * hw, c.y + fy * hl + fx * hw], [c.x + fx * hl + fy * hw, c.y + fy * hl - fx * hw],
    [c.x - fx * hl - fy * hw, c.y - fy * hl + fx * hw], [c.x - fx * hl + fy * hw, c.y - fy * hl - fx * hw]];
  for (const [x, y] of pts) if (W.isWater(x, y)) return true;
  return false;
}

// ---------------------------------------------------------------- SAT
function obbAabb(c, b) {
  const fx = Math.cos(c.a), fy = Math.sin(c.a), rx = -fy, ry = fx;
  const hl = c.L / 2, hw = c.W / 2;
  const bhw = b.w / 2, bhh = b.h / 2;
  const dx = c.x - (b.x + bhw), dy = c.y - (b.y + bhh);
  let best = Infinity, nx = 0, ny = 0;
  const axes = [1, 0, 0, 1, fx, fy, rx, ry];
  for (let k = 0; k < 8; k += 2) {
    const ax = axes[k], ay = axes[k + 1];
    const rp = hl * Math.abs(fx * ax + fy * ay) + hw * Math.abs(rx * ax + ry * ay);
    const rb = bhw * Math.abs(ax) + bhh * Math.abs(ay);
    const d = dx * ax + dy * ay;
    const o = rp + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < best) { best = o; const s = d < 0 ? -1 : 1; nx = ax * s; ny = ay * s; }
  }
  return { nx, ny, d: best };
}

export function obbObb(c, o) {
  const f1x = Math.cos(c.a), f1y = Math.sin(c.a), f2x = Math.cos(o.a), f2y = Math.sin(o.a);
  const axes = [f1x, f1y, -f1y, f1x, f2x, f2y, -f2y, f2x];
  const dx = c.x - o.x, dy = c.y - o.y;
  let best = Infinity, nx = 0, ny = 0;
  for (let k = 0; k < 8; k += 2) {
    const ax = axes[k], ay = axes[k + 1];
    const r1 = (c.L / 2) * Math.abs(f1x * ax + f1y * ay) + (c.W / 2) * Math.abs(-f1y * ax + f1x * ay);
    const r2 = (o.L / 2) * Math.abs(f2x * ax + f2y * ay) + (o.W / 2) * Math.abs(-f2y * ax + f2x * ay);
    const d = dx * ax + dy * ay;
    const ov = r1 + r2 - Math.abs(d);
    if (ov <= 0) return null;
    if (ov < best) { best = ov; const s = d < 0 ? -1 : 1; nx = ax * s; ny = ay * s; }
  }
  return { nx, ny, d: best };
}

function obbCircle(c, ci) {
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  const dx = ci.x - c.x, dy = ci.y - c.y;
  const lx = dx * fx + dy * fy, ly = -dx * fy + dy * fx;
  const cxl = clamp(lx, -c.L / 2, c.L / 2), cyl = clamp(ly, -c.W / 2, c.W / 2);
  const ex = lx - cxl, ey = ly - cyl;
  const dist = Math.hypot(ex, ey);
  if (dist >= ci.r) return null;
  if (dist < 1e-6) {
    // центр внутри — выталкиваем по ближайшей оси
    const ox = c.L / 2 - Math.abs(lx), oy = c.W / 2 - Math.abs(ly);
    if (ox < oy) { const s = lx > 0 ? -1 : 1; return { nx: fx * s, ny: fy * s, d: ox + ci.r }; }
    const s = ly > 0 ? -1 : 1; return { nx: -fy * s, ny: fx * s, d: oy + ci.r };
  }
  // нормаль от окружности к машине в мировых координатах
  const wx = -(ex * fx - ey * fy) / dist, wy = -(ex * fy + ey * fx) / dist;
  return { nx: wx, ny: wy, d: ci.r - dist };
}

function respond(c, h, bounce = 0.35) {
  c.x += h.nx * h.d; c.y += h.ny * h.d;
  const vn = c.vx * h.nx + c.vy * h.ny;
  if (vn < 0) {
    c.vx -= (1 + bounce) * vn * h.nx; c.vy -= (1 + bounce) * vn * h.ny;
    c.vx *= 0.9; c.vy *= 0.9;
    // поворот от удара углом
    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    c.a += (fx * h.ny - fy * h.nx) * Math.min(0.25, -vn * 0.0007);
    return -vn;
  }
  return 0;
}

export function collideStatic(c, st, isPlayer) {
  let impact = 0, ix = 0, iy = 0;
  const r = Math.max(c.L, c.W);
  const i0 = W.colAt(c.x - r), i1 = W.colAt(c.x + r), j0 = W.rowAt(c.y - r), j1 = W.rowAt(c.y + r);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const B = W.getBlock(i, j);
      for (const b of B.boxes) {
        if (c.x + r < b.x || c.x - r > b.x + b.w || c.y + r < b.y || c.y - r > b.y + b.h) continue;
        const h = obbAabb(c, b);
        if (h) { const im = respond(c, h); if (im > impact) { impact = im; ix = c.x - h.nx * c.W / 2; iy = c.y - h.ny * c.W / 2; } }
      }
      for (const ci of B.circles) {
        if (Math.abs(ci.x - c.x) > r + ci.r || Math.abs(ci.y - c.y) > r + ci.r) continue;
        const h = obbCircle(c, ci);
        if (h) { const im = respond(c, h, 0.25); if (im > impact) { impact = im; ix = ci.x; iy = ci.y; } }
      }
    }
    if (st) for (const t of st.trains) {
      const box = { x: t.x - 13, y: t.y0, w: 26, h: t.len };
      if (c.x + r < box.x || c.x - r > box.x + box.w || c.y + r < box.y || c.y - r > box.y + box.h) continue;
      const h = obbAabb(c, box);
      if (h) {
        c.vy += t.dir * t.speed * 0.5;
        const im = respond(c, h, 0.6) + 150;
        if (im > impact) { impact = im; ix = c.x; iy = c.y; }
      }
    }
  }
  if (impact > 0 && st && isPlayer) st.onImpact(impact, ix, iy, true);
  return impact;
}

export function collideCars(P, cars, st) {
  for (const o of cars) {
    if (Math.abs(o.x - P.x) > 90 || Math.abs(o.y - P.y) > 90) continue;
    const h = obbObb(P, o);
    if (!h) continue;
    const mP = 1.3, mO = o.heavy ? 4 : 1;
    const tot = mP + mO;
    P.x += h.nx * h.d * (mO / tot); P.y += h.ny * h.d * (mO / tot);
    o.x -= h.nx * h.d * (mP / tot); o.y -= h.ny * h.d * (mP / tot);
    if (o.mode !== 'hit') { o.vx = Math.cos(o.a) * o.speed; o.vy = Math.sin(o.a) * o.speed; o.mode = 'hit'; o.av = 0; o.hitT = 0; }
    const rel = (P.vx - o.vx) * h.nx + (P.vy - o.vy) * h.ny;
    if (rel < 0) {
      const j = (-(1.3) * rel) / (1 / mP + 1 / mO);
      P.vx += (j / mP) * h.nx; P.vy += (j / mP) * h.ny;
      o.vx -= (j / mO) * h.nx; o.vy -= (j / mO) * h.ny;
      o.av += (Math.random() - 0.5) * Math.min(4, -rel * 0.012) * (4 / (mO + 3));
      st.onImpact(-rel, P.x - h.nx * 12, P.y - h.ny * 12, true);
    }
  }
}
