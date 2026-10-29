// Процедурные спрайты света (пятна фонарей, конусы фар) и справочник машин.

export const LIGHT_RGB = {
  white: [215, 230, 255], sodium: [255, 150, 60], warm: [255, 200, 130], cyan: [80, 225, 255],
  pink: [255, 70, 185], green: [80, 255, 120], purple: [170, 90, 255], yellow: [255, 215, 70],
  red: [255, 35, 25], blue: [50, 110, 255], orange: [255, 120, 20],
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return c;
}

function radial(size, rgb, power) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const h = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - h, y + 0.5 - h) / h;
    const a = d >= 1 ? 0 : Math.pow(1 - d, power);
    const k = (y * size + x) * 4;
    img.data[k] = rgb[0]; img.data[k + 1] = rgb[1]; img.data[k + 2] = rgb[2]; img.data[k + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function cone(len, half, rgb) {
  const w = len, h = half * 2;
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const aw = Math.atan2(half, len) * 0.95;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + 0.5, dy = y + 0.5 - half;
    const d = Math.hypot(dx, dy) / len;
    const ang = Math.abs(Math.atan2(dy, dx));
    let a = d >= 1 ? 0 : Math.pow(1 - d, 1.3) * Math.min(1, Math.max(0, (aw - ang) / (aw * 0.6)));
    a *= Math.min(1, d * 6 + 0.35);
    const k = (y * w + x) * 4;
    img.data[k] = rgb[0]; img.data[k + 1] = rgb[1]; img.data[k + 2] = rgb[2]; img.data[k + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return c;
}

export const S = {};

export function initSprites() {
  S.mask = radial(128, [255, 255, 255], 1.6);
  S.glow = {};
  for (const k in LIGHT_RGB) S.glow[k] = radial(96, LIGHT_RGB[k], 2.2);
  S.dot = {};
  for (const k in LIGHT_RGB) S.dot[k] = radial(32, LIGHT_RGB[k], 1.2);
  S.coneMask = cone(256, 90, [255, 255, 255]);
  S.coneGlow = cone(256, 90, [255, 235, 190]);
}

export const CAR_COLORS = ['#b8322b', '#2b5cb8', '#dcdcdc', '#25272b', '#7a7f86', '#2e7d4f', '#c9a227', '#6b2d8a',
  '#b86b2b', '#1f3f6b', '#8a1f1f', '#c8c8c8', '#3a4a5a', '#5a2a2a', '#2a6a7a', '#e0d8c0'];

export const CAR_DIM = { sedan: [46, 22], hatch: [40, 21], van: [52, 24], taxi: [46, 22], police: [48, 22], truck: [84, 26], bus: [104, 28], sport: [48, 23] };

