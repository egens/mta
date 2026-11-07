// Мастерские «Неон-тюн»: куда тратить деньги. Ремонт, двигатель, броня, нитро, покраска
// и «отмывка» розыска. Мастерские стоят у обочины отдельных кварталов (белые столбы света);
// заехать в круг на малой скорости — открывается меню, игра на паузе. Улучшения хранятся в браузере.
import * as W from './world.js';
import { hash } from './util.js';
import { repairPlayer } from './car.js';
import { stars, clearHeat } from './police.js';

const KEY = 'mta-garage';
const ENGINE = [0, 1500, 4000, 9000];      // цена уровня; мощность +12% за уровень
const ARMOR = [0, 1200, 3500, 8000];       // урон ×0.8 / 0.62 / 0.45
const ARMOR_K = [1, 0.8, 0.62, 0.45];
const NITRO_PRICE = 5000;
const PAINT_PRICE = 400;
export const PAINTS = [['Алый', '#d8262a'], ['Неон-розовый', '#ff3fc8'], ['Циан', '#18d8f0'], ['Кислотный', '#9cff2a'],
  ['Хром', '#c8ccd4'], ['Чёрный мат', '#1c1c22'], ['Золото', '#e0b030'], ['Фиолет', '#7a3aff']];
const COL = '#f0f0ff';

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
function save(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* без сохранений */ } }

// мастерская на правой кромке улицы-колонки i посреди квартала между строками j и j+1
function garageAt(i, j) {
  if (hash(i, j, 505) > 0.08 || !W.vSegExists(i, j)) return null;
  const x = W.roadX(i) + W.widthX(i) / 2 - 16, y = (W.roadY(j) + W.roadY(j + 1)) / 2;
  if (W.riverDist(x, y) < 150 || W.diagsInRect(x - 120, y - 120, x + 120, y + 120, 60).length) return null;
  return { x, y, i, j };
}

export function createShop(st, ui) {
  const up = Object.assign({ engine: 0, armor: 0, nitro: false, paint: 0 }, load());
  let open = false, inside = null, sel = 0;
  const el = document.getElementById('shop');

  function apply() {
    const P = st.player;
    P.power = 1 + 0.12 * up.engine;
    P.armor = ARMOR_K[up.armor];
    P.nitro = up.nitro;
    if (P.nitroT === undefined) P.nitroT = 3;
    P.color = PAINTS[up.paint][1];
  }
  apply();

  function items() {
    const P = st.player, s = stars();
    const fix = Math.ceil((100 - P.hp) * 8);
    const list = [
      { name: 'Ремонт', about: P.hp >= 100 ? 'машина цела' : `восстановить ${Math.round(100 - P.hp)}% корпуса`, price: fix, off: fix <= 0,
        buy() { repairPlayer(P); apply(); } },
      { name: `Двигатель ${up.engine < 3 ? up.engine + 1 : 3}/3`, about: up.engine < 3 ? `+12% мощности и максималки` : 'максимальный уровень',
        price: ENGINE[up.engine + 1] || 0, off: up.engine >= 3, buy() { up.engine++; } },
      { name: `Броня ${up.armor < 3 ? up.armor + 1 : 3}/3`, about: up.armor < 3 ? `урон от ударов ×${ARMOR_K[up.armor + 1]}` : 'максимальный уровень',
        price: ARMOR[up.armor + 1] || 0, off: up.armor >= 3, buy() { up.armor++; } },
      { name: 'Нитро', about: up.nitro ? 'установлено — Shift для ускорения' : 'Shift — рывок на 3 с, баллон сам заправляется',
        price: NITRO_PRICE, off: up.nitro, buy() { up.nitro = true; } },
      ...(ui.run && ui.run.target() ? [(() => {
        const h = ui.run.target(), price = 600 + 400 * h.k;
        return { name: `Наводка: «${h.name}»`, about: `сузить зону поиска штаба (${h.state.intel}/3)`, price, off: false, buy() { ui.run.intel('shop'); } };
      })()] : []),
      { name: 'Отмыть розыск', about: s ? `убрать ${s}★ — номера перебьют, полиция потеряет след` : 'вас никто не ищет',
        price: 350 * s, off: !s, buy() { clearHeat(); } },
    ];
    PAINTS.forEach(([name, c], k) => list.push({ name: `Покраска: ${name}`, swatch: c, about: k === up.paint ? 'текущий цвет' : 'перекрасить кузов',
      price: PAINT_PRICE, off: k === up.paint, buy() { up.paint = k; } }));
    return list;
  }

  function render() {
    const list = items();
    sel = Math.min(sel, list.length - 1);
    el.innerHTML = '';
    const h = document.createElement('h2'); h.textContent = 'МАСТЕРСКАЯ «НЕОН-ТЮН»';
    const m = document.createElement('div'); m.className = 'cash'; m.textContent = `${ui.money().toLocaleString('ru-RU')} ₽`;
    el.append(h, m);
    const ul = document.createElement('div'); ul.className = 'items';
    list.forEach((it, k) => {
      const row = document.createElement('div');
      const poor = !it.off && it.price > ui.money();
      row.className = 'it' + (k === sel ? ' sel' : '') + (it.off ? ' off' : '') + (poor ? ' poor' : '');
      const sw = document.createElement('i'); if (it.swatch) sw.style.background = it.swatch;
      const t = document.createElement('div'); t.className = 't';
      const b = document.createElement('b'); b.textContent = it.name;
      const s = document.createElement('span'); s.textContent = it.about;
      t.append(b, s);
      const p = document.createElement('em'); p.textContent = it.off ? '—' : `${it.price.toLocaleString('ru-RU')} ₽`;
      row.append(sw, t, p);
      row.addEventListener('pointerdown', (e) => { e.stopPropagation(); sel = k; buy(); });
      ul.append(row);
    });
    const f = document.createElement('div'); f.className = 'foot';
    f.textContent = '↑ ↓ — выбор · Enter — купить · Esc — уехать';
    const out = document.createElement('button'); out.textContent = 'УЕХАТЬ';
    out.addEventListener('pointerdown', (e) => { e.stopPropagation(); close(); });
    el.append(ul, f, out);
  }

  function buy() {
    const it = items()[sel];
    if (!it || it.off) return;
    if (!ui.spend(it.price)) { ui.sound('fail'); ui.toast('Не хватает денег'); return; }
    it.buy();
    save(up);
    apply();
    ui.sound('win');
    render();
  }
  function close() { open = false; el.classList.add('hidden'); }

  return {
    get open() { return open; },
    update() {
      const P = st.player;
      const near = this.nearest(120);
      if (inside && (!near || near.i !== inside.i || near.j !== inside.j)) inside = null;
      if (open || inside || !near || P.dead) return;
      if (Math.hypot(near.x - P.x, near.y - P.y) < 75 && Math.hypot(P.vx, P.vy) < 110) {
        inside = near; open = true; sel = P.hp < 100 ? 0 : 1;
        P.vx = P.vy = 0;
        el.classList.remove('hidden');
        ui.sound('start');
        render();
      }
    },
    key(code) {
      const n = items().length;
      if (code === 'ArrowDown' || code === 'KeyS') sel = (sel + 1) % n;
      else if (code === 'ArrowUp' || code === 'KeyW') sel = (sel + n - 1) % n;
      else if (code === 'Enter' || code === 'Space') { buy(); return; }
      else if (code === 'Escape' || code === 'Backspace' || code === 'KeyQ') { close(); return; }
      render();
    },
    nearest(R) {
      const P = st.player;
      let best = null, bd = R;
      for (let i = W.colAt(P.x - R) - 1; i <= W.colAt(P.x + R) + 1; i++) for (let j = W.rowAt(P.y - R) - 1; j <= W.rowAt(P.y + R); j++) {
        const g = garageAt(i, j);
        if (!g) continue;
        const d = Math.hypot(g.x - P.x, g.y - P.y);
        if (d < bd) { bd = d; best = g; }
      }
      return best;
    },
    // маркеры мастерских вокруг для 3D и мини-карты
    markers() {
      const P = st.player, out = [], R = 2600;
      for (let i = W.colAt(P.x - R); i <= W.colAt(P.x + R) + 1; i++) for (let j = W.rowAt(P.y - R); j <= W.rowAt(P.y + R); j++) {
        const g = garageAt(i, j);
        if (g) out.push({ kind: 'shop', x: g.x, y: g.y, r: 75, col: COL, k: 1.6 });
      }
      return out;
    },
  };
}
