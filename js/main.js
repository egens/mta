// Игра: физика, ввод, камера, HUD. Отрисовка — воксельная (voxel.js).
import * as W from './world.js';
import { initSprites } from './sprites.js';
import { createPlayer, updatePlayer, collideStatic, collideCars, repairPlayer, MAX_SPEED } from './car.js';
import { updateTraffic, updatePeds, updateTrains } from './traffic.js';
import { rain, updateRain } from './rain.js';
import { createAudio } from './audio.js';
import { createVoxel } from './voxel.js';
import { police, updatePolice, addHeat, clearHeat, stars, sirenLevel } from './police.js';
import { MAP, useMap } from './map.js';
import { procMap } from './procmap.js';
import { updateWorks } from './roadworks.js';
import { createMissions } from './missions.js';
import { createShop } from './shop.js';
import { createRun } from './run.js';

useMap('proc', procMap);

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
const hudNitro = document.getElementById('nitro');
const hudNitroBar = document.getElementById('nitrobar');
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
    if (P.drowned) {
      audio.thud(1);
      toast('Машина утонула!');
    } else {
      this.fx.push({ type: 'explode', x: P.x, y: P.y });
      this.shake = 20;
      audio.explode();
      toast('Машина разбита!');
    }
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
    // арест — не смерть: полиция конфискует половину денег и вывозит на другую улицу
    const fine = Math.floor(missions.money / 2);
    missions.spend(fine);
    toast(fine ? `ЗАДЕРЖАН! Конфисковано ${fine} ₽` : 'ЗАДЕРЖАН!');
    audio.crash(120);
    clearHeat();
    respawn(false);
  },
};

// ---------------------------------------------------------------- старт на дороге
function roadSpot(i0, j0) {
  for (let r = 0; r < 12; r++) for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) {
    const x = W.roadX(i) - 21, y = (W.roadY(j) + W.roadY(j + 1)) / 2;
    if (W.vSegExists(i, j) && !W.isWater(x, y)) return [x, y];
  }
  return [W.roadX(i0) - 21, W.roadY(j0) + 300];
}
const [sx, sy] = roadSpot(0, 0);
st.player = createPlayer(sx, sy, Math.PI / 2);
st.cam.x = sx; st.cam.y = sy;

function respawn(repair = true) {
  missions.onRespawn();
  const P = st.player;
  const [x, y] = roadSpot(W.colAt(P.x), W.rowAt(P.y));
  P.x = x; P.y = y; P.a = Math.PI / 2; P.z = 0; P.vz = 0; P.air = false;
  P.vx = P.vy = 0;
  if (repair) repairPlayer(P);
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
  audio.start();
  if (shop && shop.open) { shop.key(e.code); e.preventDefault(); return; }
  keys[e.code] = true;
  if (e.code === 'KeyH') document.getElementById('help').classList.toggle('hidden');
  if (e.code === 'KeyM') toast(audio.toggle() ? 'Звук выключен' : 'Звук включен');
  if (e.code === 'KeyR' && !e.repeat && !st.player.dead) respawn(false);
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
document.getElementById('fixbtn').addEventListener('click', (e) => { e.stopPropagation(); if (!st.player.dead) respawn(false); });
function introHidden() { return document.getElementById('intro').classList.contains('hidden'); }
function hideIntro() { document.getElementById('intro').classList.add('hidden'); }

function readInput() {
  inp.up = keys.ArrowUp || keys.KeyW || touch.up;
  inp.down = keys.ArrowDown || keys.KeyS || touch.down;
  inp.left = keys.ArrowLeft || keys.KeyA || touch.left;
  inp.right = keys.ArrowRight || keys.KeyD || touch.right;
  inp.hand = keys.Space || touch.hand;
  inp.boost = keys.ShiftLeft || keys.ShiftRight || touch.boost;
}

// ---------------------------------------------------------------- HUD
let toastT = 0;
function toast(msg) { hudToast.textContent = msg; hudToast.classList.add('show'); toastT = 2.2; }

// ---------------------------------------------------------------- задания и события
let bigT = 0;
const bonusQ = [];
const UI = {
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
  money: () => missions.money,
  pay: (s) => missions.give(s, 'ШТАБ'),
  over: showRunOver,
  done: () => run.intel('mission'),
};
const missions = createMissions(st, UI);
const run = createRun(st, { ...UI, sound: (k) => (k === 'boom' ? audio.explode() : audio.chime(k)) });
const shop = createShop(st, { money: () => missions.money, spend: (s) => missions.spend(s), toast, sound: (k) => audio.chime(k), run });
st.hqs = run.hqs;

// ---------------------------------------------------------------- конец забега
function fmtT(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; }
function showRunOver(o) {
  const el = document.getElementById('runover');
  el.innerHTML = '';
  el.className = o.won ? 'won' : 'lost';
  const h = document.createElement('h2'); h.textContent = o.won ? 'СИНДИКАТ ПАЛ' : 'ЗАБЕГ ОКОНЧЕН';
  const r = document.createElement('p'); r.textContent = o.reason;
  const stats = document.createElement('div'); stats.className = 'stats';
  const b = o.best || {};
  for (const [k, v] of [['Разгромлено банд', `${o.destroyed} / ${o.total}`], ['Время забега', fmtT(o.t)], ['Деньги', `${o.money.toLocaleString('ru-RU')} ₽`],
    ['Лучший результат', `${b.bestHQ || 0} / ${o.total} банд`], ['Побед', `${b.wins || 0} из ${b.runs || 0}`], ...(b.bestT != null ? [['Рекорд победы', fmtT(b.bestT)]] : [])]) {
    const row = document.createElement('div'); const a = document.createElement('span'); a.textContent = k; const c = document.createElement('b'); c.textContent = v;
    row.append(a, c); stats.append(row);
  }
  const btn = document.createElement('button'); btn.textContent = 'НОВЫЙ ЗАБЕГ — НОВЫЙ ГОРОД';
  btn.addEventListener('click', (e) => { e.stopPropagation(); run.restart(); });
  el.append(h, r, stats, btn);
}
if (run.over) {
  let best = null; try { best = JSON.parse(localStorage.getItem('mta-best')); } catch (e) { /* нет */ }
  showRunOver({ won: run.won, reason: run.won ? 'Синдикат уже повержен' : 'Машина потеряна', destroyed: run.destroyed(), total: run.hqs.length, t: run.time, money: missions.money, best });
}

// ---------------------------------------------------------------- панель синдиката
const hudSyn = document.getElementById('syn');
let synKey = '';
function renderSyn() {
  const rows = run.panel();
  const key = JSON.stringify(rows);
  if (key === synKey) return;
  synKey = key;
  hudSyn.innerHTML = '';
  const t = document.createElement('div'); t.className = 'h'; t.textContent = `СИНДИКАТ · ${run.destroyed()}/${rows.length}`;
  hudSyn.append(t);
  for (const r of rows) {
    const d = document.createElement('div');
    d.className = (r.dead ? 'dead' : '') + (r.target ? ' tgt' : '');
    d.style.setProperty('--gc', r.col);
    const n = document.createElement('b'); n.textContent = r.name;
    const s = document.createElement('span');
    s.textContent = r.dead ? 'разгромлены' : r.intel >= 3 ? `штаб найден · реакторы ${r.left}/${r.n}` : r.intel ? `наводки ${r.intel}/3` : 'где-то в городе';
    d.append(n, s); hudSyn.append(d);
  }
}
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
  // штабы банд: зона поиска по наводкам или точное место с реакторами
  for (const z of run.mapInfo()) {
    m.strokeStyle = z.col; m.fillStyle = z.col; m.lineWidth = 2.5 * scale;
    if (!z.exact) {
      m.globalAlpha = 0.12; m.beginPath(); m.arc(z.x, z.y, z.r, 0, 6.29); m.fill();
      m.globalAlpha = 0.8; m.setLineDash([12 * scale, 8 * scale]); m.stroke(); m.setLineDash([]); m.globalAlpha = 1;
      continue;
    }
    for (const p of z.hq.pylons) if (!p.dead) { m.beginPath(); m.arc(p.x, p.y, 3.5 * scale, 0, 6.29); m.fill(); }
    let dx = z.x - P.x, dy = z.y - P.y;
    const d = Math.hypot(dx, dy), R0 = half * 0.63;
    if (d > R0) { dx *= R0 / d; dy *= R0 / d; }
    const r = 7 * scale;
    m.save(); m.translate(P.x + dx, P.y + dy); m.rotate(Math.PI / 4);
    m.fillRect(-r, -r, r * 2, r * 2); m.strokeStyle = '#000'; m.lineWidth = 2 * scale; m.strokeRect(-r, -r, r * 2, r * 2);
    m.restore();
  }
  const R = half * 0.63;
  for (const mk of st.markers || []) {
    let dx = mk.x - P.x, dy = mk.y - P.y;
    const d = Math.hypot(dx, dy);
    const edge = d > R;
    if (edge) { dx *= R / d; dy *= R / d; }
    m.fillStyle = mk.col;
    m.strokeStyle = '#000'; m.lineWidth = 2 * scale;
    m.beginPath();
    // мастерская — квадрат, остальное — кружки
    if (mk.kind === 'shop') { const r = (edge ? 4 : 6) * scale; m.rect(P.x + dx - r, P.y + dy - r, r * 2, r * 2); }
    else m.arc(P.x + dx, P.y + dy, (mk.kind === 'pickup' ? 4 : edge ? 5 : 7) * scale, 0, 6.29);
    m.fill(); m.stroke();
  }
}
let lastDistrict = '';

function drawMinimap() {
  const s = mini.width;
  const P = st.player;
  const scale = 16 / DPR; // мировых единиц на пиксель
  const half = (s / 2) * scale * 1.42; // карта повёрнута — берём с запасом на углы
  const m = mctx;
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.fillStyle = '#0a0d14';
  m.fillRect(0, 0, s, s);
  // направление движения всегда вверх, как и камера за машиной
  m.translate(s / 2, s / 2); m.rotate(-Math.PI / 2 - P.a); m.scale(1 / scale, 1 / scale); m.translate(-P.x, -P.y);
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
  // улицы — по отрезкам между перекрёстками, пропавшие отрезки не рисуем
  const ci0 = W.colAt(x0), ci1 = W.colAt(x1) + 1, rj0 = W.rowAt(y0), rj1 = W.rowAt(y1) + 1;
  for (let i = ci0; i <= ci1; i++) for (let j = rj0 - 1; j <= rj1; j++) {
    if (!W.vSegExists(i, j)) continue;
    m.fillStyle = W.aveX(i) ? '#8a8c94' : '#55585f';
    const w = Math.max(W.widthX(i), 3 * scale), ya = W.roadY(j) - W.widthY(j) / 2, yb = W.roadY(j + 1) + W.widthY(j + 1) / 2;
    m.fillRect(W.roadX(i) - w / 2, ya, w, yb - ya);
  }
  for (let j = rj0; j <= rj1; j++) for (let i = ci0 - 1; i <= ci1; i++) {
    if (!W.hSegExists(i, j)) continue;
    m.fillStyle = W.aveY(j) ? '#8a8c94' : '#55585f';
    const w = Math.max(W.widthY(j), 3 * scale), xa = W.roadX(i) - W.widthX(i) / 2, xb = W.roadX(i + 1) + W.widthX(i + 1) / 2;
    m.fillRect(xa, W.roadY(j) - w / 2, xb - xa, w);
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
  updateTraffic(st, dt);
  updatePeds(st, dt);
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
  // в мастерской игра на паузе
  if (!shop.open && !run.over) {
    for (let k = 0; k < n; k++) step(dt / n);
    if (introHidden()) { missions.update(dt); shop.update(); run.update(dt); }
  }
  st.markers = [...missions.markers(), ...shop.markers()];
  updateTrains(st);
  // машина одна: гибель заканчивает забег
  if (P.dead) { P.deadT += dt; if (P.deadT > 2.5) run.die(P.drowned ? 'Машина утонула' : 'Машина разбита'); }
  const speed = Math.hypot(P.vx, P.vy);
  st.dist += speed * dt;

  // камера идёт за машиной; вид от третьего лица строит voxel.js
  st.cam.x = P.x; st.cam.y = P.y;
  updateRain(st, dt);
  const pending = vox ? vox.render(st, frame < 3) : 0;
  st.shake *= Math.exp(-dt * 8);
  hudLoad.classList.toggle('hidden', frame > 2 && !!vox);

  // HUD
  hudSpeed.textContent = Math.round((speed / 10) * 3.6);
  hudHp.style.width = P.hp + '%';
  const sN = stars();
  hudStars.textContent = sN ? '★'.repeat(sN) + '☆'.repeat(5 - sN) : '';
  hudStars.classList.toggle('blink', sN > 0 && police.bustT > 0);
  hudHp.style.background = P.hp > 60 ? '#5ee68a' : P.hp > 30 ? '#ffd27a' : '#ff4f5a';
  hudHpBox.classList.toggle('low', P.hp < 30);
  hudNitro.classList.toggle('hidden', !P.nitro);
  if (P.nitro) { hudNitroBar.style.width = (P.nitroT / 3) * 100 + '%'; hudNitro.classList.toggle('on', !!P.boosting); }
  const dname = MAP.impl.district(P.x, P.y);
  if (dname !== lastDistrict) {
    lastDistrict = dname;
    hudDistrict.textContent = dname;
    hudDistrict.classList.remove('flash'); void hudDistrict.offsetWidth; hudDistrict.classList.add('flash');
  }
  updateMissionHud(dt);
  if (frame % 10 === 0) renderSyn();
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
