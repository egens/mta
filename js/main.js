// Игра: физика, ввод, камера, HUD. Отрисовка — воксельная (voxel.js).
import * as W from './world.js';
import { initSprites } from './sprites.js';
import { createPlayer, updatePlayer, collideStatic, collideCars, repairPlayer, MAX_SPEED } from './car.js';
import { updateTraffic, updatePeds, updateTrains } from './traffic.js';
import { clamp, lerp } from './util.js';
import { rain, updateRain } from './rain.js';
import { createAudio } from './audio.js';
import { createVoxel } from './voxel.js';
import { police, updatePolice, addHeat, clearHeat, stars, sirenLevel } from './police.js';
import { MAP, useMap } from './map.js';
import { procMap } from './procmap.js';
import * as OSM from './osm.js';
import { updateTrafficOSM, updatePedsOSM } from './osmtraffic.js';
import { updateWorks } from './roadworks.js';
import { createMissions } from './missions.js';

// режим карты: процедурный город или Москва (?map=moscow&at=N)
const params = new URLSearchParams(location.search);
const MOSCOW = params.get('map') === 'moscow';
const atIdx = Math.max(0, Math.min(OSM.PLACES.length - 1, parseInt(params.get('at') || '0', 10) || 0));
useMap(MOSCOW ? 'osm' : 'proc', MOSCOW ? OSM.osmMap : procMap);

const glCv = document.getElementById('gl');
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');
const hudSpeed = document.getElementById('speed');
const hudDistrict = document.getElementById('district');
const hudToast = document.getElementById('toast');
const hudLoad = document.getElementById('loading');
const hudStats = document.getElementById('stats');
const hudHp = document.getElementById('hpbar');
const hudHpBox = document.getElementById('hp');
const hudStars = document.getElementById('stars');
const hudMoney = document.getElementById('money');
const hudMission = document.getElementById('mission');
const hudBig = document.getElementById('big');
const hudBonus = document.getElementById('bonus');

initSprites();
const audio = createAudio();

let DPR = 1;
const st = {
  cam: { x: 0, y: 0, z: 1 }, W: 0, H: 0, time: 0, dt: 0, viewR: 2000,
  player: null, traffic: [], peds: [], trains: [], skids: [], fx: [], works: [], cops: police.cops,
  shake: 0, dist: 0,
  onImpact(power, x, y, sparks) {
    if (power < 40) return;
    this.shake = Math.min(14, this.shake + power * 0.03);
    if (sparks) this.fx.push({ type: 'sparks', x, y, n: Math.min(30, (power / 12) | 0) });
    if (power > 150) this.fx.push({ type: 'debris', x, y, color: '#d8262a', n: Math.min(14, (power / 40) | 0) });
    audio.crash(power);
  },
  onDamage(zone, amount) {
    if (amount > 8) toast(zone === 'front' ? 'Помят перед' : zone === 'rear' ? 'Помят зад' : 'Помят бок');
  },
  onWreck() {
    const P = this.player;
    this.fx.push({ type: 'explode', x: P.x, y: P.y });
    this.shake = 20;
    audio.explode();
    toast('Машина разбита! Новая через пару секунд…');
    missions.onWreck();
  },
  onLampBreak(l, sp, byPlayer = true) {
    this.fx.push({ type: 'lamp', lamp: l });
    if (byPlayer) { this.shake = Math.min(14, this.shake + 4); addHeat(0.35); }
    audio.lampHit();
  },
  onPaneBreak(p, c, byPlayer = true) {
    this.fx.push({ type: 'pane', pane: p });
    audio.glass(1);
    if (byPlayer) { this.shake = Math.min(14, this.shake + 3); addHeat(0.25); }
  },
  onConeHit(c, sp) {
    audio.thud(0.15);
    if (sp > 200) this.shake = Math.min(14, this.shake + 1.5);
  },
  onBoardHit(b, sp) {
    audio.lampHit();
    this.shake = Math.min(14, this.shake + 3);
    addHeat(0.15);
  },
  onCarHit(o, power) {
    if (power > 110) addHeat(o.police ? 1 : 0.3);
  },
  onPedHit() {
    audio.thud(0.4);
    addHeat(1);
    toast('Осторожнее на тротуаре!');
  },
  onBusted() {
    missions.onBusted();
    toast('ЗАДЕРЖАН! Розыск снят');
    audio.crash(120);
    clearHeat();
    respawn();
  },
};

// ---------------------------------------------------------------- старт на дороге
function roadSpot(i0, j0) {
  for (let r = 0; r < 12; r++) for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) {
    const x = W.roadX(i) - 21, y = (W.roadY(j) + W.roadY(j + 1)) / 2;
    if (!W.isWater(x, y)) return [x, y];
  }
  return [W.roadX(i0) - 21, W.roadY(j0) + 300];
}
// Москва: стартуем у выбранного места, машину ставим на ближайший участок улицы, когда загрузятся данные
let osmWaiting = MOSCOW;
const start = MOSCOW ? OSM.project(OSM.PLACES[atIdx][1], OSM.PLACES[atIdx][2]) : roadSpot(0, 0);
const [sx, sy] = start;
st.player = createPlayer(sx, sy, Math.PI / 2);
st.cam.x = sx; st.cam.y = sy;

function osmSpot(x, y) {
  const n = OSM.nearestNode(x, y, 3000);
  if (!n) return null;
  const [nid] = [...(n.adj.size ? n.adj.keys() : n.nav)];
  const m = OSM.graph.get(nid);
  const a = Math.atan2(m.y - n.y, m.x - n.x);
  const r = n.adj.get(nid);
  const off = r && !r.road.oneway ? r.road.w / 4 : 0;
  // чуть дальше от узла, на своей полосе
  return [n.x + Math.cos(a) * 60 - Math.sin(a) * off, n.y + Math.sin(a) * 60 + Math.cos(a) * off, a];
}

function respawn() {
  missions.onRespawn();
  const P = st.player;
  if (MOSCOW) {
    const sp = osmSpot(P.x, P.y);
    if (sp) { [P.x, P.y, P.a] = sp; }
  } else {
    const [x, y] = roadSpot(W.colAt(P.x), W.rowAt(P.y));
    P.x = x; P.y = y; P.a = Math.PI / 2;
  }
  P.vx = P.vy = 0;
  repairPlayer(P);
  police.cops.length = 0;
  if (stars() > 0) police.spawnT = 3;
}

// ---------------------------------------------------------------- графика
let vox = null;
try {
  vox = createVoxel(glCv);
} catch (e) {
  console.error(e);
  hudLoad.textContent = 'Нужен браузер с поддержкой WebGL';
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  DPR = Math.min(dpr, Math.sqrt(2600000 / (w * h)));
  st.W = Math.round(w * DPR);
  st.H = Math.round(h * DPR);
  glCv.width = st.W; glCv.height = st.H;
  glCv.style.width = w + 'px'; glCv.style.height = h + 'px';
  if (vox) vox.resize(st.W, st.H);
  const ms = Math.round(Math.min(200, Math.max(120, Math.min(w, h) * 0.26)));
  mini.width = mini.height = Math.round(ms * DPR);
  mini.style.width = mini.style.height = ms + 'px';
}
window.addEventListener('resize', resize);
resize();

function toggleRain() {
  rain.on = !rain.on;
  toast(rain.on ? 'Дождь' : 'Ясно');
  document.getElementById('rainbtn').classList.toggle('off', !rain.on);
}

// ---------------------------------------------------------------- ввод
const keys = {};
const inp = { up: false, down: false, left: false, right: false, hand: false };
const touch = { up: false, down: false, left: false, right: false, hand: false };
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  audio.start();
  if (e.code === 'KeyH') document.getElementById('help').classList.toggle('hidden');
  if (e.code === 'KeyM') toast(audio.toggle() ? 'Звук выключен' : 'Звук включен');
  if (e.code === 'KeyR' && !e.repeat) respawn();
  if (e.code === 'KeyE') audio.horn(true);
  if (e.code === 'KeyT' && !e.repeat) toggleRain();
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
document.getElementById('rainbtn').addEventListener('click', (e) => { e.stopPropagation(); toggleRain(); });
const mapBtn = document.getElementById('mapbtn');
mapBtn.textContent = MOSCOW ? 'ГОРОД' : 'МОСКВА';
mapBtn.addEventListener('click', (e) => { e.stopPropagation(); location.search = MOSCOW ? '' : '?map=moscow'; });
const placeSel = document.getElementById('place');
OSM.PLACES.forEach(([name], k) => { const o = document.createElement('option'); o.value = k; o.textContent = name; placeSel.appendChild(o); });
placeSel.value = atIdx;
for (const el of [placeSel, document.getElementById('modes-intro')]) el.addEventListener('click', (e) => e.stopPropagation());
document.getElementById('go-city').addEventListener('click', (e) => { e.stopPropagation(); if (MOSCOW) location.search = ''; else { audio.start(); hideIntro(); } });
document.getElementById('go-moscow').addEventListener('click', (e) => {
  e.stopPropagation();
  if (MOSCOW && String(atIdx) === placeSel.value) { audio.start(); hideIntro(); return; }
  location.search = '?map=moscow&at=' + placeSel.value;
});
if (MOSCOW) document.body.classList.add('moscow');
document.getElementById('fixbtn').addEventListener('click', (e) => { e.stopPropagation(); respawn(); });
function introHidden() { return document.getElementById('intro').classList.contains('hidden'); }
function hideIntro() { document.getElementById('intro').classList.add('hidden'); }

function readInput() {
  inp.up = keys.ArrowUp || keys.KeyW || touch.up;
  inp.down = keys.ArrowDown || keys.KeyS || touch.down;
  inp.left = keys.ArrowLeft || keys.KeyA || touch.left;
  inp.right = keys.ArrowRight || keys.KeyD || touch.right;
  inp.hand = keys.Space || touch.hand;
}

// ---------------------------------------------------------------- HUD
let toastT = 0;
function toast(msg) { hudToast.textContent = msg; hudToast.classList.add('show'); toastT = 2.2; }

// ---------------------------------------------------------------- задания и события
let bigT = 0;
const bonusQ = [];
const missions = createMissions(st, {
  toast,
  big(title, sub, kind) {
    hudBig.innerHTML = '';
    const h = document.createElement('b'); h.textContent = title;
    const p = document.createElement('span'); p.textContent = sub || '';
    hudBig.append(h, p);
    hudBig.className = 'show ' + kind;
    bigT = 3;
  },
  bonus(text) { bonusQ.push(text); if (bonusQ.length > 4) bonusQ.shift(); renderBonus(); },
  sound(kind) { audio.chime(kind); },
  storm() { toggleRain(); },
});
function renderBonus() {
  hudBonus.innerHTML = '';
  for (const t of bonusQ) { const d = document.createElement('div'); d.textContent = t; hudBonus.appendChild(d); }
}
let bonusT = 0;
function updateMissionHud(dt) {
  if (bigT > 0 && (bigT -= dt) <= 0) hudBig.classList.remove('show');
  if (bonusQ.length && (bonusT += dt) > 1.6) { bonusT = 0; bonusQ.shift(); renderBonus(); }
  hudMoney.textContent = missions.money.toLocaleString('ru-RU') + ' ₽' + (missions.mult > 1 ? ' ×2' : '');
  const pn = missions.panel();
  hudMission.classList.toggle('hidden', !pn);
  if (!pn) return;
  hudMission.style.setProperty('--mc', pn.col);
  hudMission.classList.toggle('danger', !!pn.danger);
  hudMission.querySelector('.t').textContent = pn.title;
  hudMission.querySelector('.l').textContent = pn.line;
  hudMission.querySelector('.tm').textContent = pn.time || '';
  const ar = hudMission.querySelector('.ar');
  ar.style.visibility = pn.target == null ? 'hidden' : 'visible';
  if (pn.target != null) ar.style.transform = `rotate(${pn.target}rad)`;
}
function drawMarkers(m, P, scale, half) {
  // ремонт дорог — оранжевые полосы
  m.fillStyle = '#ff8a2a';
  for (const z of st.works || []) {
    m.save(); m.translate(z.x, z.y); m.rotate(z.a);
    m.fillRect(-z.hl, -Math.max(z.hw, 2.5 * scale), z.hl * 2, Math.max(z.hw, 2.5 * scale) * 2);
    m.restore();
  }
  const R = half * 0.9;
  for (const mk of st.markers || []) {
    let dx = mk.x - P.x, dy = mk.y - P.y;
    const d = Math.hypot(dx, dy);
    const edge = d > R;
    if (edge) { dx *= R / d; dy *= R / d; }
    m.fillStyle = mk.col;
    m.strokeStyle = '#000'; m.lineWidth = 2 * scale;
    m.beginPath(); m.arc(P.x + dx, P.y + dy, (mk.kind === 'pickup' ? 4 : edge ? 5 : 7) * scale, 0, 6.29); m.fill(); m.stroke();
  }
}
let lastDistrict = '';

function drawMinimap() {
  if (MOSCOW) return drawMinimapOSM();
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
    for (let x = x0 - 50; x <= x1 + 50; x += 60) m.lineTo(x, W.riverY(mm, x) - W.riverHV(mm, x));
    for (let x = x1 + 50; x >= x0 - 50; x -= 60) m.lineTo(x, W.riverY(mm, x) + W.riverHV(mm, x));
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
    for (let x = x0 - 50; x <= x1 + 50; x += 60) m.lineTo(x, W.riverY(mm, x) - W.riverHV(mm, x));
    for (let x = x1 + 50; x >= x0 - 50; x -= 60) m.lineTo(x, W.riverY(mm, x) + W.riverHV(mm, x));
    m.closePath(); m.fillStyle = 'rgba(26,74,106,0.75)'; m.fill();
  }
  // машины
  m.fillStyle = '#e8d070';
  for (const c of st.traffic) m.fillRect(c.x - 25, c.y - 25, 50, 50);
  drawMarkers(m, P, scale, half);
  // игрок
  m.save(); m.translate(P.x, P.y); m.rotate(P.a);
  m.fillStyle = '#ff3b3b';
  m.beginPath(); m.moveTo(110, 0); m.lineTo(-70, -70); m.lineTo(-40, 0); m.lineTo(-70, 70); m.closePath(); m.fill();
  m.restore();
}

function drawMinimapOSM() {
  const s = mini.width;
  const P = st.player;
  const scale = 16 / DPR;
  const half = (s / 2) * scale;
  const m = mctx;
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.fillStyle = '#1a1d26';
  m.fillRect(0, 0, s, s);
  m.setTransform(1 / scale, 0, 0, 1 / scale, s / 2 - P.x / scale, s / 2 - P.y / scale);
  const x0 = P.x - half, x1 = P.x + half, y0 = P.y - half, y1 = P.y + half;
  m.lineCap = 'round'; m.lineJoin = 'round';
  const ring = (pts) => { m.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) m.lineTo(pts[i], pts[i + 1]); m.closePath(); };
  for (const a of OSM.areasIn(x0, y0, x1, y1)) if (a.green) { m.beginPath(); for (const r of a.rings) ring(r); m.fillStyle = '#1d3a1e'; m.fill('evenodd'); }
  for (const w of OSM.waterIn(x0, y0, x1, y1)) { m.beginPath(); for (const r of w.rings) ring(r); m.fillStyle = '#1a4a6a'; m.fill('evenodd'); }
  for (const t of OSM.tilesIn(x0, y0, x1, y1)) {
    m.beginPath();
    for (const b of t.buildings) if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) ring(b.pts);
    m.fillStyle = '#2a2d36'; m.fill();
  }
  for (const r of [...OSM.roadsIn(x0, y0, x1, y1)].sort((a, b) => b.rank - a.rank)) {
    m.strokeStyle = r.rank <= 2 ? '#c8b070' : r.rank <= 4 ? '#8a8c94' : '#55585f';
    m.lineWidth = Math.max(r.w, 3 * scale);
    m.beginPath(); m.moveTo(r.pts[0], r.pts[1]); for (let i = 2; i < r.pts.length; i += 2) m.lineTo(r.pts[i], r.pts[i + 1]); m.stroke();
  }
  m.fillStyle = '#e8d070';
  for (const c of st.traffic) m.fillRect(c.x - 25, c.y - 25, 50, 50);
  m.fillStyle = '#4a7aff';
  for (const c of police.cops) m.fillRect(c.x - 35, c.y - 35, 70, 70);
  drawMarkers(m, P, scale, half);
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
  updatePolice(st, dt);
  st.cops = police.cops;
  if (MOSCOW) { updateTrafficOSM(st, dt); updatePedsOSM(st, dt); }
  else { updateTraffic(st, dt); updatePeds(st, dt); }
  updateWorks(st, dt);
}

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  st.time += dt;
  st.dt = dt;
  frame++;
  readInput();
  const P = st.player;
  const n = dt > 0.022 ? 2 : 1;
  if (osmWaiting) {
    // ждём данные OSM вокруг точки старта
    OSM.requestAround(P.x, P.y);
    const sp = OSM.tileReady(P.x, P.y) && osmSpot(P.x, P.y);
    const os = OSM.status;
    const wait = os.current ? ` · ${os.current}, ${((performance.now() - os.since) / 1000) | 0} с` : '';
    hudLoad.textContent = `Загружаем карту Москвы из OpenStreetMap — ${OSM.PLACES[atIdx][0]}${wait}`
      + (os.lastError ? ` · последняя ошибка: ${os.lastError}` : '');
    if (sp) { [P.x, P.y, P.a] = sp; st.cam.x = P.x; st.cam.y = P.y; osmWaiting = false; }
  } else {
    for (let k = 0; k < n; k++) step(dt / n);
    if (introHidden()) missions.update(dt);
  }
  st.markers = missions.markers();
  if (!MOSCOW) updateTrains(st);
  if (P.dead) { P.deadT += dt; if (P.deadT > 3.5) respawn(); }
  const speed = Math.hypot(P.vx, P.vy);
  st.dist += speed * dt;

  // камера
  const minDim = Math.min(st.W, st.H);
  const viewMin = lerp(820, 1350, clamp(speed / MAX_SPEED, 0, 1));
  st.cam.z += (minDim / viewMin - st.cam.z) * Math.min(1, dt * 1.5);
  const lx = P.x + P.vx * 0.45, ly = P.y + P.vy * 0.45;
  st.cam.x += (lx - st.cam.x) * Math.min(1, dt * 4);
  st.cam.y += (ly - st.cam.y) * Math.min(1, dt * 4);
  const camDraw = { ...st.cam };
  if (st.shake > 0.1) {
    camDraw.x += (Math.random() - 0.5) * st.shake * 2;
    camDraw.y += (Math.random() - 0.5) * st.shake * 2;
    st.shake *= Math.exp(-dt * 8);
  }
  updateRain(st, dt);
  const pending = vox ? vox.render({ ...st, cam: camDraw }, frame < 3 || osmWaiting) : 0;
  hudLoad.classList.toggle('hidden', frame > 2 && !!vox && !osmWaiting);

  // HUD
  hudSpeed.textContent = Math.round((speed / 10) * 3.6);
  hudHp.style.width = P.hp + '%';
  const sN = stars();
  hudStars.textContent = sN ? '★'.repeat(sN) + '☆'.repeat(5 - sN) : '';
  hudStars.classList.toggle('blink', sN > 0 && police.bustT > 0);
  hudHp.style.background = P.hp > 60 ? '#5ee68a' : P.hp > 30 ? '#ffd27a' : '#ff4f5a';
  hudHpBox.classList.toggle('low', P.hp < 30);
  const dname = MAP.impl.district(P.x, P.y);
  if (dname !== lastDistrict) {
    lastDistrict = dname;
    hudDistrict.textContent = dname;
    hudDistrict.classList.remove('flash'); void hudDistrict.offsetWidth; hudDistrict.classList.add('flash');
  }
  updateMissionHud(dt);
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) hudToast.classList.remove('show'); }
  if (frame % 3 === 0) drawMinimap();
  audio.siren(sirenLevel(P));
  audio.update(dt, Math.hypot(P.vx, P.vy) * Math.sign(P.vx * Math.cos(P.a) + P.vy * Math.sin(P.a) || 1), MAX_SPEED, inp.up && !P.dead, P.drift, rain.k, P.dead);

  fpsN++; fpsT += dt;
  if (fpsT > 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
  if (showStats) hudStats.textContent = `${fps.toFixed(0)} fps · машин ${st.traffic.length} · пешеходов ${st.peds.length} · в очереди ${pending}`;
  hudStats.classList.toggle('hidden', !showStats);
  document.getElementById('odo').textContent = (st.dist / 10000).toFixed(2) + ' км';

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.game = st;
