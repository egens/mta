// Москва из OpenStreetMap в натуральную величину (1 м = 10 единиц).
// Данные грузятся в браузере через Overpass API кусками 600×600 м вокруг машины,
// кэшируются в Cache Storage и превращаются в здания, дороги, воду, зелень, фонари и граф для трафика.
import { hash, hashU } from './util.js';

// ---------------------------------------------------------------- проекция
export const ORIGIN = { lat: 55.7539, lon: 37.6208 }; // Красная площадь
const U = 10; // единиц на метр
const KX = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180) * U;
const KY = 110574 * U;
export const project = (lat, lon) => [(lon - ORIGIN.lon) * KX, -(lat - ORIGIN.lat) * KY];
export const unproject = (x, y) => [ORIGIN.lat - y / KY, ORIGIN.lon + x / KX];

export const PLACES = [
  ['Тверская', 55.7652, 37.6050],
  ['Красная площадь', 55.7539, 37.6208],
  ['Москва-Сити', 55.7494, 37.5395],
  ['Садовое кольцо, Смоленская', 55.7489, 37.5833],
  ['Парк Горького', 55.7305, 37.6035],
  ['Лужники', 55.7158, 37.5537],
  ['ВДНХ', 55.8263, 37.6377],
  ['Арбат', 55.7495, 37.5925],
];

// ---------------------------------------------------------------- загрузка
const TILE = 6000;        // 600 м
const GC = 1500;          // кусок земли для текстуры (150 м)
const BIN = 1500;         // ячейка пространственного индекса
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const CACHE = 'mta-osm-v2';
const REQ_TIMEOUT = 60000;

const tiles = new Map();  // ключ -> { tx, ty, state, buildings, trees, signals }
const queue = [];
let active = 0, endpoint = 0;
export const status = { loading: 0, errors: 0, lastError: '', current: '', tilesReady: 0, since: 0 };

function bboxOf(tx, ty) {
  const [n, w] = unproject(tx * TILE, ty * TILE);
  const [s, e] = unproject((tx + 1) * TILE, (ty + 1) * TILE);
  return [s, w, n, e].map((v) => v.toFixed(6)).join(',');
}
// Пути и точки — с геометрией. Отношения (мультиполигоны рек, парков) бывают огромными
// и повторяются в каждом куске, поэтому здесь берём только их id, а геометрию — отдельно и один раз.
function query(b) {
  return `[out:json][timeout:50];(
way["building"](${b});
way["highway"](${b});
way["natural"~"^(water|wood|scrub|grassland|wetland)$"](${b});
way["waterway"~"^(riverbank|river|canal|stream|dock)$"](${b});
way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|cemetery|construction|railway|industrial|garages|allotments|flowerbed)$"](${b});
way["leisure"~"^(park|garden|pitch|playground|stadium|track|sports_centre)$"](${b});
way["amenity"="parking"](${b});
way["railway"~"^(rail|tram|light_rail|subway|narrow_gauge)$"](${b});
node["natural"="tree"](${b});node["highway"="traffic_signals"](${b});node["place"~"^(suburb|quarter|neighbourhood)$"](${b});
);out geom;
(relation["building"]["type"="multipolygon"](${b});relation["natural"~"^(water|wood)$"](${b});relation["waterway"="riverbank"](${b});
relation["landuse"~"^(grass|forest|recreation_ground|cemetery)$"](${b});relation["leisure"~"^(park|garden|stadium)$"](${b}););out tags;`;
}

const host = (u) => u.replace(/^https:\/\//, '').split('/')[0];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// запрос к Overpass с таймаутом и перебором зеркал
async function overpass(q, what) {
  let lastErr = null;
  for (let attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
    const url = ENDPOINTS[endpoint % ENDPOINTS.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
    status.current = `${what}: ${host(url)}`;
    status.since = performance.now();
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 429 ? ' (сервер перегружен)' : r.status === 504 ? ' (таймаут сервера)' : ''));
      const txt = await r.text();
      let json;
      try { json = JSON.parse(txt); } catch (e) { throw new Error('ответ не JSON'); }
      if (json.remark && /error/i.test(json.remark) && !(json.elements || []).length) throw new Error(json.remark.slice(0, 100));
      return { json, txt };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('нет ответа ' + REQ_TIMEOUT / 1000 + ' с') : e.message === 'Failed to fetch' || e.name === 'TypeError' ? new Error('сеть/CORS') : e;
      status.lastError = `${host(url)}: ${lastErr.message}`;
      console.warn('[OSM]', what, status.lastError);
      endpoint++;
      await sleep(600 + attempt * 500);
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}
async function cached(key, q, what) {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(key); if (hit) return await hit.json(); } catch (e) { cache = null; }
  const { json, txt } = await overpass(q, what);
  if (cache) cache.put(key, new Response(txt, { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
  return json;
}

function fetchTile(t) {
  return cached(`https://mta-osm.local/tile/${t.tx}_${t.ty}`, query(bboxOf(t.tx, t.ty)), `кусок ${t.tx},${t.ty}`);
}

// геометрия новых отношений — одним запросом и один раз на всю игру
const relWanted = new Set(), relLoaded = new Set();
async function loadRelations(t, ids) {
  const fresh = ids.filter((id) => !relWanted.has(id));
  if (!fresh.length) return;
  for (const id of fresh) relWanted.add(id);
  for (let i = 0; i < fresh.length; i += 40) {
    const part = fresh.slice(i, i + 40);
    try {
      const json = await cached(`https://mta-osm.local/rel/${part.join('_')}`, `[out:json][timeout:60];rel(id:${part.join(',')});out geom;`, 'реки и парки');
      ingestRelations(t, json.elements || []);
      for (const id of part) relLoaded.add(id);
    } catch (e) {
      for (const id of part) relWanted.delete(id);
    }
  }
}

function pump() {
  while (active < 2 && queue.length) {
    queue.sort((a, b) => a.prio - b.prio);
    const t = queue.shift();
    active++; status.loading++;
    fetchTile(t).then((json) => {
      const rels = ingest(t, json);
      t.state = 'ready'; status.tilesReady++; status.errors = 0;
      if (rels.length) loadRelations(t, rels);
    }).catch((e) => {
      t.state = 'error'; status.errors++; status.lastError = status.lastError || String(e && e.message || e);
      console.warn('[OSM] кусок не загружен', t.tx, t.ty, e);
      setTimeout(() => { t.state = 'new'; }, 6000);
    }).finally(() => { active--; status.loading--; status.current = ''; pump(); });
  }
}

// подгрузка кусков вокруг точки (и по ходу движения)
export function requestAround(x, y, vx = 0, vy = 0) {
  const ax = x + vx * 2, ay = y + vy * 2;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const [px, py] of [[x, y], [ax, ay]]) {
      const tx = Math.floor(px / TILE) + dx, ty = Math.floor(py / TILE) + dy;
      const key = tx + ',' + ty;
      let t = tiles.get(key);
      if (!t) { t = { tx, ty, state: 'new', buildings: [], trees: [], signals: [] }; tiles.set(key, t); }
      if (t.state === 'new') {
        t.state = 'queued';
        t.prio = Math.hypot((tx + 0.5) * TILE - x, (ty + 0.5) * TILE - y);
        queue.push(t);
      } else if (t.state === 'queued') t.prio = Math.hypot((tx + 0.5) * TILE - x, (ty + 0.5) * TILE - y);
    }
  }
  pump();
}
export const tileReady = (x, y) => { const t = tiles.get(Math.floor(x / TILE) + ',' + Math.floor(y / TILE)); return !!t && t.state === 'ready'; };
export function tilesIn(x0, y0, x1, y1) {
  const out = [];
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
    const t = tiles.get(tx + ',' + ty);
    if (t && t.state === 'ready') out.push(t);
  }
  return out;
}
const areaReady = (x0, y0, x1, y1) => {
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
    const t = tiles.get(tx + ',' + ty);
    if (!t || t.state !== 'ready') return false;
  }
  return true;
};

// ---------------------------------------------------------------- пространственный индекс
const bins = new Map();
function binAdd(kind, f, x0, y0, x1, y1) {
  for (let bx = Math.floor(x0 / BIN); bx <= Math.floor(x1 / BIN); bx++) for (let by = Math.floor(y0 / BIN); by <= Math.floor(y1 / BIN); by++) {
    const key = bx + ',' + by;
    let b = bins.get(key);
    if (!b) { b = { roads: [], water: [], areas: [], rails: [], paths: [], lamps: [], nodes: [], places: [] }; bins.set(key, b); }
    b[kind].push(f);
  }
}
function binQuery(kind, x0, y0, x1, y1) {
  const out = new Set();
  for (let bx = Math.floor(x0 / BIN); bx <= Math.floor(x1 / BIN); bx++) for (let by = Math.floor(y0 / BIN); by <= Math.floor(y1 / BIN); by++) {
    const b = bins.get(bx + ',' + by);
    if (b) for (const f of b[kind]) out.add(f);
  }
  return out;
}

// ---------------------------------------------------------------- разбор
const seenWays = new Set(), seenRels = new Set(), seenNodes = new Set();
export const graph = new Map(); // id узла -> { id, x, y, adj: Map(id -> { way, oneway }) , signal }
const signalIds = new Set();

const ROAD = {
  motorway: [24, 1, 'car'], trunk: [20, 1, 'car'], primary: [15, 2, 'car'], secondary: [13, 3, 'car'], tertiary: [11, 4, 'car'],
  motorway_link: [8, 5, 'car'], trunk_link: [8, 5, 'car'], primary_link: [8, 5, 'car'], secondary_link: [7.5, 5, 'car'], tertiary_link: [7, 5, 'car'],
  unclassified: [7, 6, 'car'], residential: [7, 6, 'car'], living_street: [6, 7, 'car'], service: [4.5, 8, 'car'], road: [6, 7, 'car'],
  pedestrian: [8, 9, 'walk'], footway: [2.5, 10, 'walk'], path: [2, 10, 'walk'], cycleway: [2.2, 10, 'walk'], steps: [2.5, 10, 'walk'], track: [3, 9, 'walk'],
};
const AREA_COL = {
  grass: '#3d5a31', park: '#3a5a2e', garden: '#3f5e30', recreation_ground: '#3d5a31', village_green: '#3d5a31', meadow: '#47613a',
  flowerbed: '#5a5a2e', forest: '#2a4a25', wood: '#2a4a25', scrub: '#3f5530', grassland: '#47613a', wetland: '#35503e', cemetery: '#3a4d34',
  allotments: '#4a5a34', pitch: '#3f6a34', playground: '#7c4636', stadium: '#56585a', track: '#7c4636', sports_centre: '#4f5154',
  construction: '#6b5536', railway: '#4a4744', industrial: '#4a4744', garages: '#4b4c50', parking: '#404145',
};
const GREEN = new Set(['grass', 'park', 'garden', 'recreation_ground', 'village_green', 'meadow', 'forest', 'wood', 'scrub', 'grassland', 'cemetery', 'allotments']);

function geomPts(geom) {
  const pts = [];
  for (const g of geom) { if (!g) continue; const [x, y] = project(g.lat, g.lon); pts.push(x, y); }
  return pts;
}
function bboxPts(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
  return { x0, y0, x1, y1 };
}
function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) a += pts[j] * pts[i + 1] - pts[i] * pts[j + 1];
  return a / 2;
}
export function pointInRings(rings, x, y) {
  let inside = false;
  for (const pts of rings) {
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
// замкнутое кольцо без повтора первой точки
function closeRing(pts) {
  if (pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < 0.01 && Math.abs(pts[1] - pts[pts.length - 1]) < 0.01) pts.length -= 2;
  return pts;
}
// склейка кусков мультиполигона в кольца
function assemble(members) {
  const segs = members.filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry.filter(Boolean).map((g) => [g.lat, g.lon])).filter((g) => g.length > 1);
  const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 2000) {
      const endK = key(ring[ring.length - 1]);
      const i = segs.findIndex((s) => key(s[0]) === endK || key(s[s.length - 1]) === endK);
      if (i < 0) break;
      let s = segs.splice(i, 1)[0];
      if (key(s[0]) !== endK) s = s.slice().reverse();
      ring = ring.concat(s.slice(1));
    }
    if (ring.length >= 4) rings.push(closeRing(geomPts(ring.map(([lat, lon]) => ({ lat, lon })))));
  }
  return rings;
}

function levelsHeight(tags, id) {
  if (tags.height) { const h = parseFloat(tags.height); if (h > 0) return h; }
  if (tags['building:levels']) { const l = parseFloat(tags['building:levels']); if (l > 0) return l * 3.2 + 1; }
  const r = hash(id % 1000003, 7, 3);
  switch (tags.building) {
    case 'house': case 'detached': case 'cabin': case 'hut': return 6 + r * 4;
    case 'garage': case 'garages': case 'shed': case 'kiosk': case 'roof': case 'service': return 3 + r;
    case 'industrial': case 'warehouse': case 'hangar': return 8 + r * 6;
    case 'church': case 'cathedral': return 16 + r * 10;
    case 'apartments': case 'residential': return 15 + r * 25;
    case 'office': case 'commercial': case 'retail': return 12 + r * 20;
    default: return 10 + r * 18;
  }
}
const WALLS = ['#2a2d35', '#2e2b28', '#262c36', '#30292a', '#2b3030', '#34302a'];
const ROOFS = ['#3a3d44', '#43414a', '#36393f', '#4a453f', '#3c4552', '#4b3a34'];

function addBuilding(t, rings, tags, id) {
  const outer = rings[0];
  if (!outer || outer.length < 6) return;
  if (tags.location === 'underground' || tags.building === 'construction' && !tags['building:levels']) { /* всё равно ставим как каркас */ }
  const bb = bboxPts(outer);
  const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
  // здание принадлежит куску, в котором его центр
  if (Math.floor(cx / TILE) !== t.tx || Math.floor(cy / TILE) !== t.ty) return;
  const h = levelsHeight(tags, id) * U;
  const minH = tags.min_height ? parseFloat(tags.min_height) * U : 0;
  // нормали рёбер наружу (для выталкивания машины)
  const ccw = signedArea(outer) > 0;
  const normals = [];
  for (let i = 0, j = outer.length - 2; i < outer.length; j = i, i += 2) {
    const ex = outer[i] - outer[j], ey = outer[i + 1] - outer[j + 1], l = Math.hypot(ex, ey) || 1;
    // при положительной площади (шнурование) наружу смотрит (ey, -ex)
    const s = ccw ? 1 : -1;
    normals.push((s * ey) / l, (-s * ex) / l);
  }
  const s = hashU(id % 1000003, 9, 1);
  t.buildings.push({
    id, pts: outer, holes: rings.slice(1), normals, x: bb.x0, y: bb.y0, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, cx, cy,
    z1: h, height: h, minH, kind: tags.building, name: tags.name,
    wall: tags['building:colour'] || WALLS[s % WALLS.length], roof: tags['roof:colour'] || ROOFS[(s >>> 4) % ROOFS.length],
    lit: tags.building === 'garage' || tags.building === 'garages' || tags.building === 'industrial' || tags.building === 'warehouse' ? 0.04 : 0.35, seed: s,
  });
}

function addRoad(w) {
  const tags = w.tags;
  if (tags.tunnel && tags.tunnel !== 'no' || tags.covered === 'yes' || tags.area === 'yes' || tags.highway === 'proposed' || tags.highway === 'construction') return;
  const def = ROAD[tags.highway];
  if (!def) return;
  let width = def[0];
  if (tags.lanes && def[2] === 'car') width = Math.max(width, parseFloat(tags.lanes) * 3.3 + 1);
  if (tags.width && parseFloat(tags.width) > 1) width = parseFloat(tags.width);
  const pts = geomPts(w.geometry);
  if (pts.length < 4) return;
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout' || tags.highway === 'motorway' ? 1 : tags.oneway === '-1' ? -1 : 0;
  const r = { id: w.id, pts, w: width * U, rank: def[1], kind: def[2], hw: tags.highway, bridge: !!tags.bridge && tags.bridge !== 'no', oneway, name: tags.name, lanes: parseFloat(tags.lanes) || 0 };
  const bb = bboxPts(pts);
  binAdd(def[2] === 'car' || tags.highway === 'pedestrian' ? 'roads' : 'paths', r, bb.x0 - r.w, bb.y0 - r.w, bb.x1 + r.w, bb.y1 + r.w);
  // граф для машин
  if (def[2] === 'car' && w.nodes && w.nodes.length === w.geometry.length) {
    for (let k = 0; k < w.nodes.length; k++) {
      const id = w.nodes[k];
      let n = graph.get(id);
      if (!n) {
        n = { id, x: pts[k * 2], y: pts[k * 2 + 1], adj: new Map(), signal: signalIds.has(id) };
        graph.set(id, n);
        binAdd('nodes', n, n.x, n.y, n.x, n.y);
      }
      if (k > 0) {
        const p = graph.get(w.nodes[k - 1]);
        if (oneway >= 0) p.adj.set(id, { road: r, fwd: true });
        if (oneway <= 0) n.adj.set(p.id, { road: r, fwd: false });
        // для полиции нужна связность и против одностороннего движения
        if (!p.nav) p.nav = new Set(); if (!n.nav) n.nav = new Set();
        p.nav.add(id); n.nav.add(p.id);
      }
    }
  }
  // фонари вдоль улиц и пешеходных зон
  if (def[2] === 'car' || tags.highway === 'pedestrian') {
    const step = 340, off = r.w / 2 + 14;
    let acc = (hashU(w.id % 1000003, 3, 3) % 1000) / 1000 * step, side = 1;
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      let t = step - acc;
      while (t < len) {
        const px = ax + ux * t, py = ay + uy * t;
        const nx = -uy * side, ny = ux * side;
        const l = { x: px + nx * off, y: py + ny * off, lx: px + nx * (off - 22), ly: py + ny * (off - 22), r: r.w > 130 ? 150 : 128, c: r.rank <= 2 ? 'white' : hash(w.id % 1000003, 5) < 0.35 ? 'sodium' : 'white', i: 0.85, pole: true, broken: false, road: r };
        binAdd('lamps', l, l.x, l.y, l.x, l.y);
        side = -side;
        t += step;
      }
      acc = (acc + len) % step;
    }
  }
}

function addArea(rings, tags, id) {
  const kind = tags.leisure || tags.landuse || tags.natural || tags.amenity;
  const col = AREA_COL[kind];
  if (!col || !rings.length) return;
  const bb = bboxPts(rings[0]);
  binAdd('areas', { id, rings, col, kind, green: GREEN.has(kind), bb }, bb.x0, bb.y0, bb.x1, bb.y1);
}
function addWater(rings, id) {
  if (!rings.length) return;
  let bb = bboxPts(rings[0]);
  for (const r of rings) { const b = bboxPts(r); bb = { x0: Math.min(bb.x0, b.x0), y0: Math.min(bb.y0, b.y0), x1: Math.max(bb.x1, b.x1), y1: Math.max(bb.y1, b.y1) }; }
  binAdd('water', { id, rings, bb }, bb.x0, bb.y0, bb.x1, bb.y1);
}

function ingest(t, json) {
  const els = json.elements || [];
  // сначала узлы-светофоры, чтобы граф о них знал
  for (const e of els) if (e.type === 'node' && e.tags && e.tags.highway === 'traffic_signals') {
    signalIds.add(e.id);
    const n = graph.get(e.id); if (n) n.signal = true;
  }
  const rels = [];
  for (const e of els) {
    try { ingestOne(t, e, rels); } catch (err) { console.warn('[OSM] пропущен элемент', e.type, e.id, err); }
  }
  scatterTrees(t);
  return rels;
}

function ingestRelations(t, els) {
  for (const e of els) {
    if (e.type !== 'relation' || !e.members) continue;
    try { ingestOne(tiles.get(Math.floor(t.tx) + ',' + Math.floor(t.ty)) || t, e, null); } catch (err) { console.warn('[OSM] пропущено отношение', e.id, err); }
  }
  // здания-мультиполигоны принадлежат куску по центру, остальное (вода, парки) — общее
  for (const tt of tiles.values()) if (tt.state === 'ready') scatterTrees(tt);
  markDirty();
}

function ingestOne(t, e, rels) {
    const tags = e.tags || {};
    if (e.type === 'node') {
      if (seenNodes.has(e.id)) return;
      seenNodes.add(e.id);
      const [x, y] = project(e.lat, e.lon);
      if (Math.floor(x / TILE) !== t.tx || Math.floor(y / TILE) !== t.ty) { seenNodes.delete(e.id); return; }
      if (tags.natural === 'tree') t.trees.push({ x, y, r: 16 + hash(e.id % 1000003, 2) * 10, kind: hash(e.id % 1000003, 3) < 0.2 ? 1 : 0, v: e.id % 4 });
      else if (tags.highway === 'traffic_signals') t.signals.push({ x, y, id: e.id });
      else if (tags.place && tags.name) binAdd('places', { x, y, name: tags.name }, x, y, x, y);
      return;
    }
    if (e.type === 'way') {
      if (tags.building) { if (e.geometry) addBuilding(t, [closeRing(geomPts(e.geometry))], tags, e.id); return; }
      if (seenWays.has(e.id)) return;
      seenWays.add(e.id);
      if (!e.geometry) return;
      if (tags.highway) addRoad(e);
      else if (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.waterway === 'dock') addWater([closeRing(geomPts(e.geometry))], e.id);
      else if (tags.waterway) {
        const pts = geomPts(e.geometry), bb = bboxPts(pts);
        const w = tags.waterway === 'river' ? 0 : tags.waterway === 'canal' ? 80 : 30;
        if (w) binAdd('rails', { pts, water: true, w, id: e.id }, bb.x0 - w, bb.y0 - w, bb.x1 + w, bb.y1 + w);
      } else if (tags.railway) {
        if (tags.tunnel && tags.tunnel !== 'no') return;
        const pts = geomPts(e.geometry), bb = bboxPts(pts);
        binAdd('rails', { pts, tram: tags.railway === 'tram', bridge: !!tags.bridge, id: e.id }, bb.x0 - 40, bb.y0 - 40, bb.x1 + 40, bb.y1 + 40);
      } else addArea([closeRing(geomPts(e.geometry))], tags, e.id);
      return;
    }
    if (e.type === 'relation') {
      // в запросе куска у отношений нет геометрии — запомним id и догрузим отдельно
      if (!e.members) { if (rels && !relLoaded.has(e.id)) rels.push(e.id); return; }
      if (tags.building) {
        const rings = assemble(e.members.filter((m) => m.role === 'outer')).concat(assemble(e.members.filter((m) => m.role === 'inner')));
        if (rings[0]) {
          const bb = bboxPts(rings[0]);
          const owner = tiles.get(Math.floor((bb.x0 + bb.x1) / 2 / TILE) + ',' + Math.floor((bb.y0 + bb.y1) / 2 / TILE));
          if (owner && owner.state === 'ready' && !owner.relB?.has(e.id)) { (owner.relB ||= new Set()).add(e.id); addBuilding(owner, rings, tags, e.id); owner.coll = null; owner.ver = (owner.ver || 0) + 1; }
        }
        return;
      }
      if (seenRels.has(e.id)) return;
      seenRels.add(e.id);
      const rings = assemble(e.members);
      if (tags.natural === 'water' || tags.waterway === 'riverbank') addWater(rings, e.id);
      else addArea(rings, tags, e.id);
    }
}

// деревья в парках и лесах (в OSM их обычно нет): сажаем в пределах куска, детерминированно
function scatterTrees(t) {
  const X0 = t.tx * TILE, Y0 = t.ty * TILE, X1 = X0 + TILE, Y1 = Y0 + TILE;
  let added = false;
  for (const a of binQuery('areas', X0, Y0, X1, Y1)) {
    if (!a.green) continue;
    const key = t.tx + ',' + t.ty;
    if ((a.done ||= new Set()).has(key)) continue;
    a.done.add(key);
    const x0 = Math.max(X0, a.bb.x0), y0 = Math.max(Y0, a.bb.y0), x1 = Math.min(X1, a.bb.x1), y1 = Math.min(Y1, a.bb.y1);
    if (x1 <= x0 || y1 <= y0) continue;
    const dense = a.kind === 'forest' || a.kind === 'wood' ? 1 / 9000 : 1 / 26000;
    const n = Math.min(300, Math.floor((x1 - x0) * (y1 - y0) * dense));
    const sid = (a.id + t.tx * 7919 + t.ty * 104729) % 1000003;
    for (let k = 0; k < n; k++) {
      const x = x0 + hash(sid, k, 11) * (x1 - x0), y = y0 + hash(sid, k, 12) * (y1 - y0);
      if (!pointInRings(a.rings, x, y) || nearRoad(x, y, 30)) continue;
      t.trees.push({ x, y, r: 14 + hash(sid, k, 13) * 14, kind: a.kind === 'forest' || a.kind === 'wood' ? (hash(k, 4) < 0.5 ? 1 : 0) : (hash(k, 5) < 0.15 ? 1 : 0), v: k % 4 });
      added = true;
    }
  }
  if (added) { t.coll = null; t.ver = (t.ver || 0) + 1; }
}

// после догрузки рек и парков текстуры земли нужно перерисовать
export let groundEpoch = 0;
function markDirty() { groundEpoch++; for (const ch of groundCache.values()) ch.canvas = null; }

// ---------------------------------------------------------------- запросы для игры
function distSeg(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2));
  return Math.hypot(px - ax - ex * t, py - ay - ey * t);
}
export function nearRoad(x, y, extra = 0, onlyBridge = false) {
  for (const r of binQuery('roads', x - 1, y - 1, x + 1, y + 1)) {
    if (onlyBridge && !r.bridge) continue;
    const p = r.pts;
    for (let i = 2; i < p.length; i += 2) if (distSeg(x, y, p[i - 2], p[i - 1], p[i], p[i + 1]) < r.w / 2 + extra) return r;
  }
  return null;
}
export function isWater(x, y) {
  for (const w of binQuery('water', x - 1, y - 1, x + 1, y + 1)) {
    if (x < w.bb.x0 || x > w.bb.x1 || y < w.bb.y0 || y > w.bb.y1) continue;
    if (pointInRings(w.rings, x, y)) return !nearRoad(x, y, 12, true);
  }
  return false;
}
export function district(x, y) {
  let best = null, bd = 9000;
  for (const p of binQuery('places', x - 9000, y - 9000, x + 9000, y + 9000)) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = p.name; }
  }
  return best || 'Москва';
}
export function nearestNode(x, y, R = 1500) {
  let best = null, bd = Infinity;
  for (const n of binQuery('nodes', x - R, y - R, x + R, y + R)) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd && n.adj.size + (n.nav ? n.nav.size : 0) > 0) { bd = d; best = n; }
  }
  return best;
}
export const nodesIn = (x0, y0, x1, y1) => binQuery('nodes', x0, y0, x1, y1);
export const roadsIn = (x0, y0, x1, y1) => binQuery('roads', x0, y0, x1, y1);
export const pathsIn = (x0, y0, x1, y1) => binQuery('paths', x0, y0, x1, y1);
export const areasIn = (x0, y0, x1, y1) => binQuery('areas', x0, y0, x1, y1);
export const waterIn = (x0, y0, x1, y1) => binQuery('water', x0, y0, x1, y1);
export const railsIn = (x0, y0, x1, y1) => binQuery('rails', x0, y0, x1, y1);
export const lampsIn = (x0, y0, x1, y1) => binQuery('lamps', x0, y0, x1, y1);

// карта для физики и полиции (тот же интерфейс, что procmap.js)
export const osmMap = {
  surfaceAt: () => 0,
  isWater,
  collidersNear(x0, y0, x1, y1, out) {
    for (const t of tilesIn(x0 - 3000, y0 - 3000, x1 + 3000, y1 + 3000)) {
      if (!t.coll) t.coll = { polys: t.buildings.filter((b) => b.minH < 40), circles: t.trees.map((tr) => ({ x: tr.x, y: tr.y, r: tr.r * 0.35, z1: 40 })) };
      out.push(t.coll);
    }
    return out;
  },
  lampsNear(x0, y0, x1, y1, cb) { for (const l of lampsIn(x0, y0, x1, y1)) cb(l); },
  nav: {
    nearest(x, y) { const n = nearestNode(x, y); return n ? n.id : null; },
    pos(id) { const n = graph.get(id); return n ? [n.x, n.y] : [0, 0]; },
    neighbors(id) { const n = graph.get(id); return n && n.nav ? [...n.nav] : []; },
  },
  roadSpawn(x, y, dmin, dmax) {
    const R = dmax;
    const cand = [...nodesIn(x - R, y - R, x + R, y + R)].filter((n) => { const d = Math.hypot(n.x - x, n.y - y); return d > dmin && d < dmax && n.adj.size; });
    if (!cand.length) return null;
    const n = cand[(Math.random() * cand.length) | 0];
    const [nid, e] = [...n.adj][0];
    const m = graph.get(nid);
    return [n.x, n.y, Math.atan2(m.y - n.y, m.x - n.x)];
  },
  district,
  ready: tileReady,
};

// ---------------------------------------------------------------- земля: текстура куска 150×150 м
export const GROUND = GC;
const groundCache = new Map();
export function groundChunk(gx, gy) {
  const key = gx + ',' + gy;
  let ch = groundCache.get(key);
  if (ch && ch.canvas) return ch;
  const x0 = gx * GC, y0 = gy * GC;
  if (!areaReady(x0 - 400, y0 - 400, x0 + GC + 400, y0 + GC + 400)) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const g = cv.getContext('2d');
  const k = 512 / GC;
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.fillStyle = '#46474b';
  g.fillRect(x0, y0, GC, GC);
  const X0 = x0 - 300, Y0 = y0 - 300, X1 = x0 + GC + 300, Y1 = y0 + GC + 300;
  const ring = (pts) => { g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); };
  const line = (pts) => { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.stroke(); };
  // зелень, площадки
  const areas = [...areasIn(X0, Y0, X1, Y1)].sort((a, b) => (a.green ? 0 : 1) - (b.green ? 0 : 1));
  for (const a of areas) {
    g.beginPath(); for (const r of a.rings) ring(r);
    g.fillStyle = a.col; g.fill('evenodd');
    if (a.kind === 'pitch') { g.strokeStyle = 'rgba(230,230,220,0.7)'; g.lineWidth = 6; g.stroke(); }
  }
  // вода
  for (const w of waterIn(X0, Y0, X1, Y1)) {
    g.beginPath(); for (const r of w.rings) ring(r);
    g.fillStyle = '#10304a'; g.fill('evenodd');
    g.strokeStyle = '#77736c'; g.lineWidth = 14; g.stroke();
  }
  const rails = [...railsIn(X0, Y0, X1, Y1)];
  for (const r of rails) if (r.water) { g.strokeStyle = '#10304a'; g.lineWidth = r.w; line(r.pts); }
  for (const r of rails) if (!r.water && !r.tram) { g.strokeStyle = '#57524a'; g.lineWidth = 40; line(r.pts); }
  // дорожки
  for (const p of pathsIn(X0, Y0, X1, Y1)) { g.strokeStyle = '#6f6a62'; g.lineWidth = p.w; line(p.pts); }
  // дороги: тротуары, асфальт, разметка
  const roads = [...roadsIn(X0, Y0, X1, Y1)].sort((a, b) => b.rank - a.rank);
  for (const r of roads) {
    if (r.bridge) { g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = r.w + 60; g.save(); g.translate(14, 12); line(r.pts); g.restore(); }
    g.strokeStyle = r.hw === 'pedestrian' ? '#7a746b' : '#5c5e62';
    g.lineWidth = r.w + (r.hw === 'service' ? 10 : 50);
    line(r.pts);
    if (r.bridge) { g.strokeStyle = '#a4a6aa'; g.lineWidth = 4; g.save(); g.setLineDash([]); line(r.pts); g.restore(); }
  }
  for (const r of roads) if (r.hw !== 'pedestrian') { g.strokeStyle = '#2d2f34'; g.lineWidth = r.w; line(r.pts); }
  for (const r of roads) {
    if (r.hw === 'pedestrian' || r.w < 60) continue;
    g.strokeStyle = 'rgba(214,214,204,0.85)';
    if (r.oneway) continue;
    g.lineWidth = 3;
    if (r.w >= 110) line(r.pts);
    else { g.setLineDash([30, 30]); line(r.pts); g.setLineDash([]); }
  }
  for (const r of rails) if (r.tram) { g.strokeStyle = '#8a8c90'; g.lineWidth = 2; for (const o of [-7, 7]) { g.save(); g.translate(o * 0.7, o * 0.7); line(r.pts); g.restore(); } }
  for (const r of rails) if (!r.water && !r.tram) { g.strokeStyle = '#a2a2aa'; g.lineWidth = 2.5; line(r.pts); }
  const blds = [];
  for (const t of tilesIn(x0 - 3000, y0 - 3000, x0 + GC + 3000, y0 + GC + 3000)) for (const b of t.buildings) if (b.x < x0 + GC + 20 && b.x + b.w > x0 - 20 && b.y < y0 + GC + 20 && b.y + b.h > y0 - 20) blds.push(b);
  const inBuilding = (x, y) => blds.some((b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h && pointInRings([b.pts], x, y));
  const lamps = [...lampsIn(x0, y0, x0 + GC, y0 + GC)].filter((l) => l.x >= x0 && l.x < x0 + GC && l.y >= y0 && l.y < y0 + GC && !l.dead
    && !(l.dead = isWater(l.x, l.y) || inBuilding(l.x, l.y) || inBuilding(l.lx, l.ly)));
  ch = { gx, gy, x0, y0, size: GC, canvas: cv, lamps };
  groundCache.set(key, ch);
  return ch;
}
export function groundLampsAround(x0, y0, x1, y1) { return [...lampsIn(x0, y0, x1, y1)]; }
export function releaseGround(ch) { ch.canvas = null; }
