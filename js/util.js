// Детерминированные хэши, ГПСЧ, шум и мелкая математика.

export const SEED = 0x5eed1234;

export function hashU(a, b = 0, c = 0) {
  let h = SEED ^ Math.imul(a | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash(a, b = 0, c = 0) {
  return hashU(a, b, c) / 4294967296;
}

export function rng(seed) {
  let s = seed >>> 0;
  const f = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (a, b) => a + f() * (b - a);
  f.int = (a, b) => a + Math.floor(f() * (b - a + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  return f;
}

const smooth = (t) => t * t * (3 - 2 * t);

export function noise1(x, s = 0) {
  const i = Math.floor(x);
  const f = x - i;
  return lerp(hash(i, s, 77), hash(i + 1, s, 77), smooth(f));
}

export function noise2(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s);
  const c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

export function fbm2(x, y, s = 0) {
  return (noise2(x, y, s) * 0.6 + noise2(x * 2.1, y * 2.1, s + 1) * 0.28 + noise2(x * 4.3, y * 4.3, s + 2) * 0.12);
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
