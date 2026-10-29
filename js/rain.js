// Дождь: капли в мировых координатах с высотой, брызги на земле.
// Используется обоими режимами графики.

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

// 2D: проекция как у зданий — чем выше, тем дальше от центра экрана
export function drawRain2D(ctx, st, Hc) {
  if (rain.k < 0.02) return;
  const { cam, W, H } = st;
  const z = cam.z, cx = W / 2, cy = H / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // брызги
  ctx.strokeStyle = `rgba(190,210,255,${0.22 * rain.k})`;
  ctx.lineWidth = Math.max(1, z);
  ctx.beginPath();
  for (const s of rain.splashes) {
    const r = (1 + s.t * 11) * z;
    const x = (s.x - cam.x) * z + cx, y = (s.y - cam.y) * z + cy;
    ctx.moveTo(x + r, y);
    ctx.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
  // капли
  ctx.strokeStyle = `rgba(175,195,235,${0.32 * rain.k})`;
  ctx.lineWidth = Math.max(1, z * 1.1);
  ctx.beginPath();
  for (const d of rain.drops) {
    const h0 = Math.min(d.h, Hc * 0.8), h1 = Math.min(d.h + 70, Hc * 0.8);
    const f0 = Hc / (Hc - h0), f1 = Hc / (Hc - h1);
    const x0 = (d.x - cam.x) * z * f0 + cx, y0 = (d.y - cam.y) * z * f0 + cy;
    const x1 = (d.x - WIND * 0.05 - cam.x) * z * f1 + cx, y1 = (d.y - cam.y) * z * f1 + cy;
    ctx.moveTo(x1, y1); ctx.lineTo(x0, y0);
  }
  ctx.stroke();
  // лёгкая дымка
  ctx.fillStyle = `rgba(40,55,85,${0.07 * rain.k})`;
  ctx.fillRect(0, 0, W, H);
}
