// Ремонт дорог: участки полосы, огороженные конусами и щитами, с техникой и рабочими.
// Трафик заранее перестраивается и объезжает участок; конусы и щиты можно сбить,
// в технику — врезаться. Участки появляются вне экрана и исчезают далеко позади.
import { MAP } from './map.js';

const MAX_WORKS = 3;
const GRAVITY = 900;

// Участок: центр, ось вдоль полосы (ux, uy), направление к оси дороги (ix, iy),
// полудлина hl и полуширина hw закрытой полосы.
function makeZone(sp) {
  const { x, y, ux, uy, ix, iy, hl, hw } = sp;
  const z = { x, y, ux, uy, ix, iy, hl, hw, cones: [], boards: [], solid: [], workers: [], id: Math.random(), t: 0 };
  const at = (u, v) => [x + ux * u + ix * v, y + uy * u + iy * v];
  const a = Math.atan2(uy, ux);
  // конусы вдоль внутренней кромки и сужения с обоих концов
  for (let u = -hl + 40; u <= hl - 40; u += 34) z.cones.push(cone(...at(u, hw)));
  for (const s of [-1, 1]) for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    z.cones.push(cone(...at(s * (hl - 40 + t * 90), hw * (1 - t) + -hw * 0.8 * t)));
  }
  // щиты поперёк полосы на концах
  for (const s of [-1, 1]) {
    const [bx, by] = at(s * (hl - 14), -hw * 0.1);
    z.boards.push({ x: bx, y: by, a: a + Math.PI / 2, L: hw * 1.7, W: 4, down: 0, fall: 0, s });
  }
  // техника: экскаватор над раскопом и каток или самосвал рядом
  const ex = at(-hl * 0.15, -hw * 0.1);
  z.solid.push({ kind: 'excavator', x: ex[0], y: ex[1], a: a + (Math.random() < 0.5 ? 0 : Math.PI), L: 54, W: 26, h: 40, arm: Math.random() * 6 });
  const second = Math.random() < 0.5 ? 'roller' : 'dump';
  const sx = at(hl * 0.45, -hw * 0.1);
  z.solid.push({ kind: second, x: sx[0], y: sx[1], bx: sx[0], by: sx[1], a: a + (Math.random() < 0.5 ? 0 : Math.PI), L: second === 'roller' ? 44 : 70, W: 26, h: 34 });
  // раскоп и свежий асфальт — для отрисовки
  z.pit = { u0: -hl * 0.45, u1: hl * 0.15 };
  z.fresh = { u0: hl * 0.15, u1: hl - 50 };
  for (let k = 0; k < 2 + (Math.random() < 0.5 ? 1 : 0); k++) {
    const [wx, wy] = at(-hl * 0.5 + Math.random() * hl, (Math.random() - 0.5) * hw * 1.2);
    z.workers.push({ x: wx, y: wy, a: Math.random() * Math.PI * 2, phase: Math.random() * 6, down: 0, vx: 0, vy: 0 });
  }
  z.lamps = [at(-hl + 30, -hw + 2), at(hl - 30, -hw + 2)];
  z.a = a;
  return z;
}
const cone = (x, y) => ({ x, y, z: 0, vx: 0, vy: 0, vz: 0, rot: 0, tip: 0, down: false });

export function updateWorks(st, dt) {
  if (!st.works) st.works = [];
  const P = st.player;
  st.works = st.works.filter((z) => Math.hypot(z.x - P.x, z.y - P.y) < 5200);
  st.worksT = (st.worksT || 0) - dt;
  if (st.works.length < MAX_WORKS && st.worksT <= 0 && MAP.impl.worksSpot) {
    st.worksT = 1.2;
    const sp = MAP.impl.worksSpot(P.x, P.y, 1500, 3200);
    if (sp && st.works.every((z) => Math.hypot(z.x - sp.x, z.y - sp.y) > 900)) st.works.push(makeZone(sp));
  }
  const movers = [P, ...st.cops, ...st.traffic.filter((c) => c.mode !== 'drive')];
  for (const z of st.works) {
    z.t += dt;
    const near = Math.abs(z.x - P.x) < 3000 && Math.abs(z.y - P.y) < 3000;
    if (!near) continue;
    for (const c of z.cones) {
      if (c.down || c.z > 0 || c.vz) {
        c.vz -= GRAVITY * dt;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt; c.rot += c.vx * dt * 0.05;
        if (c.z <= 0) { c.z = 0; c.vz = Math.abs(c.vz) > 60 ? -c.vz * 0.3 : 0; const k = Math.exp(-6 * dt); c.vx *= k; c.vy *= k; }
      }
    }
    for (const b of z.boards) if (b.down) b.fall = Math.min(1, b.fall + dt * 4);
    // каток укатывает свежий асфальт взад-вперёд
    for (const m of z.solid) if (m.kind === 'roller') { const o = Math.sin(z.t * 0.5) * 30; m.x = m.bx + z.ux * o; m.y = m.by + z.uy * o; }
    for (const w of z.workers) {
      if (w.down > 0) { w.x += w.vx * dt; w.y += w.vy * dt; const k = Math.exp(-4 * dt); w.vx *= k; w.vy *= k; w.down -= dt; continue; }
      w.phase += dt;
    }
    for (const m of movers) {
      if (Math.abs(z.x - m.x) > z.hl + 80 || Math.abs(z.y - m.y) > z.hl + 80 || (m.z || 0) > 30) continue;
      const sp = Math.hypot(m.vx, m.vy);
      const fx = Math.cos(m.a), fy = Math.sin(m.a);
      const inBox = (x, y, pad) => {
        const rx = x - m.x, ry = y - m.y;
        return Math.abs(rx * fx + ry * fy) < m.L / 2 + pad && Math.abs(-rx * fy + ry * fx) < m.W / 2 + pad;
      };
      for (const c of z.cones) {
        if (c.down || !inBox(c.x, c.y, 4)) continue;
        c.down = true;
        c.vx = m.vx * 1.15 + (Math.random() - 0.5) * 120; c.vy = m.vy * 1.15 + (Math.random() - 0.5) * 120;
        c.vz = 120 + sp * 0.4; c.tip = Math.random() * Math.PI * 2;
        m.vx *= 0.985; m.vy *= 0.985;
        if (m === P && st.onConeHit) st.onConeHit(c, sp);
      }
      for (const b of z.boards) {
        if (b.down) continue;
        const bx = Math.cos(b.a), by = Math.sin(b.a);
        const rx = m.x - b.x, ry = m.y - b.y;
        if (Math.abs(rx * bx + ry * by) > b.L / 2 + m.W / 2 || Math.abs(-rx * by + ry * bx) > m.L / 2 + 3) continue;
        b.down = true; b.fallA = Math.atan2(m.vy, m.vx);
        m.vx *= 0.9; m.vy *= 0.9;
        if (m === P && st.onBoardHit) st.onBoardHit(b, sp);
      }
      if (m === P) for (const w of z.workers) {
        if (w.down > 0) continue;
        const d = Math.hypot(w.x - m.x, w.y - m.y);
        if (d < m.L / 2 + 6 && sp > 70) {
          w.down = 4; w.vx = m.vx * 0.8; w.vy = m.vy * 0.8; w.a = Math.atan2(w.vy, w.vx);
          if (st.onPedHit) st.onPedHit(w);
        } else if (d < 120 && sp > 120) {
          // рабочий отскакивает с дороги
          const s = (-(w.x - m.x) * fy + (w.y - m.y) * fx) > 0 ? 1 : -1;
          w.x += -fy * s * 150 * dt; w.y += fx * s * 150 * dt;
        }
      }
    }
  }
}

// Куда сместить машину трафика, чтобы объехать участки, и до какой скорости сбросить.
// x, y — положение на её полосе без смещения.
export function worksShift(st, x, y, a, W) {
  let dx = 0, dy = 0, cap = Infinity;
  if (!st.works) return [0, 0, cap];
  const fx = Math.cos(a), fy = Math.sin(a);
  for (const z of st.works) {
    const rx = x - z.x, ry = y - z.y;
    const along = rx * z.ux + ry * z.uy;
    const reach = z.hl + 200;
    if (along > reach || along < -reach) continue;
    if (Math.abs(fx * z.ux + fy * z.uy) < 0.6) continue; // поперечная улица
    const lat = rx * z.ix + ry * z.iy;
    const need = z.hw + W / 2 + 7;
    if (lat >= need || lat < -need - 20) continue;
    const ramp = Math.min(1, (reach - Math.abs(along)) / 170);
    const d = (need - lat) * ramp;
    dx += z.ix * d; dy += z.iy * d;
    cap = Math.min(cap, 170);
  }
  return [dx, dy, cap];
}

// Плавно ведёт смещение машины к нужному; возвращает ограничение скорости
export function worksSteer(st, c, x, y, dt) {
  const [dx, dy, cap] = worksShift(st, x, y, c.a, c.W);
  const k = Math.min(1, dt * 2.5);
  c.wx = (c.wx || 0) + (dx - (c.wx || 0)) * k;
  c.wy = (c.wy || 0) + (dy - (c.wy || 0)) * k;
  return cap;
}
