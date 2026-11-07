// Забег-рогалик «Свергнуть синдикат». В городе спрятаны пять штабов банд — чем дальше от старта,
// тем опаснее. Где штаб, сначала неизвестно: наводки (за выполненные заказы или купленные в
// мастерской) сужают зону поиска на мини-карте, вблизи штаб виден сам. Вокруг штаба стоят
// реакторы — их надо протаранить на скорости; банда тем временем натравливает продажных копов.
// Машина одна: разбил или утопил — забег окончен. Новый забег — новый город, деньги и тюнинг с нуля.
import * as W from './world.js';
import { SEED, hash } from './util.js';
import { police, addHeat } from './police.js';
import { damagePlayer } from './car.js';

const KEY = 'mta-run', BEST = 'mta-best';
export const GANGS = [
  { name: 'Неоновые Черепа', col: '#ff3fc8' },
  { name: 'Хром-Волки', col: '#3ef2ff' },
  { name: 'Нулевой Сектор', col: '#9cff2a' },
  { name: 'Красные Драконы', col: '#ff5a3a' },
  { name: 'Синдикат «Яма»', col: '#ffd23a' },
];
const ZONE_R = [Infinity, 2600, 1300, 0];   // радиус зоны поиска по числу наводок
const GOOD = new Set(['towers', 'mixed', 'perimeter', 'micro', 'industrial']);

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* без сохранений */ } }

// Штаб k: квартал на кольце 3–10 км от старта, у каждой банды своё направление
function placeHQ(k) {
  const a = hash(0, 0, 9000) * Math.PI * 2 + (k * Math.PI * 2 * 2) / 5 + (hash(k, 1, 9001) - 0.5) * 0.5;
  const d = 3200 + k * 1500 + hash(k, 2, 9002) * 800;
  const i0 = W.colAt(Math.cos(a) * d), j0 = W.rowAt(Math.sin(a) * d);
  let B = null;
  for (let r = 0; r < 6 && !B; r++) for (let i = i0 - r; i <= i0 + r && !B; i++) for (let j = j0 - r; j <= j0 + r && !B; j++) {
    const b = W.getBlock(i, j);
    if (GOOD.has(b.type) && !b.river && !b.diags.length && b.rail === null && b.buildings.length) B = b;
  }
  B = B || W.getBlock(i0, j0);
  // реакторы — на тротуаре по периметру квартала, туда можно подъехать с улицы
  const n = 3 + k, x0 = B.x0 + 9, y0 = B.y0 + 9, w = B.x1 - B.x0 - 18, h = B.y1 - B.y0 - 18, L = 2 * (w + h);
  const pylons = [];
  for (let m = 0; m < n; m++) {
    let u = ((m + 0.5 + hash(k, m, 9003) * 0.4 - 0.2) / n) * L;
    let x, y;
    if (u < w) { x = x0 + u; y = y0; } else if ((u -= w) < h) { x = x0 + w; y = y0 + u; }
    else if ((u -= h) < w) { x = x0 + w - u; y = y0 + h; } else { u -= w; x = x0; y = y0 + h - u; }
    pylons.push({ x, y, dead: false });
  }
  const za = hash(k, 3, 9004) * Math.PI * 2, zr = hash(k, 4, 9005);
  return { k, ...GANGS[k], x: B.cx, y: B.cy, i: B.i, j: B.j, pylons, zoneOff: [Math.cos(za) * zr, Math.sin(za) * zr] };
}

export function createRun(st, ui) {
  let S = load(KEY);
  if (!S || S.seed !== SEED || !S.hq) S = { seed: SEED, t: 0, over: false, won: false, hq: GANGS.map(() => ({ dead: false, intel: 0, pylons: null, seen: false, raid: false })) };
  const hqs = GANGS.map((g, k) => {
    const h = placeHQ(k), s = S.hq[k];
    h.state = s;
    if (s.pylons) h.pylons.forEach((p, m) => { p.dead = !!s.pylons[m]; });
    return h;
  });
  const save = () => { S.hq.forEach((s, k) => { s.pylons = hqs[k].pylons.map((p) => (p.dead ? 1 : 0)); }); store(KEY, S); };
  let saveT = 0;
  const target = () => hqs.find((h) => !h.state.dead && h.state.intel < 3) || null;
  const destroyed = () => hqs.filter((h) => h.state.dead).length;

  function intel(source) {
    const h = target();
    if (!h) return false;
    h.state.intel++;
    save();
    ui.bonus(h.state.intel >= 3 ? `НАВОДКА: штаб «${h.name}» найден` : `НАВОДКА на «${h.name}» (${h.state.intel}/3)`);
    if (source !== 'shop') ui.sound('stunt');
    return true;
  }

  function hitPylon(h, p, P) {
    p.dead = true;
    st.fx.push({ type: 'explode', x: p.x, y: p.y });
    st.shake = Math.min(20, (st.shake || 0) + 10);
    P.vx *= 0.55; P.vy *= 0.55;
    const nx = P.x - p.x, ny = P.y - p.y, l = Math.hypot(nx, ny) || 1;
    damagePlayer(P, 230, nx / l, ny / l, st);
    ui.sound('boom');
    const left = h.pylons.filter((q) => !q.dead).length;
    if (left) { ui.bonus(`РЕАКТОР УНИЧТОЖЕН · осталось ${left}`); save(); return; }
    // штаб пал
    h.state.dead = true;
    const sum = ui.pay(2500 * (h.k + 1));
    addHeat(1);
    save();
    if (destroyed() === GANGS.length) { win(); return; }
    ui.big(`«${h.name}» РАЗГРОМЛЕНЫ`, `штаб уничтожен · +${sum} ₽ · осталось банд: ${GANGS.length - destroyed()}`, 'win');
    ui.sound('win');
  }

  function finishRun(won, reason) {
    if (S.over) return;
    S.over = true; S.won = won;
    store(KEY, S);
    const best = load(BEST) || { wins: 0, bestHQ: 0, bestT: null, runs: 0 };
    best.runs++;
    best.bestHQ = Math.max(best.bestHQ, destroyed());
    if (won) { best.wins++; if (best.bestT === null || S.t < best.bestT) best.bestT = S.t; }
    store(BEST, best);
    ui.over({ won, reason, destroyed: destroyed(), total: GANGS.length, t: S.t, money: ui.money(), best });
  }
  function win() { ui.sound('win'); finishRun(true, 'Все пять банд разгромлены — синдикат пал'); }

  return {
    hqs,
    get over() { return S.over; },
    get won() { return S.won; },
    get time() { return S.t; },
    destroyed,
    target,
    intel,
    update(dt) {
      if (S.over) return;
      S.t += dt;
      if ((saveT += dt) > 5) { saveT = 0; save(); }
      const P = st.player;
      if (P.dead) return;
      const sp = Math.hypot(P.vx, P.vy);
      for (const h of hqs) {
        if (h.state.dead) continue;
        const d = Math.hypot(h.x - P.x, h.y - P.y);
        if (d < 650 && h.state.intel < 3) { h.state.intel = 3; save(); ui.big(`ШТАБ «${h.name}»`, 'найден — тараньте реакторы', 'start'); ui.sound('start'); }
        if (d > 800) { h.state.raid = false; continue; }
        // налёт: банда натравливает продажных копов, тем больше, чем опаснее банда
        const need = Math.min(5, 2 + Math.floor(h.k * 0.75));
        if (police.heat < need) addHeat(need - police.heat + 0.3);
        if (!h.state.raid) { h.state.raid = true; ui.toast(`«${h.name}» вызвали продажных копов!`); }
        if ((P.z || 0) > 20) continue;
        for (const p of h.pylons) {
          if (p.dead) continue;
          const dx = P.x - p.x, dy = P.y - p.y, dd = Math.hypot(dx, dy);
          if (dd > P.L / 2 + 10) continue;
          if (sp > 120) hitPylon(h, p, P);
          else {
            // медленно — упираемся в реактор
            const k = (P.L / 2 + 10 - dd) / (dd || 1);
            P.x += dx * k; P.y += dy * k;
            const vn = (P.vx * dx + P.vy * dy) / (dd || 1);
            if (vn < 0) { P.vx -= (vn * dx) / (dd || 1) * 1.3; P.vy -= (vn * dy) / (dd || 1) * 1.3; }
          }
        }
      }
    },
    // смерть машины — конец забега
    die(reason) { finishRun(false, reason); },
    // данные для мини-карты: зона поиска, точное место и реакторы
    mapInfo() {
      return hqs.filter((h) => !h.state.dead && h.state.intel > 0).map((h) => {
        const r = ZONE_R[h.state.intel];
        return { col: h.col, exact: r === 0, x: h.x + h.zoneOff[0] * r * 0.6, y: h.y + h.zoneOff[1] * r * 0.6, r, hq: h };
      });
    },
    // панель синдиката в HUD
    panel() {
      return hqs.map((h) => ({ name: h.name, col: h.col, dead: h.state.dead, intel: h.state.intel,
        left: h.pylons.filter((p) => !p.dead).length, n: h.pylons.length, target: h === target() }));
    },
    // новый забег: новый город, деньги и тюнинг с нуля
    restart() {
      store(KEY, { seed: (Math.random() * 0xffffffff) >>> 0 || 1, t: 0, over: false, won: false, hq: null });
      store('mta-save', { money: 0, done: 0 });
      try { localStorage.removeItem('mta-garage'); } catch (e) { /* ничего */ }
      location.reload();
    },
  };
}
