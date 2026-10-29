// Дождь: капли в мировых координатах с высотой и брызги на земле; рисует voxel.js.

export const rain = {
  on: true,
  k: 1,          // плавная интенсивность 0..1
  drops: [],
  splashes: [],
};

const MAX_DROPS = 900;
const FALL = 1500;     // скорость падения, ед/с
const TOP = 900;       // высота появления
const WIND = 120;

function spawn(d, cam, R, anyHeight) {
  d.x = cam.x + (Math.random() * 2 - 1) * R.x;
  d.y = cam.y + (Math.random() * 2 - 1) * R.y;
  d.h = anyHeight ? Math.random() * TOP : TOP * (0.7 + Math.random() * 0.3);
  d.v = FALL * (0.85 + Math.random() * 0.3);
}

export function updateRain(st, dt) {
  rain.k += ((rain.on ? 1 : 0) - rain.k) * Math.min(1, dt * 0.8);
  const R = { x: (st.W / 2 / st.cam.z) * 1.25, y: (st.H / 2 / st.cam.z) * 1.25 };
  const want = Math.round(MAX_DROPS * rain.k);
  while (rain.drops.length < want) { const d = {}; spawn(d, st.cam, R, true); rain.drops.push(d); }
  if (rain.drops.length > want) rain.drops.length = want;
  for (const d of rain.drops) {
    d.h -= d.v * dt;
    d.x += WIND * dt;
    if (d.h <= 0) {
      if (rain.splashes.length < 250 && Math.random() < 0.3) rain.splashes.push({ x: d.x, y: d.y, t: 0 });
      spawn(d, st.cam, R, false);
    } else if (Math.abs(d.x - st.cam.x) > R.x * 1.1 || Math.abs(d.y - st.cam.y) > R.y * 1.1) {
      spawn(d, st.cam, R, true);
    }
  }
  for (const s of rain.splashes) s.t += dt;
  rain.splashes = rain.splashes.filter((s) => s.t < 0.35);
}
