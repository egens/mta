// Процедурные спрайты: машины, световые пятна, конусы фар.

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
  S.cars = CAR_COLORS.map((c, n) => carSprite(n % 5 === 4 ? 'hatch' : n % 7 === 6 ? 'van' : 'sedan', c));
  S.taxi = carSprite('taxi', '#e8b81c');
  S.police = carSprite('police', '#e8e8ee');
  S.truck = carSprite('truck', '#9aa0a8');
  S.trucks = ['#9aa0a8', '#c84a2a', '#2a5aa8', '#e0e0e0'].map((c) => carSprite('truck', c));
  S.bus = carSprite('bus', '#d0d4d8');
  S.player = carSprite('sport', '#d8262a');
}

const CAR_COLORS = ['#b8322b', '#2b5cb8', '#dcdcdc', '#25272b', '#7a7f86', '#2e7d4f', '#c9a227', '#6b2d8a',
  '#b86b2b', '#1f3f6b', '#8a1f1f', '#c8c8c8', '#3a4a5a', '#5a2a2a', '#2a6a7a', '#e0d8c0'];

export const CAR_DIM = { sedan: [46, 22], hatch: [40, 21], van: [52, 24], taxi: [46, 22], police: [48, 22], truck: [84, 26], bus: [104, 28], sport: [48, 23] };

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; } else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

// Спрайт направлен вперёд по +x. Возвращает {img, L, W}.
function carSprite(type, color) {
  const [L, W] = CAR_DIM[type];
  const K = 3;
  const c = canvas((L + 4) * K, (W + 4) * K);
  const g = c.getContext('2d');
  g.scale(K, K);
  g.translate(L / 2 + 2, W / 2 + 2);
  const glass = '#16202b';
  if (type === 'truck') {
    // прицеп
    rr(g, -L / 2, -W / 2, L * 0.7, W, 2); g.fillStyle = color; g.fill();
    g.strokeStyle = shade(color, -0.4); g.lineWidth = 0.8; g.stroke();
    for (let x = -L / 2 + 6; x < -L / 2 + L * 0.7 - 2; x += 6) { g.fillStyle = shade(color, -0.15); g.fillRect(x, -W / 2 + 1, 0.8, W - 2); }
    // кабина
    rr(g, L / 2 - L * 0.27, -W / 2 + 1, L * 0.27, W - 2, 3); g.fillStyle = '#d8d8d0'; g.fill();
    g.fillStyle = glass; g.fillRect(L / 2 - 7, -W / 2 + 3, 4, W - 6);
    g.fillStyle = '#fff6c8'; g.fillRect(L / 2 - 1.5, -W / 2 + 2, 1.5, 3); g.fillRect(L / 2 - 1.5, W / 2 - 5, 1.5, 3);
    g.fillStyle = '#b01010'; g.fillRect(-L / 2, -W / 2 + 1, 1.2, 3); g.fillRect(-L / 2, W / 2 - 4, 1.2, 3);
    return { img: c, L, W, K };
  }
  if (type === 'bus') {
    rr(g, -L / 2, -W / 2, L, W, 3); g.fillStyle = color; g.fill();
    g.strokeStyle = '#555'; g.lineWidth = 0.8; g.stroke();
    g.fillStyle = '#2a4a8a'; g.fillRect(-L / 2 + 2, -W / 2, L - 4, 2); g.fillRect(-L / 2 + 2, W / 2 - 2, L - 4, 2);
    g.fillStyle = '#a8acb0'; g.fillRect(-L * 0.2, -5, 20, 10); g.fillRect(L * 0.15, -4, 12, 8);
    g.fillStyle = glass; g.fillRect(L / 2 - 4, -W / 2 + 2, 3, W - 4);
    return { img: c, L, W, K };
  }
  // легковые
  rr(g, -L / 2, -W / 2, L, W, type === 'sport' ? 6 : 5);
  const grd = g.createLinearGradient(0, -W / 2, 0, W / 2);
  grd.addColorStop(0, shade(color, -0.25)); grd.addColorStop(0.5, shade(color, 0.12)); grd.addColorStop(1, shade(color, -0.25));
  g.fillStyle = grd; g.fill();
  g.strokeStyle = shade(color, -0.55); g.lineWidth = 0.8; g.stroke();
  const van = type === 'van';
  const wsF = van ? L * 0.36 : L * 0.2, wsB = van ? L * 0.26 : L * 0.06;
  const roofB = van ? -L * 0.45 : type === 'hatch' ? -L * 0.36 : -L * 0.22;
  // лобовое
  g.beginPath(); g.moveTo(wsF, -W * 0.36); g.lineTo(wsF, W * 0.36); g.lineTo(wsB, W * 0.42); g.lineTo(wsB, -W * 0.42); g.closePath();
  g.fillStyle = glass; g.fill();
  // крыша
  g.fillStyle = shade(color, van ? 0.05 : 0.18);
  g.fillRect(roofB, -W * 0.42, wsB - roofB, W * 0.84);
  // заднее стекло
  if (!van) {
    g.beginPath(); g.moveTo(roofB, -W * 0.42); g.lineTo(roofB, W * 0.42); g.lineTo(roofB - L * 0.1, W * 0.34); g.lineTo(roofB - L * 0.1, -W * 0.34); g.closePath();
    g.fillStyle = glass; g.fill();
  }
  // боковые стёкла
  g.fillStyle = 'rgba(20,30,40,0.8)';
  g.fillRect(roofB + 1, -W / 2 + 0.6, wsB - roofB - 2, 1.4); g.fillRect(roofB + 1, W / 2 - 2, wsB - roofB - 2, 1.4);
  if (type === 'sport') {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(-L / 2 + 1, -2.5, L - 2, 1.6); g.fillRect(-L / 2 + 1, 1, L - 2, 1.6);
    g.fillStyle = '#111'; g.fillRect(-L / 2 + 1, -W / 2 + 2, 2.5, W - 4);
  }
  if (type === 'taxi') {
    g.fillStyle = '#222'; g.fillRect(-4, -4, 7, 8);
    g.fillStyle = '#fff'; for (let k = 0; k < 3; k++) g.fillRect(-4 + k * 2.4, -4 + (k % 2) * 4, 2.3, 4);
  }
  if (type === 'police') {
    g.fillStyle = '#1f3f9a'; g.fillRect(-L * 0.42, -W / 2, L * 0.75, 2.2); g.fillRect(-L * 0.42, W / 2 - 2.2, L * 0.75, 2.2);
    g.fillStyle = '#e02020'; g.fillRect(-3, -W * 0.38, 4, W * 0.38);
    g.fillStyle = '#2050ff'; g.fillRect(-3, 0, 4, W * 0.38);
  }
  // фары и фонари
  g.fillStyle = '#fff6c8';
  g.fillRect(L / 2 - 2, -W / 2 + 2, 2, 4); g.fillRect(L / 2 - 2, W / 2 - 6, 2, 4);
  g.fillStyle = '#a81010';
  g.fillRect(-L / 2, -W / 2 + 2, 1.6, 4); g.fillRect(-L / 2, W / 2 - 6, 1.6, 4);
  // зеркала
  g.fillStyle = shade(color, -0.3);
  g.fillRect(wsF - 2, -W / 2 - 1.2, 2.5, 1.4); g.fillRect(wsF - 2, W / 2 - 0.2, 2.5, 1.4);
  return { img: c, L, W, K };
}

export function drawCarSprite(g, spr, x, y, a, shadow = true) {
  g.save();
  g.translate(x, y);
  if (shadow) {
    g.translate(3, 4);
    g.rotate(a);
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(-spr.L / 2, -spr.W / 2, spr.L, spr.W);
    g.rotate(-a);
    g.translate(-3, -4);
  }
  g.rotate(a);
  g.drawImage(spr.img, -spr.L / 2 - 2, -spr.W / 2 - 2, spr.L + 4, spr.W + 4);
  g.restore();
}

export function spriteFor(kind, n) {
  if (kind === 'truck') return S.trucks[n % S.trucks.length];
  return S.cars[n % S.cars.length];
}
