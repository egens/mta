import * as W from './world.js';
import { initSprites } from './sprites.js';
import { drawFrame, ensureChunks, setupLights } from './render.js';
import { createPlayer, updatePlayer, collideStatic, collideCars, MAX_SPEED } from './car.js';
import { updateTraffic, updatePeds, updateTrains } from './traffic.js';
import { clamp, lerp } from './util.js';

const cv = document.getElementById('game');
const ctx = cv.getContext('2d', { alpha: false });
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');
const hudSpeed = document.getElementById('speed');
const hudDistrict = document.getElementById('district');
const hudToast = document.getElementById('toast');
const hudLoad = document.getElementById('loading');
const hudStats = document.getElementById('stats');

initSprites();

let DPR = 1;
const st = {
  cam: { x: 0, y: 0, z: 1 }, W: 0, H: 0, time: 0, viewR: 1000,
  player: null, traffic: [], peds: [], trains: [], skids: [], smoke: [], particles: [],
  shake: 0, hits: 0, peds_hit: 0, dist: 0,
  onImpact(power, x, y, sparks) {
    if (power < 40) return;
    this.shake = Math.min(14, this.shake + power * 0.03);
    if (sparks) {
      const n = Math.min(24, (power / 15) | 0);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * power;
        this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.3 + Math.random() * 0.4, c: Math.random() < 0.5 ? 'yellow' : 'orange', s: 3 + Math.random() * 3, light: k < 2 });
      }
    }
    audio.thud(Math.min(1, power / 400));
    if (power > 120) this.hits++;
  },
  onPedHit(p) {
    this.peds_hit++;
    audio.thud(0.4);
    toast('Осторожнее на тротуаре!');
  },
};

// ---------------------------------------------------------------- старт на дороге
function findStart() {
  for (let r = 0; r < 12; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
    if (!W.vSegExists(i, j)) continue;
    const x = W.roadX(i) - 21, y = (W.roadY(j) + W.roadY(j + 1)) / 2;
    if (!W.isWater(x, y)) return [x, y];
  }
  return [W.roadX(0) - 21, W.roadY(0) + 300];
}
const [sx, sy] = findStart();
st.player = createPlayer(sx, sy, Math.PI / 2);
st.cam.x = sx; st.cam.y = sy;

function respawn() {
  const P = st.player;
  const i = W.colAt(P.x), j = W.rowAt(P.y);
  for (let r = 0; r < 8; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
    if (!W.vSegExists(i + di, j + dj)) continue;
    const x = W.roadX(i + di) - 21, y = (W.roadY(j + dj) + W.roadY(j + dj + 1)) / 2;
    if (W.isWater(x, y)) continue;
    P.x = x; P.y = y; P.a = Math.PI / 2; P.vx = P.vy = 0;
    return;
  }
}

// ---------------------------------------------------------------- размер
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  DPR = Math.min(dpr, Math.sqrt(3200000 / (w * h)));
  st.W = cv.width = Math.round(w * DPR);
  st.H = cv.height = Math.round(h * DPR);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  setupLights(st.W, st.H);
  const ms = Math.round(Math.min(200, Math.max(120, Math.min(w, h) * 0.26)));
  mini.width = mini.height = Math.round(ms * DPR);
  mini.style.width = mini.style.height = ms + 'px';
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- ввод
const keys = {};
const inp = { up: false, down: false, left: false, right: false, hand: false };
const touch = { up: false, down: false, left: false, right: false, hand: false };
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  audio.start();
  if (e.code === 'KeyH') document.getElementById('help').classList.toggle('hidden');
  if (e.code === 'KeyM') audio.toggle();
  if (e.code === 'KeyR') respawn();
  if (e.code === 'KeyE') audio.horn(true);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  hideIntro();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'KeyE') audio.horn(false); });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

for (const el of document.querySelectorAll('[data-k]')) {
  const k = el.dataset.k;
  const on = (e) => { e.preventDefault(); touch[k] = true; el.classList.add('on'); audio.start(); hideIntro(); };
  const off = (e) => { e.preventDefault(); touch[k] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
}
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch');
document.getElementById('intro').addEventListener('click', () => { audio.start(); hideIntro(); });
function hideIntro() { document.getElementById('intro').classList.add('hidden'); }

function readInput() {
  inp.up = keys.ArrowUp || keys.KeyW || touch.up;
  inp.down = keys.ArrowDown || keys.KeyS || touch.down;
  inp.left = keys.ArrowLeft || keys.KeyA || touch.left;
  inp.right = keys.ArrowRight || keys.KeyD || touch.right;
  inp.hand = keys.Space || touch.hand;
}

// ---------------------------------------------------------------- звук
const audio = (() => {
  let ac = null, osc, osc2, gain, filt, hornG, muted = false;
  return {
    start() {
      if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        osc = ac.createOscillator(); osc.type = 'sawtooth';
        osc2 = ac.createOscillator(); osc2.type = 'square';
        filt = ac.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 400;
        gain = ac.createGain(); gain.gain.value = 0;
        const g2 = ac.createGain(); g2.gain.value = 0.3;
        osc.connect(filt); osc2.connect(g2); g2.connect(filt); filt.connect(gain); gain.connect(ac.destination);
        osc.start(); osc2.start();
        const h1 = ac.createOscillator(), h2 = ac.createOscillator();
        h1.type = h2.type = 'square'; h1.frequency.value = 392; h2.frequency.value = 494;
        hornG = ac.createGain(); hornG.gain.value = 0;
        const hf = ac.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 1500;
        h1.connect(hf); h2.connect(hf); hf.connect(hornG); hornG.connect(ac.destination);
        h1.start(); h2.start();
      } catch (e) { ac = null; }
    },
    update(speed, throttle) {
      if (!ac) return;
      const rpm = 0.15 + (speed / MAX_SPEED) * 0.85;
      const gear = ((speed / MAX_SPEED) * 5) % 1;
      const f = 45 + rpm * 90 + gear * 40 + (throttle ? 12 : 0);
      osc.frequency.setTargetAtTime(f, ac.currentTime, 0.05);
      osc2.frequency.setTargetAtTime(f * 0.5, ac.currentTime, 0.05);
      filt.frequency.setTargetAtTime(300 + rpm * 900 + (throttle ? 300 : 0), ac.currentTime, 0.08);
      gain.gain.setTargetAtTime(muted ? 0 : 0.05 + rpm * 0.05 + (throttle ? 0.03 : 0), ac.currentTime, 0.1);
    },
    thud(k) {
      if (!ac || muted) return;
      const n = ac.createBufferSource();
      const len = (ac.sampleRate * 0.25) | 0;
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      n.buffer = buf;
      const g = ac.createGain(); g.gain.value = 0.25 + k * 0.5;
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600 + k * 1500;
      n.connect(f); f.connect(g); g.connect(ac.destination);
      n.start();
    },
    horn(on) { if (ac && hornG) hornG.gain.setTargetAtTime(on && !muted ? 0.08 : 0, ac.currentTime, 0.02); },
    toggle() { muted = !muted; toast(muted ? 'Звук выключен' : 'Звук включен'); },
  };
})();

// ---------------------------------------------------------------- HUD
let toastT = 0;
function toast(msg) { hudToast.textContent = msg; hudToast.classList.add('show'); toastT = 2.2; }
let lastDistrict = '';

function drawMinimap() {
  const s = mini.width;
  const P = st.player;
  const scale = 16 / DPR; // мировых единиц на пиксель
  const half = (s / 2) * scale;
  const m = mctx;
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.fillStyle = '#0a0d14';
  m.fillRect(0, 0, s, s);
  m.setTransform(1 / scale, 0, 0, 1 / scale, s / 2 - P.x / scale, s / 2 - P.y / scale);
  const x0 = P.x - half, x1 = P.x + half, y0 = P.y - half, y1 = P.y + half;
  // кварталы
  for (let i = W.colAt(x0); i <= W.colAt(x1); i++) for (let j = W.rowAt(y0); j <= W.rowAt(y1); j++) {
    const B = W.getBlock(i, j);
    m.fillStyle = B.type === 'park' || B.type === 'riverside' ? '#1d3a1e' : B.type === 'industrial' ? '#2a2620' : B.type === 'construction' ? '#3a2e1c' : '#1a1d26';
    m.fillRect(B.x0, B.y0, B.x1 - B.x0, B.y1 - B.y0);
    for (const p of B.ponds) { m.fillStyle = '#1a4a6a'; m.beginPath(); m.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, 6.29); m.fill(); }
  }
  // реки
  for (let mm = Math.floor((y0 - 1500) / W.RP); mm <= Math.floor((y1 + 1500) / W.RP); mm++) {
    if (!W.riverExists(mm)) continue;
    m.beginPath();
    for (let x = x0 - 50; x <= x1 + 50; x += 60) m.lineTo(x, W.riverY(mm, x) - W.riverHW(mm, x));
    for (let x = x1 + 50; x >= x0 - 50; x -= 60) m.lineTo(x, W.riverY(mm, x) + W.riverHW(mm, x));
    m.closePath(); m.fillStyle = '#1a4a6a'; m.fill();
  }
  // ж/д
  m.strokeStyle = '#6a5a4a'; m.lineWidth = 30; m.setLineDash([80, 60]);
  for (const i of W.railsInRange(x0, x1)) { m.beginPath(); m.moveTo(W.railX(i), y0); m.lineTo(W.railX(i), y1); m.stroke(); }
  m.setLineDash([]);
  // диагонали
  m.strokeStyle = '#7a7c84'; m.lineWidth = W.DIAG_W;
  for (const d of W.diagsInRect(x0, y0, x1, y1, 100)) {
    const [dx, dy] = W.diagDir(d), [ox, oy] = W.diagOrigin(d);
    const t = (P.x - ox) * dx + (P.y - oy) * dy;
    m.beginPath(); m.moveTo(ox + dx * (t - half * 1.5), oy + dy * (t - half * 1.5)); m.lineTo(ox + dx * (t + half * 1.5), oy + dy * (t + half * 1.5)); m.stroke();
  }
  // улицы
  for (let i = W.colAt(x0); i <= W.colAt(x1) + 1; i++) {
    m.fillStyle = W.aveX(i) ? '#8a8c94' : '#55585f';
    const w = Math.max(W.widthX(i), 3 * scale);
    m.fillRect(W.roadX(i) - w / 2, y0, w, y1 - y0);
  }
  for (let j = W.rowAt(y0); j <= W.rowAt(y1) + 1; j++) {
    m.fillStyle = W.aveY(j) ? '#8a8c94' : '#55585f';
    const w = Math.max(W.widthY(j), 3 * scale);
    m.fillRect(x0, W.roadY(j) - w / 2, x1 - x0, w);
  }
  // реки поверх улиц (кроме мостов) — достаточно перерисовать воду с прозрачностью
  for (let mm = Math.floor((y0 - 1500) / W.RP); mm <= Math.floor((y1 + 1500) / W.RP); mm++) {
    if (!W.riverExists(mm)) continue;
    m.beginPath();
    for (let x = x0 - 50; x <= x1 + 50; x += 60) m.lineTo(x, W.riverY(mm, x) - W.riverHW(mm, x));
    for (let x = x1 + 50; x >= x0 - 50; x -= 60) m.lineTo(x, W.riverY(mm, x) + W.riverHW(mm, x));
    m.closePath(); m.fillStyle = 'rgba(26,74,106,0.75)'; m.fill();
  }
  // машины
  m.fillStyle = '#e8d070';
  for (const c of st.traffic) m.fillRect(c.x - 25, c.y - 25, 50, 50);
  // игрок
  m.save(); m.translate(P.x, P.y); m.rotate(P.a);
  m.fillStyle = '#ff3b3b';
  m.beginPath(); m.moveTo(110, 0); m.lineTo(-70, -70); m.lineTo(-40, 0); m.lineTo(-70, 70); m.closePath(); m.fill();
  m.restore();
}

// ---------------------------------------------------------------- цикл
let last = performance.now();
let frame = 0;
let fpsT = 0, fpsN = 0, fps = 60;
const showStats = /stats/.test(location.search);

function step(dt) {
  const P = st.player;
  updatePlayer(P, inp, dt, st);
  collideStatic(P, st, true);
  collideCars(P, st.traffic, st);
  updateTraffic(st, dt);
  updatePeds(st, dt);
}

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  st.time += dt;
  frame++;
  readInput();
  const P = st.player;
  const n = dt > 0.022 ? 2 : 1;
  for (let k = 0; k < n; k++) step(dt / n);
  updateTrains(st);
  const speed = Math.hypot(P.vx, P.vy);
  st.dist += speed * dt;

  // камера
  const minDim = Math.min(st.W, st.H);
  const viewMin = lerp(820, 1350, clamp(speed / MAX_SPEED, 0, 1));
  const zt = minDim / viewMin;
  st.cam.z += (zt - st.cam.z) * Math.min(1, dt * 1.5);
  const lx = P.x + P.vx * 0.45, ly = P.y + P.vy * 0.45;
  st.cam.x += (lx - st.cam.x) * Math.min(1, dt * 4);
  st.cam.y += (ly - st.cam.y) * Math.min(1, dt * 4);
  st.viewR = Math.hypot(st.W, st.H) / 2 / st.cam.z;
  const camDraw = { ...st.cam };
  if (st.shake > 0.1) {
    camDraw.x += (Math.random() - 0.5) * st.shake * 2;
    camDraw.y += (Math.random() - 0.5) * st.shake * 2;
    st.shake *= Math.exp(-dt * 8);
  }

  // частицы
  for (const p of st.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94; p.life -= dt; }
  st.particles = st.particles.filter((p) => p.life > 0);
  for (const p of st.smoke) { p.x += p.vx * dt; p.y += p.vy * dt; p.s += dt * 14; p.life -= dt; }
  st.smoke = st.smoke.filter((p) => p.life > 0);
  if (st.smoke.length > 300) st.smoke.splice(0, st.smoke.length - 300);

  // подгрузка чанков: первые кадры — без ограничений
  const pending = ensureChunks(st.cam, st.W, st.H, frame < 3 ? 200 : 3, { x: P.vx * 0.8, y: P.vy * 0.8 });
  hudLoad.classList.toggle('hidden', frame > 2);

  drawFrame(ctx, { ...st, cam: camDraw });

  // HUD
  const kmh = Math.round((speed / 10) * 3.6);
  hudSpeed.textContent = kmh;
  const dname = W.districtAt(P.x, P.y);
  if (dname !== lastDistrict) {
    lastDistrict = dname;
    hudDistrict.textContent = dname;
    hudDistrict.classList.remove('flash'); void hudDistrict.offsetWidth; hudDistrict.classList.add('flash');
  }
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) hudToast.classList.remove('show'); }
  if (frame % 3 === 0) drawMinimap();
  audio.update(speed, inp.up);

  fpsN++; fpsT += dt;
  if (fpsT > 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
  if (showStats) hudStats.textContent = `${fps.toFixed(0)} fps · машин ${st.traffic.length} · пешеходов ${st.peds.length} · чанков в очереди ${pending}`;
  hudStats.classList.toggle('hidden', !showStats);
  document.getElementById('odo').textContent = (st.dist / 10000).toFixed(2) + ' км';

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.game = st;
