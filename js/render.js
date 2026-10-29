// Кадр: земля из чанков -> машины -> ночная маска со светом -> здания в перспективе -> огни.
import * as W from './world.js';
import { CS, peekChunk, buildChunkAt, nextTick } from './chunks.js';
import { S, drawCarSprite, LIGHT_RGB } from './sprites.js';
import { hashU } from './util.js';

const AMBIENT = 'rgba(3,5,18,0.87)';
const LIGHT_SCALE = 0.5;

let lightCv, lightG;

export function setupLights(w, h) {
  lightCv = document.createElement('canvas');
  lightCv.width = Math.ceil(w * LIGHT_SCALE);
  lightCv.height = Math.ceil(h * LIGHT_SCALE);
  lightG = lightCv.getContext('2d');
}

// Видимая область мира с запасом
function viewRect(cam, Wd, Ht, pad) {
  const hw = Wd / 2 / cam.z, hh = Ht / 2 / cam.z;
  return { x0: cam.x - hw - pad, y0: cam.y - hh - pad, x1: cam.x + hw + pad, y1: cam.y + hh + pad };
}

export function ensureChunks(cam, Wd, Ht, budget, ahead) {
  const v = viewRect(cam, Wd, Ht, 64);
  const cx0 = Math.floor(Math.min(v.x0, v.x0 + ahead.x) / CS), cx1 = Math.floor(Math.max(v.x1, v.x1 + ahead.x) / CS);
  const cy0 = Math.floor(Math.min(v.y0, v.y0 + ahead.y) / CS), cy1 = Math.floor(Math.max(v.y1, v.y1 + ahead.y) / CS);
  const need = [];
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    if (!peekChunk(cx, cy)) {
      const ccx = (cx + 0.5) * CS, ccy = (cy + 0.5) * CS;
      const inView = ccx > v.x0 - CS / 2 && ccx < v.x1 + CS / 2 && ccy > v.y0 - CS / 2 && ccy < v.y1 + CS / 2;
      need.push([cx, cy, (inView ? 0 : 1e9) + Math.hypot(ccx - cam.x, ccy - cam.y)]);
    }
  }
  need.sort((a, b) => a[2] - b[2]);
  for (let k = 0; k < Math.min(budget, need.length); k++) buildChunkAt(need[k][0], need[k][1]);
  return need.length;
}

export function drawFrame(ctx, st) {
  const { cam, W: Wd, H: Ht, time } = st;
  nextTick();
  const z = cam.z;
  const toScreen = () => ctx.setTransform(z, 0, 0, z, Wd / 2 - cam.x * z, Ht / 2 - cam.y * z);

  // ---------- земля
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#121418';
  ctx.fillRect(0, 0, Wd, Ht);
  toScreen();
  const v = viewRect(cam, Wd, Ht, 0);
  const chunks = [];
  for (let cx = Math.floor(v.x0 / CS); cx <= Math.floor(v.x1 / CS); cx++) {
    for (let cy = Math.floor(v.y0 / CS); cy <= Math.floor(v.y1 / CS); cy++) {
      const ch = peekChunk(cx, cy);
      if (ch) { ctx.drawImage(ch.canvas, cx * CS, cy * CS, CS + 0.6 / z, CS + 0.6 / z); chunks.push(ch); }
    }
  }
  // следы шин
  ctx.strokeStyle = 'rgba(10,10,10,0.55)';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  for (const s of st.skids) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
  ctx.stroke();

  // ---------- машины, пешеходы, поезда
  for (const t of st.trains) drawTrain(ctx, t);
  for (const p of st.peds) drawPed(ctx, p, time);
  for (const c of st.traffic) drawCarSprite(ctx, c.spr, c.x, c.y, c.a);
  const P = st.player;
  drawCarSprite(ctx, S.player, P.x, P.y, P.a);

  // ---------- ночная маска
  const ls = LIGHT_SCALE;
  lightG.setTransform(1, 0, 0, 1, 0, 0);
  lightG.globalCompositeOperation = 'source-over';
  lightG.clearRect(0, 0, lightCv.width, lightCv.height);
  lightG.fillStyle = AMBIENT;
  lightG.fillRect(0, 0, lightCv.width, lightCv.height);
  lightG.globalCompositeOperation = 'destination-out';
  lightG.setTransform(z * ls, 0, 0, z * ls, (Wd / 2 - cam.x * z) * ls, (Ht / 2 - cam.y * z) * ls);
  const pad = 300;
  const vis = (x, y, r) => x + r > v.x0 - pad && x - r < v.x1 + pad && y + r > v.y0 - pad && y - r < v.y1 + pad;
  const lamps = [];
  for (const ch of chunks) for (const l of ch.lamps) if (vis(l.lx, l.ly, l.r)) lamps.push(l);
  // чанки за краем экрана тоже светят внутрь
  for (const ch of neighbourChunks(v)) for (const l of ch.lamps) if (vis(l.lx, l.ly, l.r)) lamps.push(l);
  for (const l of lamps) {
    const k = blinkK(l, time) * l.i;
    if (k <= 0) continue;
    lightG.globalAlpha = Math.min(1, k * 0.95);
    lightG.drawImage(S.mask, l.lx - l.r, l.ly - l.r, l.r * 2, l.r * 2);
  }
  // фары
  const cars = [P, ...st.traffic];
  for (const c of cars) {
    if (!vis(c.x, c.y, 300)) continue;
    const L = c.spr ? c.spr.L : S.player.L;
    lightG.save();
    lightG.translate(c.x, c.y); lightG.rotate(c.a);
    lightG.globalAlpha = c === P ? 0.95 : 0.7;
    const len = c === P ? 300 : 230;
    lightG.drawImage(S.coneMask, L / 2 - 4, -len * 0.36, len, len * 0.72);
    lightG.globalAlpha = 0.5;
    lightG.drawImage(S.mask, -L / 2 - 24, -24, 48, 48);
    lightG.restore();
  }
  for (const t of st.trains) {
    if (!vis(t.x, t.hy, 400)) continue;
    lightG.globalAlpha = 0.9;
    lightG.save(); lightG.translate(t.x, t.hy); lightG.rotate(t.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    lightG.drawImage(S.coneMask, 0, -110, 340, 220);
    lightG.restore();
    lightG.globalAlpha = 0.5;
    for (let k = 0; k < t.cars; k++) {
      const cy = t.y0 + (k + 0.5) * t.carL;
      lightG.drawImage(S.mask, t.x - 60, cy - 60, 120, 120);
    }
  }
  for (const p of st.particles) if (p.light) { lightG.globalAlpha = Math.min(1, p.life * 2); lightG.drawImage(S.mask, p.x - 30, p.y - 30, 60, 60); }
  lightG.globalAlpha = 1;
  lightG.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(lightCv, 0, 0, Wd, Ht);

  // ---------- цветное свечение (аддитивно)
  toScreen();
  ctx.globalCompositeOperation = 'lighter';
  for (const l of lamps) {
    const k = blinkK(l, time) * l.i;
    if (k <= 0) continue;
    const spr = S.glow[l.c] || S.glow.white;
    ctx.globalAlpha = Math.min(1, k * (l.c === 'sodium' ? 0.24 : l.c === 'white' ? 0.13 : 0.26));
    const rr = l.r * 0.95;
    ctx.drawImage(spr, l.lx - rr, l.ly - rr, rr * 2, rr * 2);
    if (l.pole) { ctx.globalAlpha = 0.9; ctx.drawImage(S.dot[l.c] || S.dot.white, l.lx - 6, l.ly - 6, 12, 12); }
  }
  // отражения на воде
  for (const l of lamps) {
    if (l.r < 100 || W.riverDist(l.lx, l.ly + 30) > 30) continue;
    const spr = S.glow[l.c] || S.glow.white;
    ctx.globalAlpha = 0.18 + 0.08 * Math.sin(time * 3 + l.lx);
    ctx.drawImage(spr, l.lx - 10, l.ly + 10, 20, 90);
  }
  for (const c of cars) {
    if (!vis(c.x, c.y, 300)) continue;
    const L = c.spr ? c.spr.L : S.player.L;
    const Wc = c.spr ? c.spr.W : S.player.W;
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.a);
    ctx.globalAlpha = c === P ? 0.22 : 0.15;
    const len = c === P ? 300 : 230;
    ctx.drawImage(S.coneGlow, L / 2 - 4, -len * 0.36, len, len * 0.72);
    ctx.globalAlpha = 1;
    for (const s of [-1, 1]) ctx.drawImage(S.dot.white, L / 2 - 8, s * (Wc / 2 - 4) - 8, 16, 16);
    const brake = c.brake ? 1 : 0.45;
    ctx.globalAlpha = brake;
    for (const s of [-1, 1]) ctx.drawImage(S.dot.red, -L / 2 - 9, s * (Wc / 2 - 4) - 9, 18, 18);
    if (c.brake) { ctx.globalAlpha = 0.35; ctx.drawImage(S.glow.red, -L / 2 - 40, -40, 80, 80); }
    if (c.reverse) { ctx.globalAlpha = 0.8; for (const s of [-1, 1]) ctx.drawImage(S.dot.white, -L / 2 - 7, s * (Wc / 2 - 7) - 7, 14, 14); }
    if (c.police) {
      const ph = Math.sin(time * 14) > 0;
      ctx.globalAlpha = 0.8;
      ctx.drawImage(ph ? S.glow.red : S.glow.blue, -60, -60, 120, 120);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  for (const p of st.particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
    const spr = S.dot[p.c] || S.dot.yellow;
    ctx.drawImage(spr, p.x - p.s, p.y - p.s, p.s * 2, p.s * 2);
  }
  // светофоры
  drawSignals(ctx, st, v, time);
  for (const t of st.trains) {
    ctx.globalAlpha = 1;
    for (const s of [-8, 8]) ctx.drawImage(S.dot.white, t.x + s - 8, t.hy - 8, 16, 16);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // ---------- здания
  drawBuildings(ctx, st, v);

  // ---------- верхний слой: дым
  toScreen();
  for (const p of st.smoke) {
    ctx.globalAlpha = Math.max(0, p.life * 0.25);
    ctx.fillStyle = '#9aa0a8';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function neighbourChunks(v) {
  const out = [];
  const cx0 = Math.floor((v.x0 - 200) / CS), cx1 = Math.floor((v.x1 + 200) / CS);
  const cy0 = Math.floor((v.y0 - 200) / CS), cy1 = Math.floor((v.y1 + 200) / CS);
  const ix0 = Math.floor(v.x0 / CS), ix1 = Math.floor(v.x1 / CS), iy0 = Math.floor(v.y0 / CS), iy1 = Math.floor(v.y1 / CS);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    if (cx >= ix0 && cx <= ix1 && cy >= iy0 && cy <= iy1) continue;
    const ch = peekChunk(cx, cy);
    if (ch) out.push(ch);
  }
  return out;
}

function blinkK(l, t) {
  if (!l.blink) return 1;
  return Math.sin(t * 4 + l.x * 0.1) > 0.2 ? 1 : 0.1;
}

// ---------------------------------------------------------------- светофоры
export function signalState(i, j, t) {
  // 0 — зелёный по горизонтали, 1 — жёлтый гориз., 2 — зелёный по вертикали, 3 — жёлтый верт.
  const off = (hashU(i, j, 707) % 1000) / 1000 * 16;
  const p = (t + off) % 16;
  return p < 6.5 ? 0 : p < 8 ? 1 : p < 14.5 ? 2 : 3;
}

function drawSignals(ctx, st, v, time) {
  const i0 = W.colAt(v.x0), i1 = W.colAt(v.x1) + 1, j0 = W.rowAt(v.y0), j1 = W.rowAt(v.y1) + 1;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const x = W.roadX(i), y = W.roadY(j);
    const hw = W.widthX(i) / 2, hh = W.widthY(j) / 2;
    const s = signalState(i, j, time);
    const hc = s === 0 ? 'green' : s === 1 ? 'yellow' : 'red';
    const vc = s === 2 ? 'green' : s === 3 ? 'yellow' : 'red';
    // сигнал для едущих по горизонтали стоит на правом углу перед перекрёстком
    const pts = [
      [x - hw - 6, y + hh + 6, hc], [x + hw + 6, y - hh - 6, hc],
      [x - hw - 6, y - hh - 6, vc], [x + hw + 6, y + hh + 6, vc],
    ];
    for (const [px, py, c] of pts) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(S.glow[c], px - 22, py - 22, 44, 44);
      ctx.globalAlpha = 1;
      ctx.drawImage(S.dot[c], px - 5, py - 5, 10, 10);
    }
  }
}

// ---------------------------------------------------------------- пешеходы и поезда
const PED_COLS = ['#c84a3a', '#3a6ac8', '#d8d8d8', '#2a2a2a', '#8a6a3a', '#3a8a5a', '#a03a8a', '#c8a03a'];
function drawPed(ctx, p, time) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.a);
  if (p.down > 0) {
    ctx.fillStyle = PED_COLS[p.col];
    ctx.fillRect(-9, -4, 16, 8);
    ctx.fillStyle = '#d8b090'; ctx.beginPath(); ctx.arc(9, 0, 3.4, 0, 6.29); ctx.fill();
  } else {
    const sw = Math.sin(p.phase) * 4;
    ctx.fillStyle = '#222';
    ctx.fillRect(sw - 2, -4.5, 5, 3); ctx.fillRect(-sw - 2, 1.5, 5, 3);
    ctx.fillStyle = PED_COLS[p.col];
    ctx.beginPath(); ctx.ellipse(0, 0, 3.6, 6.5, 0, 0, 6.29); ctx.fill();
    ctx.fillStyle = p.hair;
    ctx.beginPath(); ctx.arc(0.5, 0, 3.2, 0, 6.29); ctx.fill();
  }
  ctx.restore();
}

function drawTrain(ctx, t) {
  for (let k = 0; k < t.cars; k++) {
    const y = t.y0 + k * t.carL;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(t.x - 13 + 4, y + 6, 26, t.carL - 4);
    ctx.fillStyle = k === 0 || k === t.cars - 1 ? '#b83a2a' : '#5a6a7a';
    ctx.fillRect(t.x - 13, y + 2, 26, t.carL - 4);
    ctx.fillStyle = '#8a96a2';
    ctx.fillRect(t.x - 10, y + 6, 20, t.carL - 12);
    ctx.fillStyle = '#4a545e';
    for (let u = y + 12; u < y + t.carL - 12; u += 22) ctx.fillRect(t.x - 6, u, 12, 6);
  }
}

// ---------------------------------------------------------------- здания с перспективой
export function cameraHeight(cam, Ht) { return 1.6 * (Ht / cam.z); }

function drawBuildings(ctx, st, v) {
  const { cam, W: Wd, H: Ht, time } = st;
  const z = cam.z;
  const Hc = cameraHeight(cam, Ht);
  const m = 500;
  const i0 = W.colAt(v.x0 - m), i1 = W.colAt(v.x1 + m), j0 = W.rowAt(v.y0 - m), j1 = W.rowAt(v.y1 + m);
  const list = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const B = W.getBlock(i, j);
    for (const b of B.buildings) {
      const h = Math.min(b.height, Hc * 0.7);
      const f = Hc / (Hc - h);
      // проекция крыши
      const rx0 = cam.x + (b.x - cam.x) * f, rx1 = cam.x + (b.x + b.w - cam.x) * f;
      const ry0 = cam.y + (b.y - cam.y) * f, ry1 = cam.y + (b.y + b.h - cam.y) * f;
      const minx = Math.min(b.x, rx0), maxx = Math.max(b.x + b.w, rx1);
      const miny = Math.min(b.y, ry0), maxy = Math.max(b.y + b.h, ry1);
      if (maxx < v.x0 || minx > v.x1 || maxy < v.y0 || miny > v.y1) continue;
      list.push([h, b, f]);
    }
  }
  list.sort((a, b) => a[0] - b[0]);
  const cx = Wd / 2, cy = Ht / 2;
  const sx = (x) => (x - cam.x) * z + cx, sy = (y) => (y - cam.y) * z + cy;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const winPaths = { warm: [], cool: [], tv: [] };
  for (const [h, b, f] of list) {
    if (b.crane) { drawCrane(ctx, st, b, f, sx, sy); continue; }
    if (b.cyl) { drawCylinder(ctx, st, b, f); continue; }
    const xs = [b.x, b.x + b.w, b.x + b.w, b.x], ys = [b.y, b.y, b.y + b.h, b.y + b.h];
    const B = [], R = [];
    for (let k = 0; k < 4; k++) {
      B.push([sx(xs[k]), sy(ys[k])]);
      R.push([(xs[k] - cam.x) * z * f + cx, (ys[k] - cam.y) * z * f + cy]);
    }
    // стены, обращённые к камере
    const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) & 3;
      const n = normals[k];
      const mx = (xs[k] + xs[k2]) / 2, my = (ys[k] + ys[k2]) / 2;
      if (n[0] * (mx - cam.x) + n[1] * (my - cam.y) >= 0) continue;
      if (b.skeleton) { drawSkeletonFace(ctx, B[k], B[k2], R[k], R[k2], b); continue; }
      ctx.fillStyle = b.wall;
      ctx.beginPath();
      ctx.moveTo(B[k][0], B[k][1]); ctx.lineTo(B[k2][0], B[k2][1]); ctx.lineTo(R[k2][0], R[k2][1]); ctx.lineTo(R[k][0], R[k][1]);
      ctx.closePath(); ctx.fill();
      // лёгкая подсветка граней с одной стороны
      if (k === 1 || k === 2) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fill(); }
      if (b.lit > 0) addWindows(winPaths, B[k], B[k2], R[k], R[k2], b, k, time);
    }
    flushWindows(ctx, winPaths);
    // крыша
    if (b.skeleton) { drawSkeletonRoof(ctx, R, b, cam, z, f, cx, cy); continue; }
    ctx.beginPath();
    ctx.moveTo(R[0][0], R[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(R[k][0], R[k][1]); ctx.closePath();
    ctx.fillStyle = b.roof; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();
    const zf = z * f;
    ctx.setTransform(zf, 0, 0, zf, cx - cam.x * zf, cy - cam.y * zf);
    if (b.gable) drawGable(ctx, b);
    drawDetails(ctx, b);
    if (b.crown) {
      ctx.globalCompositeOperation = 'lighter';
      const rgb = LIGHT_RGB[b.crown];
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.9)`;
      ctx.lineWidth = 2.2;
      ctx.strokeRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.25)`;
      ctx.lineWidth = 8;
      ctx.strokeRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (b.glows.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const gl of b.glows) {
        if (gl.blink && Math.sin(time * gl.blink * 3.14 + b.seed) < 0.3) continue;
        ctx.globalAlpha = gl.i;
        ctx.drawImage(S.glow[gl.c], gl.x - gl.r, gl.y - gl.r, gl.r * 2, gl.r * 2);
        if (gl.c === 'red') ctx.drawImage(S.dot.red, gl.x - 4, gl.y - 4, 8, 8);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

function addWindows(paths, b0, b1, r0, r1, b, face, time) {
  const hpx = Math.hypot(r0[0] - b0[0], r0[1] - b0[1]);
  if (hpx < 4) return;
  const len = face % 2 === 0 ? b.w : b.h;
  let rows = Math.max(1, Math.round(b.height / b.floorH));
  let cols = Math.max(1, Math.round(len / 15));
  rows = Math.min(rows, Math.floor(hpx / 3), 30);
  cols = Math.min(cols, 18);
  if (rows < 1) return;
  const wpx = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
  if (wpx / cols < 2.5) cols = Math.max(1, Math.floor(wpx / 2.5));
  const seed = b.seed + face * 7919;
  for (let r = 0; r < rows; r++) {
    const floorOn = b.floorMode ? (hashU(seed, r, 1) % 100) / 100 < b.lit * 1.3 : true;
    if (!floorOn) continue;
    const t0 = (r + 0.22) / rows, t1 = (r + 0.72) / rows;
    for (let c = 0; c < cols; c++) {
      const hv = hashU(seed, r, c + 3);
      const lit = (hv % 1000) / 1000 < (b.floorMode ? 0.8 : b.lit);
      if (!lit) continue;
      const kind = (hv >>> 12) % 20;
      const p = kind < 14 ? paths.warm : kind < 18 ? paths.cool : paths.tv;
      if (kind >= 18 && ((time * 2 + c) | 0) % 3 === 0) continue;
      const s0 = (c + 0.2) / cols, s1 = (c + 0.8) / cols;
      p.push(bil(b0, b1, r0, r1, s0, t0), bil(b0, b1, r0, r1, s1, t0), bil(b0, b1, r0, r1, s1, t1), bil(b0, b1, r0, r1, s0, t1));
    }
  }
}
function bil(b0, b1, r0, r1, s, t) {
  const ax = b0[0] + (b1[0] - b0[0]) * s, ay = b0[1] + (b1[1] - b0[1]) * s;
  const bx = r0[0] + (r1[0] - r0[0]) * s, by = r0[1] + (r1[1] - r0[1]) * s;
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}
const WIN_COL = { warm: '#ffcf7a', cool: '#bfe0ff', tv: '#6a8cff' };
function flushWindows(ctx, paths) {
  for (const k in paths) {
    const p = paths[k];
    if (!p.length) continue;
    ctx.fillStyle = WIN_COL[k];
    ctx.beginPath();
    for (let n = 0; n < p.length; n += 4) {
      ctx.moveTo(p[n][0], p[n][1]); ctx.lineTo(p[n + 1][0], p[n + 1][1]); ctx.lineTo(p[n + 2][0], p[n + 2][1]); ctx.lineTo(p[n + 3][0], p[n + 3][1]);
    }
    ctx.fill();
    p.length = 0;
  }
}

function drawGable(ctx, b) {
  const long = b.w > b.h;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  if (long) ctx.fillRect(b.x, b.cy, b.w, b.h / 2); else ctx.fillRect(b.cx, b.y, b.w / 2, b.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  if (long) { ctx.moveTo(b.x + 2, b.cy); ctx.lineTo(b.x + b.w - 2, b.cy); } else { ctx.moveTo(b.cx, b.y + 2); ctx.lineTo(b.cx, b.y + b.h - 2); }
  ctx.stroke();
}

function drawDetails(ctx, b) {
  for (const d of b.details) {
    switch (d.t) {
      case 'r': ctx.fillStyle = d.c; ctx.fillRect(d.x, d.y, d.w, d.h); break;
      case 'rs': ctx.strokeStyle = d.c; ctx.lineWidth = d.lw || 1; ctx.strokeRect(d.x, d.y, d.w, d.h); break;
      case 'c': ctx.fillStyle = d.c; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill(); break;
      case 'H':
        ctx.strokeStyle = '#e8d24a'; ctx.lineWidth = d.s * 0.22;
        ctx.beginPath();
        ctx.moveTo(d.x - d.s * 0.5, d.y - d.s * 0.6); ctx.lineTo(d.x - d.s * 0.5, d.y + d.s * 0.6);
        ctx.moveTo(d.x + d.s * 0.5, d.y - d.s * 0.6); ctx.lineTo(d.x + d.s * 0.5, d.y + d.s * 0.6);
        ctx.moveTo(d.x - d.s * 0.5, d.y); ctx.lineTo(d.x + d.s * 0.5, d.y);
        ctx.stroke();
        break;
      case 'cross':
        ctx.strokeStyle = '#f0d27a'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(d.x, d.y - d.s); ctx.lineTo(d.x, d.y + d.s); ctx.moveTo(d.x - d.s * 0.5, d.y - d.s * 0.4); ctx.lineTo(d.x + d.s * 0.5, d.y - d.s * 0.4); ctx.stroke();
        break;
      case 'ant':
        ctx.strokeStyle = '#7a7c80'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(d.x - 6, d.y); ctx.lineTo(d.x + 6, d.y); ctx.moveTo(d.x, d.y - 6); ctx.lineTo(d.x, d.y + 6); ctx.stroke();
        break;
    }
  }
}

function drawSkeletonFace(ctx, b0, b1, r0, r1, b) {
  const floors = Math.max(1, Math.round(b.height / b.floorH));
  ctx.strokeStyle = '#7a7a76';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const cols = Math.max(2, Math.round((Math.hypot(b1[0] - b0[0], b1[1] - b0[1])) / 18));
  for (let c = 0; c <= cols; c++) {
    const p = bil(b0, b1, r0, r1, c / cols, 0), q = bil(b0, b1, r0, r1, c / cols, 1);
    ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
  }
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#8c8c86';
  ctx.beginPath();
  for (let r = 1; r <= floors; r++) {
    const p = bil(b0, b1, r0, r1, 0, r / floors), q = bil(b0, b1, r0, r1, 1, r / floors);
    ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
  }
  ctx.stroke();
}
function drawSkeletonRoof(ctx, R, b, cam, z, f, cx, cy) {
  // верхнее перекрытие недостроено: половина плиты и арматура
  ctx.fillStyle = '#5c5c58';
  ctx.beginPath();
  ctx.moveTo(R[0][0], R[0][1]); ctx.lineTo(R[1][0], R[1][1]);
  ctx.lineTo((R[1][0] + R[2][0]) / 2, (R[1][1] + R[2][1]) / 2); ctx.lineTo((R[0][0] + R[3][0]) / 2, (R[0][1] + R[3][1]) / 2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#8a8a84'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(R[0][0], R[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(R[k][0], R[k][1]); ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#9a9a92';
  for (let s = 0; s <= 4; s++) for (let t = 2; t <= 4; t++) {
    const p = bil(R[3], R[2], R[0], R[1], s / 4, t / 4);
    ctx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
  }
}

function drawCylinder(ctx, st, b, f) {
  const { cam, W: Wd, H: Ht } = st;
  const z = cam.z, cx = Wd / 2, cy = Ht / 2;
  const bx = (b.cx - cam.x) * z + cx, by = (b.cy - cam.y) * z + cy;
  const tx = (b.cx - cam.x) * z * f + cx, ty = (b.cy - cam.y) * z * f + cy;
  const rb = (b.w / 2) * z, rt = (b.w / 2) * z * f * 0.8;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = b.wall;
  const a = Math.atan2(ty - by, tx - bx) + Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(bx + Math.cos(a) * rb, by + Math.sin(a) * rb);
  ctx.lineTo(tx + Math.cos(a) * rt, ty + Math.sin(a) * rt);
  ctx.lineTo(tx - Math.cos(a) * rt, ty - Math.sin(a) * rt);
  ctx.lineTo(bx - Math.cos(a) * rb, by - Math.sin(a) * rb);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(bx, by, rb, 0, Math.PI * 2); ctx.fill();
  // красно-белые полосы
  ctx.strokeStyle = 'rgba(160,40,30,0.8)';
  ctx.lineWidth = rb * 1.6;
  for (const t of [0.7, 0.85]) {
    ctx.beginPath();
    ctx.moveTo(bx + (tx - bx) * t, by + (ty - by) * t);
    ctx.lineTo(bx + (tx - bx) * (t + 0.06), by + (ty - by) * (t + 0.06));
    ctx.stroke();
  }
  ctx.fillStyle = b.roof;
  ctx.beginPath(); ctx.arc(tx, ty, rt, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0c0c0c';
  ctx.beginPath(); ctx.arc(tx, ty, rt * 0.6, 0, Math.PI * 2); ctx.fill();
  const zf = z * f;
  ctx.setTransform(zf, 0, 0, zf, cx - cam.x * zf, cy - cam.y * zf);
  ctx.globalCompositeOperation = 'lighter';
  for (const gl of b.glows) {
    if (gl.blink && Math.sin(st.time * gl.blink * 3.14 + b.seed) < 0.3) continue;
    ctx.drawImage(S.glow[gl.c], gl.x - gl.r, gl.y - gl.r, gl.r * 2, gl.r * 2);
    ctx.drawImage(S.dot.red, gl.x - 4, gl.y - 4, 8, 8);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // дым из трубы
  if (Math.random() < 0.15) st.smoke.push({ x: b.cx + (b.cx - cam.x) * (f - 1), y: b.cy + (b.cy - cam.y) * (f - 1), vx: 12 + Math.random() * 8, vy: -4 + Math.random() * 8, s: 10, life: 3 });
}

function drawCrane(ctx, st, b, f, sx, sy) {
  const { cam, W: Wd, H: Ht, time } = st;
  const z = cam.z, cx = Wd / 2, cy = Ht / 2;
  const bx = sx(b.cx), by = sy(b.cy);
  const tx = (b.cx - cam.x) * z * f + cx, ty = (b.cy - cam.y) * z * f + cy;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // мачта-решётка
  const a = Math.atan2(ty - by, tx - bx) + Math.PI / 2;
  const w0 = 7 * z, w1 = 7 * z * f;
  ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 1.5;
  const L0 = [bx + Math.cos(a) * w0, by + Math.sin(a) * w0], R0 = [bx - Math.cos(a) * w0, by - Math.sin(a) * w0];
  const L1 = [tx + Math.cos(a) * w1, ty + Math.sin(a) * w1], R1 = [tx - Math.cos(a) * w1, ty - Math.sin(a) * w1];
  ctx.beginPath();
  ctx.moveTo(L0[0], L0[1]); ctx.lineTo(L1[0], L1[1]); ctx.moveTo(R0[0], R0[1]); ctx.lineTo(R1[0], R1[1]);
  const n = 12;
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    const p = k % 2 ? [L0, R0, L1, R1] : [R0, L0, R1, L1];
    ctx.moveTo(p[0][0] + (p[2][0] - p[0][0]) * t0, p[0][1] + (p[2][1] - p[0][1]) * t0);
    ctx.lineTo(p[1][0] + (p[3][0] - p[1][0]) * t1, p[1][1] + (p[3][1] - p[1][1]) * t1);
  }
  ctx.stroke();
  // стрела на высоте крыши
  const zf = z * f;
  ctx.setTransform(zf, 0, 0, zf, cx - cam.x * zf, cy - cam.y * zf);
  const c = b.crane;
  const ang = c.a0 + time * c.speed;
  ctx.save();
  ctx.translate(b.cx, b.cy); ctx.rotate(ang);
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.strokeStyle = '#d8b030'; ctx.lineWidth = 1.4;
  ctx.strokeRect(-c.back, -4, c.len + c.back, 8);
  ctx.beginPath();
  for (let x = -c.back; x < c.len; x += 10) { ctx.moveTo(x, -4); ctx.lineTo(x + 10, 4); }
  ctx.stroke();
  ctx.fillStyle = '#5a5a5a'; ctx.fillRect(-c.back, -9, 26, 18);
  ctx.fillStyle = '#c9a227'; ctx.fillRect(-8, -8, 16, 16);
  ctx.fillStyle = '#1a2430'; ctx.fillRect(2, -6, 6, 6);
  // трос и груз
  const hook = c.len * (0.45 + 0.25 * Math.sin(time * 0.2 + b.seed));
  ctx.fillStyle = '#8a6a3a'; ctx.fillRect(hook - 10, -10, 20, 20);
  ctx.globalCompositeOperation = 'lighter';
  if (Math.sin(time * 3 + b.seed) > 0) {
    ctx.drawImage(S.glow.red, c.len - 20, -20, 40, 40);
    ctx.drawImage(S.glow.red, -20, -20, 40, 40);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
