// Аркадная физика машины: езда, высота (пандусы, крыши, прыжки), столкновения,
// повреждения, ломающиеся фонари и стёкла.
import * as W from './world.js';
import { clamp } from './util.js';
import { CS, peekChunk } from './chunks.js';

export const MAX_SPEED = 580;
const GRAVITY = 720;
const CAR_H = 18;

export function createPlayer(x, y, a) {
  return {
    x, y, a, vx: 0, vy: 0, steer: 0, L: 48, W: 23, brake: false, reverse: false, drift: 0,
    z: 0, vz: 0, air: false, pitch: 0, power: 1,
    hp: 100, dmg: { front: 0, rear: 0, left: 0, right: 0 }, dead: false, deadT: 0, gen: 0,
  };
}

export function repairPlayer(P) {
  P.hp = 100; P.dmg = { front: 0, rear: 0, left: 0, right: 0 }; P.dead = false; P.deadT = 0; P.gen++;
  P.z = 0; P.vz = 0; P.air = false;
}

// Повреждения по зонам: удар приходит со стороны, противоположной нормали выталкивания
export function damagePlayer(P, impact, nx, ny, st) {
  if (P.dead || impact < 70) return;
  const fx = Math.cos(P.a), fy = Math.sin(P.a);
  const lx = -(nx * fx + ny * fy), ly = -(-nx * fy + ny * fx);
  const zone = Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 'front' : 'rear') : (ly > 0 ? 'right' : 'left');
  const amount = Math.min(45, (impact - 70) * 0.11);
  P.hp = Math.max(0, P.hp - amount);
  P.dmg[zone] = Math.min(1, P.dmg[zone] + amount / 45);
  if (st && st.onDamage) st.onDamage(zone, amount, P);
  if (P.hp <= 0 && !P.dead) { P.dead = true; P.deadT = 0; if (st && st.onWreck) st.onWreck(P); }
}

export function updatePlayer(P, inp, dt, st) {
  const fx = Math.cos(P.a), fy = Math.sin(P.a);
  const rx = -fy, ry = fx;
  let vf = P.vx * fx + P.vy * fy;
  let vr = P.vx * rx + P.vy * ry;
  P.brake = false;
  const px = P.x, py = P.y;
  if (P.dead) inp = { up: false, down: false, left: false, right: false, hand: true };

  if (P.air) {
    // в полёте колёса не держат: летим по инерции, руль чуть доворачивает
    P.a += (P.steer || 0) * 0.6 * dt;
    P.x += P.vx * dt; P.y += P.vy * dt;
  } else {
    // повреждения: меньше мощность и максималка, машину уводит в сторону помятого бока
    const perf = (0.5 + 0.5 * (P.hp / 100)) * (P.power || 1);
    const vmax = MAX_SPEED * (0.55 + 0.45 * (P.hp / 100)) * (P.power || 1);
    if (inp.up) {
      if (vf < -8) { vf += 1000 * dt; P.brake = true; }
      else vf += 430 * perf * (1 - Math.max(0, vf) / vmax) * dt + 20 * dt;
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
    const target = (inp.left ? -1 : 0) + (inp.right ? 1 : 0) + (P.dmg.right - P.dmg.left) * 0.12;
    P.steer += clamp(target - P.steer, -7 * dt, 7 * dt);
    const sp = Math.abs(vf);
    const turn = P.steer * 2.7 * clamp(vf / 130, -1, 1) / (1 + sp / 650) * (inp.hand ? 1.45 : 1);
    P.a += turn * dt;
    const grip = inp.hand ? 1.4 : sp > 300 && Math.abs(P.steer) > 0.6 ? 7 : 11;
    vr *= Math.exp(-grip * dt);
    P.drift = Math.abs(vr);
    const nfx = Math.cos(P.a), nfy = Math.sin(P.a);
    P.vx = nfx * vf - nfy * vr;
    P.vy = nfy * vf + nfx * vr;
    P.x += P.vx * dt;
    P.y += P.vy * dt;
    // следы шин
    if ((P.drift > 70 || (inp.hand && sp > 120) || (P.brake && sp > 260)) && st && st.skids) {
      for (const s of [-1, 1]) {
        const wx = P.x - nfx * 16 - nfy * s * 8, wy = P.y - nfy * 16 + nfx * s * 8;
        const ox = px - Math.cos(P.a - turn * dt) * 16 - nfy * s * 8, oy = py - Math.sin(P.a - turn * dt) * 16 + nfx * s * 8;
        st.skids.push([ox, oy, wx, wy, P.z]);
      }
      if (st.skids.length > 1600) st.skids.splice(0, 200);
    }
  }

  // высота: следуем поверхности, а если она уходит вниз или кончается подъём — летим
  const s = W.surfaceAt(P.x, P.y, P.z);
  const zn = P.z + P.vz * dt;
  if (P.air || (P.vz > 0 && zn > s + 0.5) || zn > s + 3) {
    P.air = true;
    P.vz -= GRAVITY * dt;
    P.z += P.vz * dt;
    if (P.z <= s) {
      const hit = -P.vz;
      P.z = s; P.vz = 0; P.air = false;
      if (hit > 220 && st && st.onImpact) {
        st.onImpact(hit * 0.8, P.x, P.y, true);
        damagePlayer(P, 60 + hit * 0.25, 0, 0, null);
      }
    }
  } else {
    P.vz = clamp((s - P.z) / Math.max(dt, 1e-3), -400, 700);
    P.z = s;
  }
  const spd = Math.hypot(P.vx, P.vy);
  const pitchT = P.air ? clamp(Math.atan2(P.vz, spd + 1), -0.5, 0.5) : clamp(Math.atan2(P.vz, spd + 1), -0.4, 0.4);
  P.pitch += (pitchT - P.pitch) * Math.min(1, dt * 10);

  // вода (только у самой поверхности)
  if (P.z < 2 && inWater(P)) {
    P.x = px; P.y = py;
    P.vx *= -0.3; P.vy *= -0.3;
    if (st && st.onImpact) st.onImpact(150, P.x, P.y, false);
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
    const ox = c.L / 2 - Math.abs(lx), oy = c.W / 2 - Math.abs(ly);
    if (ox < oy) { const s = lx > 0 ? -1 : 1; return { nx: fx * s, ny: fy * s, d: ox + ci.r }; }
    const s = ly > 0 ? -1 : 1; return { nx: -fy * s, ny: fx * s, d: oy + ci.r };
  }
  const wx = -(ex * fx - ey * fy) / dist, wy = -(ex * fy + ey * fx) / dist;
  return { nx: wx, ny: wy, d: ci.r - dist };
}

function respond(c, h, bounce = 0.35) {
  c.x += h.nx * h.d; c.y += h.ny * h.d;
  const vn = c.vx * h.nx + c.vy * h.ny;
  if (vn < 0) {
    c.vx -= (1 + bounce) * vn * h.nx; c.vy -= (1 + bounce) * vn * h.ny;
    c.vx *= 0.9; c.vy *= 0.9;
    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    c.a += (fx * h.ny - fy * h.nx) * Math.min(0.25, -vn * 0.0007);
    return -vn;
  }
  return 0;
}

// препятствие по высоте: машина [z, z+CAR_H] пересекается с [z0, z1]
const zHit = (c, z0 = 0, z1 = Infinity) => (c.z || 0) < z1 - 2 && (c.z || 0) + CAR_H > z0;

export function collideStatic(c, st, isPlayer) {
  let impact = 0, ix = 0, iy = 0, inx = 0, iny = 0;
  if (st && st.onLampBreak) hitLamps(c, st, isPlayer);
  const r = Math.max(c.L, c.W);
  const i0 = W.colAt(c.x - r), i1 = W.colAt(c.x + r), j0 = W.rowAt(c.y - r), j1 = W.rowAt(c.y + r);
  const near = (b) => !(c.x + r < b.x || c.x - r > b.x + b.w || c.y + r < b.y || c.y - r > b.y + b.h);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const B = W.getBlock(i, j);
      for (const b of B.boxes) {
        if (b.noSide || !near(b) || !zHit(c, b.z0, b.z1)) continue;
        const h = obbAabb(c, b);
        if (h) { const im = respond(c, h); if (im > impact) { impact = im; ix = c.x - h.nx * c.W / 2; iy = c.y - h.ny * c.W / 2; inx = h.nx; iny = h.ny; } }
      }
      for (const ci of B.circles) {
        if (Math.abs(ci.x - c.x) > r + ci.r || Math.abs(ci.y - c.y) > r + ci.r || !zHit(c, 0, ci.z1)) continue;
        const h = obbCircle(c, ci);
        if (h) { const im = respond(c, h, 0.25); if (im > impact) { impact = im; ix = ci.x; iy = ci.y; inx = h.nx; iny = h.ny; } }
      }
      // пандус сбоку — сплошной клин
      for (const rp of B.ramps) {
        if (!near(rp)) continue;
        const hgt = W.rampHeight(rp, c.x, c.y);
        if ((c.z || 0) >= hgt - 14) continue;
        const h = obbAabb(c, rp);
        if (h) { const im = respond(c, h); if (im > impact) { impact = im; ix = c.x; iy = c.y; inx = h.nx; iny = h.ny; } }
      }
      // стеклянные витрины: на скорости бьются, медленно — упираемся
      for (const p of B.panes) {
        if (p.broken || !near(p) || !zHit(c, 0, p.z1)) continue;
        const h = obbAabb(c, p);
        if (!h) continue;
        const sp = Math.hypot(c.vx, c.vy);
        if (sp > 60 && st && st.onPaneBreak) {
          p.broken = true;
          c.vx *= 0.92; c.vy *= 0.92;
          st.onPaneBreak(p, c, isPlayer);
        } else respond(c, h, 0.2);
      }
    }
    if (st && st.trains) for (const t of st.trains) {
      const box = { x: t.x - 13, y: t.y0, w: 26, h: t.len };
      if (!near(box) || !zHit(c, 0, 30)) continue;
      const h = obbAabb(c, box);
      if (h) {
        c.vy += t.dir * t.speed * 0.5;
        const im = respond(c, h, 0.6) + 150;
        if (im > impact) { impact = im; ix = c.x; iy = c.y; inx = h.nx; iny = h.ny; }
      }
    }
  }
  if (impact > 0 && st && st.onImpact) {
    if (isPlayer) st.onImpact(impact, ix, iy, true);
    damagePlayer(c, impact, inx, iny, st);
  }
  return impact;
}

// Столбы фонарей: на скорости ломаются и падают, медленно — обычное препятствие
function hitLamps(c, st, isPlayer) {
  if ((c.z || 0) > 50) return;
  const r = c.L / 2 + 8;
  const cx0 = Math.floor((c.x - r) / CS), cx1 = Math.floor((c.x + r) / CS);
  const cy0 = Math.floor((c.y - r) / CS), cy1 = Math.floor((c.y + r) / CS);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const ch = peekChunk(cx, cy);
    if (!ch) continue;
    for (const l of ch.lamps) {
      if (!l.pole || l.broken || Math.abs(l.x - c.x) > r || Math.abs(l.y - c.y) > r) continue;
      const h = obbCircle(c, { x: l.x, y: l.y, r: 4.5 });
      if (!h) continue;
      const sp = Math.hypot(c.vx, c.vy);
      if (sp > 50) {
        l.broken = true;
        l.fallA = Math.atan2(c.vy, c.vx);
        c.vx *= 0.82; c.vy *= 0.82;
        st.onLampBreak(l, sp, isPlayer);
        damagePlayer(c, 70 + sp * 0.1, h.nx, h.ny, st);
      } else {
        respond(c, h, 0.2);
      }
    }
  }
}

// Игрок (или коп) против машин трафика
export function collideCars(P, cars, st) {
  for (const o of cars) {
    if (Math.abs(o.x - P.x) > 90 || Math.abs(o.y - P.y) > 90 || (P.z || 0) > 16) continue;
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
      if (st.onImpact) st.onImpact(-rel, P.x - h.nx * 12, P.y - h.ny * 12, true);
      if (st.onCarHit) st.onCarHit(o, -rel);
      damagePlayer(P, -rel, h.nx, h.ny, st);
    }
  }
}

// Две машины с полной физикой (игрок и полиция)
export function collideDyn(a, b, sta, stb) {
  if (Math.abs(a.x - b.x) > 90 || Math.abs(a.y - b.y) > 90 || Math.abs((a.z || 0) - (b.z || 0)) > 16) return 0;
  const h = obbObb(a, b);
  if (!h) return 0;
  a.x += h.nx * h.d * 0.5; a.y += h.ny * h.d * 0.5;
  b.x -= h.nx * h.d * 0.5; b.y -= h.ny * h.d * 0.5;
  const rel = (a.vx - b.vx) * h.nx + (a.vy - b.vy) * h.ny;
  if (rel >= 0) return 0;
  const j = -1.3 * rel / 2;
  a.vx += j * h.nx; a.vy += j * h.ny;
  b.vx -= j * h.nx; b.vy -= j * h.ny;
  if (sta !== null) damagePlayer(a, -rel, h.nx, h.ny, sta);
  if (stb !== null) damagePlayer(b, -rel, -h.nx, -h.ny, stb);
  return -rel;
}
