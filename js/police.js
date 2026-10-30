// Розыск и погоня: «звёзды» за хулиганство, полицейские машины с той же физикой,
// что и у игрока, едут по улицам к игроку и таранят его. Если стоять рядом с копом — арест.
import { MAP } from './map.js';
import { createPlayer, updatePlayer, collideStatic, collideCars, collideDyn } from './car.js';

export const police = { heat: 0, cops: [], calm: 0, bustT: 0, spawnT: 0 };

export const stars = () => Math.min(5, Math.floor(police.heat));
export function addHeat(v) {
  police.heat = Math.min(5.99, police.heat + v);
  police.calm = 0;
}
export function clearHeat() {
  police.heat = 0; police.calm = 0; police.bustT = 0;
  for (const c of police.cops) c.leave = true;
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function copSt(st, cop) {
  return {
    skids: st.skids, fx: st.fx, trains: st.trains,
    onImpact() {},
    onDamage() {},
    onWreck() { cop.wreck = true; st.fx.push({ type: 'sparks', x: cop.x, y: cop.y, n: 30 }); addHeat(0.6); },
    onLampBreak(l, sp) { st.onLampBreak(l, sp, false); },
    onPaneBreak(p, c) { st.onPaneBreak(p, c, false); },
  };
}

function spawnCop(st) {
  const P = st.player;
  const sp = MAP.impl.roadSpawn(P.x, P.y, 1300, 1900);
  if (!sp) return;
  const [x, y, a] = sp;
  const c = createPlayer(x, y, a);
  c.cop = true; c.kind = 'police'; c.color = '#e8e8ee'; c.police = true; c.L = 48; c.W = 22;
  c.power = 0.86 + stars() * 0.04;
  c.stuckT = 0; c.revT = 0; c.wp = null; c.next = null; c.prev = null; c.wreck = false; c.leave = false;
  c.st = copSt(st, c);
  police.cops.push(c);
}

// соседний узел дорожного графа, который ближе всего к игроку
function stepToward(k, P, from) {
  const nav = MAP.impl.nav;
  let best = null, bd = Infinity;
  for (const n of nav.neighbors(k)) {
    if (n === from) continue;
    const [x, y] = nav.pos(n);
    const dd = Math.hypot(x - P.x, y - P.y);
    if (dd < bd) { bd = dd; best = n; }
  }
  return best || from;
}

// Цель: рядом — сам игрок, далеко — следующий перекрёсток по улицам.
// Третье значение — расстояние до поворота впереди, чтобы успеть затормозить.
function target(c, P) {
  const nav = MAP.impl.nav;
  const d = Math.hypot(P.x - c.x, P.y - c.y);
  if (d < 360) { c.wp = null; return [P.x + P.vx * 0.35, P.y + P.vy * 0.35, Infinity]; }
  if (!c.wp) { c.wp = nav.nearest(c.x, c.y); c.next = null; }
  if (c.wp === null) return [P.x, P.y, Infinity];
  let [wx, wy] = nav.pos(c.wp);
  if (Math.hypot(wx - c.x, wy - c.y) < 45) {
    const nxt = c.next || stepToward(c.wp, P, c.prev);
    c.prev = c.wp; c.wp = nxt; c.next = null;
    [wx, wy] = nav.pos(c.wp);
  }
  if (!c.next) c.next = stepToward(c.wp, P, c.prev);
  const [nx, ny] = nav.pos(c.next);
  const a1 = Math.atan2(wy - c.y, wx - c.x), a2 = Math.atan2(ny - wy, nx - wx);
  const turn = Math.abs(wrap(a2 - a1));
  return [wx, wy, turn > 0.5 ? Math.hypot(wx - c.x, wy - c.y) : Infinity];
}

export function updatePolice(st, dt) {
  const P = st.player;
  const s = stars();
  // остывание: если копов рядом нет, звёзды гаснут
  const near = police.cops.some((c) => !c.wreck && !c.leave && Math.hypot(c.x - P.x, c.y - P.y) < 700);
  if (police.heat > 0) {
    police.calm += dt;
    if (police.heat < 1) police.heat = Math.max(0, police.heat - dt * 0.08);
    else if (!near && police.calm > 12) { police.heat = Math.max(0, Math.floor(police.heat) - 0.01); police.calm = 0; }
    if (police.heat <= 0) clearHeat();
  }
  // подкрепление
  const want = s > 0 ? Math.min(8, s * 2) : 0;
  const active = police.cops.filter((c) => !c.leave && !c.wreck).length;
  police.spawnT -= dt;
  if (active < want && police.spawnT <= 0) { spawnCop(st); police.spawnT = 1.2; }

  for (const c of police.cops) {
    if (c.wreck) { c.dead = true; updatePlayer(c, {}, dt, c.st); collideStatic(c, c.st, false); continue; }
    const inp = { up: false, down: false, left: false, right: false, hand: false };
    const [tx, ty, turnDist] = c.leave ? [c.x + Math.cos(c.a) * 500, c.y + Math.sin(c.a) * 500, Infinity] : target(c, P);
    const diff = wrap(Math.atan2(ty - c.y, tx - c.x) - c.a);
    const sp = Math.hypot(c.vx, c.vy);
    if (c.revT > 0) {
      c.revT -= dt;
      inp.down = true;
      inp.left = diff > 0; inp.right = diff < 0;
    } else {
      inp.up = true;
      inp.left = diff < -0.07; inp.right = diff > 0.07;
      if (Math.abs(diff) > 0.9 && sp > 220) { inp.up = false; inp.down = true; }
      // впереди поворот на перекрёстке — сбрасываем скорость
      if (turnDist < sp * 0.55 + 40 && sp > 170) { inp.up = false; inp.down = true; }
      if (Math.abs(diff) > 1.3 && sp > 140) inp.hand = true;
      if (sp < 25) c.stuckT += dt; else c.stuckT = 0;
      if (c.stuckT > 1.1) { c.revT = 0.9; c.stuckT = 0; c.wp = null; c.next = null; c.stuckN = (c.stuckN || 0) + 1; }
      if (sp > 120) c.stuckN = 0;
    }
    updatePlayer(c, inp, dt, c.st);
    collideStatic(c, c.st, false);
    collideCars(c, st.traffic, c.st);
    // таран игрока
    const hit = collideDyn(P, c, st, c.st);
    if (hit > 60) { st.onImpact(hit, (P.x + c.x) / 2, (P.y + c.y) / 2, true); addHeat(0.08); }
  }
  // копы между собой
  for (let a = 0; a < police.cops.length; a++) for (let b = a + 1; b < police.cops.length; b++) collideDyn(police.cops[a], police.cops[b], null, null);
  // уехавшие и далёкие исчезают
  police.cops = police.cops.filter((c) => {
    const d = Math.hypot(c.x - P.x, c.y - P.y);
    if (c.leave || c.wreck) return d < 2200;
    if (d > 4000) return false;
    // безнадёжно застрявший вдали — убираем, вместо него приедет новый
    if ((c.stuckN || 0) >= 4 && d > 900) return false;
    return true;
  });
  // арест: игрок стоит, рядом коп
  if (s > 0 && !P.dead) {
    const close = police.cops.some((c) => !c.wreck && !c.leave && Math.hypot(c.x - P.x, c.y - P.y) < 75);
    if (close && Math.hypot(P.vx, P.vy) < 30) police.bustT += dt; else police.bustT = Math.max(0, police.bustT - dt * 2);
    if (police.bustT > 2.5) { police.bustT = 0; st.onBusted(); }
  } else police.bustT = 0;
}

// ближайший коп с мигалкой — для сирены
export function sirenLevel(P) {
  let best = 0;
  for (const c of police.cops) {
    if (c.wreck || c.leave) continue;
    const d = Math.hypot(c.x - P.x, c.y - P.y);
    best = Math.max(best, Math.max(0, 1 - d / 1600));
  }
  return best;
}

