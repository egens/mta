// Задания и события. На дорогах вокруг игрока появляются маяки-заказы: въехал в круг —
// задание началось (таймер, цель на мини-карте, стрелка). Плюс случайные события города
// (деньги на дороге, ремонт, «конверт» от розыска, инкассатор, двойные бонусы, ливень)
// и бонусы за трюки: дрифт, прыжок, проезд впритирку. Деньги и рекорды — в localStorage.
import { MAP } from './map.js';
import { police, addHeat, clearHeat, stars } from './police.js';
import { repairPlayer } from './car.js';

const KMH = 10 / 3.6; // единиц в секунду на 1 км/ч
const TYPES = {
  taxi: { name: 'Такси', col: '#ffd24a', about: 'довезти пассажира вовремя' },
  race: { name: 'Гонка', col: '#5ee6ff', about: 'пройти чекпоинты на время' },
  hunt: { name: 'Охота', col: '#ff4f5a', about: 'протаранить машины банды' },
  escape: { name: 'Побег', col: '#6a8cff', about: 'уйти от погони' },
  drift: { name: 'Дрифт', col: '#ff4fb4', about: 'надрифтовать 8 секунд' },
  bomb: { name: 'Бомба', col: '#ff8a2a', about: 'не сбавлять скорость ниже 80' },
  cargo: { name: 'Хрупкий груз', col: '#7cff9a', about: 'доставить, не разбив' },
};
const PICK = {
  cash: { col: '#5effa0', r: 46 },
  repair: { col: '#5ee6ff', r: 52 },
  bribe: { col: '#ffd24a', r: 52 },
};

function load() {
  try { return JSON.parse(localStorage.getItem('mta-save')) || {}; } catch (e) { return {}; }
}
function save(d) { try { localStorage.setItem('mta-save', JSON.stringify(d)); } catch (e) { /* без сохранений */ } }

export const fmtTime = (t) => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
export const fmtDist = (d) => (d >= 10000 ? (d / 10000).toFixed(1) + ' км' : Math.round(d / 10) + ' м');

export function createMissions(st, ui) {
  const saved = load();
  const M = {
    money: saved.money || 0, done: saved.done || 0,
    active: null, offers: [], pickups: [], cooldown: 6, offerT: 3, evT: 40,
    mult: 1, multT: 0, lastType: null,
  };
  const S = { driftT: 0, driftGap: 0, airT: 0, near: [] };
  const P = () => st.player;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const speed = () => Math.hypot(P().vx, P().vy);
  const spot = (from, dmin, dmax) => {
    const sp = MAP.impl.roadSpawn(from.x, from.y, dmin, dmax);
    if (!sp || !MAP.impl.ready(sp[0], sp[1]) || MAP.impl.isWater(sp[0], sp[1])) return null;
    // не кладём маркеры друг на друга
    for (const o of [...M.offers, ...M.pickups]) if (Math.hypot(o.x - sp[0], o.y - sp[1]) < 160) return null;
    return { x: sp[0], y: sp[1] };
  };

  function pay(sum, why) {
    sum = Math.round(sum);
    M.money += sum;
    save({ money: M.money, done: M.done });
    if (why) ui.bonus(`${why} +${sum} ₽`);
    return sum;
  }

  // ---------------------------------------------------------------- задания
  function start(type, opt = {}) {
    const p = P();
    const m = { type, t: 0, time: 60, title: opt.title || TYPES[type].name, col: TYPES[type].col, reward: 0 };
    if (type === 'taxi' || type === 'cargo') {
      const d = spot(p, 4500, 8000) || spot(p, 2500, 4500);
      if (!d) return false;
      m.dest = d;
      m.time = 12 + dist(p, d) / (type === 'cargo' ? 250 : 320);
      m.reward = 150 + dist(p, d) / 20;
      m.hp0 = p.hp;
      if (type === 'cargo') m.reward *= 1.6;
    } else if (type === 'race') {
      m.cps = []; m.cp = 0; m.n = 5; m.time = 18; m.reward = 500;
      let from = p;
      for (let k = 0; k < m.n; k++) { const c = spot(from, 1600, 2600); if (!c) break; m.cps.push(c); from = c; }
      if (m.cps.length < 3) return false;
      m.n = m.cps.length;
    } else if (type === 'hunt') {
      const n = opt.count || 3;
      m.targets = st.traffic.filter((c) => c.mode === 'drive' && !c.target && dist(c, p) > 400 && dist(c, p) < 2200).slice(0, n);
      if (!m.targets.length) return false;
      for (const c of m.targets) { c.target = true; c.cruise *= 1.35; }
      m.time = opt.time || 70; m.per = opt.per || 250; m.heat = opt.heat || 0.5;
    } else if (type === 'escape') {
      police.heat = Math.max(police.heat, 3.2);
      m.time = 120; m.reward = 650;
    } else if (type === 'drift') {
      m.need = 8; m.got = 0; m.time = 45; m.reward = 380;
    } else if (type === 'bomb') {
      m.armed = false; m.slowT = 0; m.time = 12; m.hold = 30; m.reward = 750;
    }
    M.active = m;
    M.lastType = type;
    ui.big(m.title, TYPES[type].about, 'start');
    ui.sound('start');
    return true;
  }

  function finish(win, msg) {
    const m = M.active;
    M.active = null;
    M.cooldown = 5; M.offerT = 3;
    if (m.targets) for (const c of m.targets) c.target = false;
    if (win) {
      M.done++;
      const sum = pay(m.reward * M.mult);
      ui.big('ЗАДАНИЕ ВЫПОЛНЕНО', `${msg ? msg + ' · ' : ''}+${sum} ₽`, 'win');
      ui.sound('win');
    } else {
      ui.big('ПРОВАЛ', msg, 'fail');
      ui.sound('fail');
    }
  }

  function updateActive(dt) {
    const m = M.active, p = P(), v = speed();
    m.t += dt;
    const prevSec = Math.ceil(m.time);
    m.time -= dt;
    if (m.time < 5.5 && Math.ceil(m.time) !== prevSec && m.time > 0) ui.sound('tick');
    if (m.type === 'taxi' || m.type === 'cargo') {
      if (m.type === 'cargo' && p.hp < m.hp0 - 20) return finish(false, 'Груз разбит');
      if (dist(p, m.dest) < 85) {
        if (v < 140) { m.reward += Math.max(0, m.time) * 6; return finish(true, m.type === 'taxi' ? 'Пассажир доволен' : 'Груз цел'); }
        m.hint = 'Остановитесь в круге';
      } else m.hint = null;
    } else if (m.type === 'race') {
      if (dist(p, m.cps[m.cp]) < 95) {
        m.cp++;
        if (m.cp >= m.n) { m.reward += Math.max(0, m.time) * 12; return finish(true, 'Финиш!'); }
        m.time += 11;
        ui.sound('pickup');
        ui.bonus(`Чекпоинт ${m.cp}/${m.n}`);
      }
    } else if (m.type === 'hunt') {
      for (const c of m.targets) {
        if (c.dead) continue;
        if (c.mode !== 'drive') { c.dead = true; c.target = false; pay(m.per * M.mult, 'Цель выбита'); ui.sound('pickup'); addHeat(m.heat); }
        else if (!st.traffic.includes(c)) { c.dead = c.lost = true; c.target = false; }
      }
      const left = m.targets.filter((c) => !c.dead).length;
      if (!left) {
        const hit = m.targets.filter((c) => !c.lost).length;
        if (!hit) return finish(false, 'Цели ушли');
        m.reward = 100 * hit; return finish(true, `Выбито ${hit} из ${m.targets.length}`);
      }
    } else if (m.type === 'escape') {
      if (m.t > 4 && stars() === 0) { m.reward += Math.max(0, m.time) * 4; return finish(true, 'Хвост сброшен'); }
    } else if (m.type === 'drift') {
      if (p.drift > 70 && v > 150 && !p.air) m.got += dt;
      if (m.got >= m.need) return finish(true, 'Чистый дрифт');
    } else if (m.type === 'bomb') {
      if (!m.armed) {
        if (v > 80 * KMH) { m.armed = true; m.time = m.hold; ui.bonus('Бомба взведена!'); ui.sound('tick'); }
        else if (m.time <= 0) return explode(m);
      } else {
        m.slowT = v < 80 * KMH ? m.slowT + dt : 0;
        if (m.slowT > 1.5) return explode(m);
        if (m.time <= 0) return finish(true, 'Бомба обезврежена');
      }
      return;
    }
    if (m.time <= 0) finish(false, 'Время вышло');
  }
  function explode() {
    const p = P();
    p.hp = 0;
    if (!p.dead) { p.dead = true; p.deadT = 0; st.onWreck(p); }
    finish(false, 'Бомба взорвалась');
  }

  // ---------------------------------------------------------------- предложения и события
  function updateOffers(dt) {
    const p = P();
    M.offers = M.offers.filter((o) => dist(o, p) < 4200);
    if (M.active) return;
    M.cooldown -= dt;
    M.offerT -= dt;
    if (M.offerT <= 0 && M.offers.length < 3) {
      M.offerT = 4;
      const kinds = Object.keys(TYPES).filter((k) => k !== M.lastType && !M.offers.some((o) => o.type === k));
      const type = kinds[(Math.random() * kinds.length) | 0];
      const s = spot(p, 600, 1700);
      if (s) M.offers.push({ ...s, type });
    }
    if (M.cooldown > 0) return;
    for (const o of M.offers) {
      if (dist(o, p) < 70) {
        M.offers.splice(M.offers.indexOf(o), 1);
        if (!start(o.type)) ui.toast('Заказ отменили');
        return;
      }
    }
  }

  function event() {
    const p = P();
    const opts = ['cash', 'cash', 'double', 'storm'];
    if (p.hp < 70) opts.push('repair', 'repair');
    if (stars() > 0) opts.push('bribe', 'bribe');
    if (!M.active) opts.push('convoy', 'convoy');
    const e = opts[(Math.random() * opts.length) | 0];
    if (e === 'cash') {
      let n = 0;
      for (let k = 0; k < 12 && n < 7; k++) { const s = spot(p, 300, 1500); if (s) { M.pickups.push({ ...s, kind: 'cash', value: 25 + ((Math.random() * 40) | 0), t: 60 }); n++; } }
      if (n) ui.big('ДЕНЬГИ НА ДОРОГЕ', 'Инкассатор рассыпал выручку — соберите', 'event');
    } else if (e === 'repair') {
      const s = spot(p, 400, 1000);
      if (s) { M.pickups.push({ ...s, kind: 'repair', t: 60 }); ui.big('РЕМОНТ', 'Рядом бесплатный автосервис — заезжайте', 'event'); }
    } else if (e === 'bribe') {
      const s = spot(p, 400, 1100);
      if (s) { M.pickups.push({ ...s, kind: 'bribe', t: 50 }); ui.big('КОНВЕРТ', 'Знакомый в ГИБДД снимет розыск — заберите', 'event'); }
    } else if (e === 'double') {
      M.mult = 2; M.multT = 30;
      ui.big('ДВОЙНЫЕ ДЕНЬГИ', '30 секунд всё ×2', 'event');
    } else if (e === 'storm') {
      ui.storm();
    } else if (e === 'convoy') {
      start('hunt', { count: 1, title: 'Инкассатор', time: 40, per: 900, heat: 1.5 });
    }
    ui.sound('start');
  }

  function updatePickups(dt) {
    const p = P();
    M.pickups = M.pickups.filter((k) => (k.t -= dt) > 0 && dist(k, p) < 4500);
    for (const k of [...M.pickups]) {
      if (dist(k, p) > PICK[k.kind].r + 20) continue;
      M.pickups.splice(M.pickups.indexOf(k), 1);
      ui.sound('pickup');
      if (k.kind === 'cash') pay(k.value * M.mult, 'Деньги');
      else if (k.kind === 'repair') { repairPlayer(p); ui.bonus('Машина как новая'); }
      else if (k.kind === 'bribe') { clearHeat(); ui.bonus('Розыск снят'); }
    }
  }

  // ---------------------------------------------------------------- трюки
  function updateStunts(dt) {
    const p = P(), v = speed();
    if (p.dead) { S.driftT = S.airT = 0; return; }
    // дрифт: держим занос, короткие паузы прощаются
    if (p.drift > 70 && v > 150 && !p.air) { S.driftT += dt; S.driftGap = 0; }
    else if (S.driftT > 0 && (S.driftGap += dt) > 0.35) {
      if (S.driftT >= 1.2) { pay(S.driftT * 22 * M.mult, `ДРИФТ ${S.driftT.toFixed(1)} с`); ui.sound('stunt'); }
      S.driftT = 0;
    }
    // прыжок
    if (p.air) S.airT += dt;
    else if (S.airT > 0) {
      if (S.airT > 0.45) { pay(S.airT * 140 * M.mult, `ПРЫЖОК ${S.airT.toFixed(1)} с`); ui.sound('stunt'); }
      S.airT = 0;
    }
    // впритирку: прошли рядом с машиной на скорости и не задели
    if (v > 330) for (const c of st.traffic) {
      if (c.nm || c.mode !== 'drive' || Math.abs(c.x - p.x) > 70 || Math.abs(c.y - p.y) > 70) continue;
      if (Math.hypot(c.x - p.x, c.y - p.y) < 52) { c.nm = true; S.near.push({ c, t: 0.4 }); }
    }
    for (const n of [...S.near]) {
      if ((n.t -= dt) > 0) continue;
      S.near.splice(S.near.indexOf(n), 1);
      if (n.c.mode === 'drive' && !p.dead) { pay(18 * M.mult, 'ВПРИТИРКУ'); ui.sound('stunt'); }
    }
  }

  // ---------------------------------------------------------------- наружу
  return {
    get money() { return M.money; },
    get mult() { return M.mult; },
    update(dt) {
      if (M.multT > 0 && (M.multT -= dt) <= 0) { M.mult = 1; ui.bonus('Двойные деньги закончились'); }
      updateStunts(dt);
      updatePickups(dt);
      updateOffers(dt);
      if (M.active) updateActive(dt);
      if ((M.evT -= dt) <= 0) { M.evT = 35 + Math.random() * 40; event(); }
    },
    onWreck() { if (M.active && M.active.type !== 'bomb') finish(false, 'Машина разбита'); },
    onBusted() { if (M.active) finish(false, 'Вас задержали'); },
    onRespawn() { if (M.active) finish(false, 'Задание брошено'); },
    // маркеры для 3D и мини-карты; первый — главная цель (для стрелки)
    markers() {
      const out = [], m = M.active;
      if (m) {
        if (m.dest) out.push({ kind: 'beam', x: m.dest.x, y: m.dest.y, r: 85, col: m.col, main: true });
        if (m.cps) for (let k = m.cp; k < Math.min(m.n, m.cp + 2); k++) out.push({ kind: 'beam', x: m.cps[k].x, y: m.cps[k].y, r: 95, col: m.col, k: k === m.cp ? 2.2 : 0.8, main: k === m.cp });
        if (m.targets) for (const c of m.targets) if (!c.dead) out.push({ kind: 'car', x: c.x, y: c.y, col: m.col, main: true });
      } else for (const o of M.offers) out.push({ kind: 'beam', x: o.x, y: o.y, r: 70, col: TYPES[o.type].col, offer: o.type });
      for (const k of M.pickups) out.push({ kind: 'pickup', x: k.x, y: k.y, r: PICK[k.kind].r, col: PICK[k.kind].col, k: 2.4 });
      return out;
    },
    // текст для панели HUD
    panel() {
      const m = M.active, p = P();
      if (!m) {
        let near = null, nd = 600;
        for (const o of M.offers) { const d = dist(o, p); if (d < nd) { nd = d; near = o; } }
        return near ? { title: TYPES[near.type].name, line: `Заказ: ${TYPES[near.type].about} — заезжайте в круг`, col: TYPES[near.type].col } : null;
      }
      const mk = this.markers().find((x) => x.main);
      const d = mk ? dist(mk, p) : 0;
      let line = '';
      if (m.type === 'taxi' || m.type === 'cargo') line = m.hint || `Цель: ${fmtDist(d)}` + (m.type === 'cargo' ? ` · груз ${Math.max(0, Math.round(100 - (m.hp0 - p.hp) * 5))}%` : '');
      else if (m.type === 'race') line = `Чекпоинт ${m.cp + 1}/${m.n} · ${fmtDist(d)}`;
      else if (m.type === 'hunt') line = `Осталось целей: ${m.targets.filter((c) => !c.dead).length} · ${fmtDist(d)}`;
      else if (m.type === 'escape') line = `Сбросьте розыск (${stars()}★)`;
      else if (m.type === 'drift') line = `Дрифт ${m.got.toFixed(1)} / ${m.need} с`;
      else if (m.type === 'bomb') line = m.armed ? (m.slowT > 0 ? `БЫСТРЕЕ! ${(1.5 - m.slowT).toFixed(1)} с` : 'Держите больше 80 км/ч') : 'Разгонитесь до 80 км/ч!';
      return { title: m.title, line, time: fmtTime(m.time), col: m.col, target: mk ? Math.atan2(mk.y - p.y, mk.x - p.x) : null, danger: m.type === 'bomb' && m.slowT > 0 };
    },
  };
}
