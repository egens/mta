// Процедурный город как источник для физики, навигации полиции и HUD.
import * as W from './world.js';
import { CS, peekChunk } from './chunks.js';

export const procMap = {
  surfaceAt: W.surfaceAt,
  isWater: W.isWater,
  collidersNear(x0, y0, x1, y1, out) {
    for (let i = W.colAt(x0); i <= W.colAt(x1); i++) for (let j = W.rowAt(y0); j <= W.rowAt(y1); j++) out.push(W.getBlock(i, j));
    return out;
  },
  lampsNear(x0, y0, x1, y1, cb) {
    for (let cx = Math.floor(x0 / CS); cx <= Math.floor(x1 / CS); cx++) for (let cy = Math.floor(y0 / CS); cy <= Math.floor(y1 / CS); cy++) {
      const ch = peekChunk(cx, cy);
      if (ch) for (const l of ch.lamps) cb(l);
    }
  },
  // навигация по сетке улиц: узел — перекрёсток (i, j)
  nav: {
    nearest(x, y) {
      let i = W.colAt(x), j = W.rowAt(y);
      if (Math.abs(W.roadX(i + 1) - x) < Math.abs(W.roadX(i) - x)) i++;
      if (Math.abs(W.roadY(j + 1) - y) < Math.abs(W.roadY(j) - y)) j++;
      return i + ',' + j;
    },
    pos(k) { const [i, j] = k.split(',').map(Number); return [W.roadX(i), W.roadY(j)]; },
    neighbors(k) { const [i, j] = k.split(',').map(Number); return [(i + 1) + ',' + j, (i - 1) + ',' + j, i + ',' + (j + 1), i + ',' + (j - 1)]; },
  },
  // точка на дороге на заданном расстоянии от (x, y): [x, y, угол]
  roadSpawn(x, y, dmin, dmax) {
    for (let tries = 0; tries < 6; tries++) {
      const a = Math.random() * Math.PI * 2, d = dmin + Math.random() * (dmax - dmin);
      const i = W.colAt(x + Math.cos(a) * d), j = W.rowAt(y + Math.sin(a) * d);
      const px = W.roadX(i) + 21, py = W.roadY(j) + (W.roadY(j + 1) - W.roadY(j)) * (0.25 + Math.random() * 0.5);
      if (!W.isWater(px, py)) return [px, py, Math.atan2(y - py, x - px)];
    }
    return null;
  },
  // участок ремонта на крайней полосе проспекта, посередине квартала
  worksSpot(x, y, dmin, dmax) {
    for (let tries = 0; tries < 8; tries++) {
      const vert = Math.random() < 0.5;
      const a = Math.random() * Math.PI * 2, d = dmin + Math.random() * (dmax - dmin);
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      const i = W.colAt(px), j = W.rowAt(py);
      if (vert ? !W.aveX(i) : !W.aveY(j)) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      const hw = 17, hl = 130;
      let cx, cy, ux, uy;
      if (vert) {
        const y0 = W.roadY(j) + W.widthY(j) / 2, y1 = W.roadY(j + 1) - W.widthY(j + 1) / 2;
        if (y1 - y0 < 2 * hl + 160) continue;
        cx = W.roadX(i) + side * 54; cy = (y0 + y1) / 2; ux = 0; uy = 1;
      } else {
        const x0 = W.roadX(i) + W.widthX(i) / 2, x1 = W.roadX(i + 1) - W.widthX(i + 1) / 2;
        if (x1 - x0 < 2 * hl + 160) continue;
        cx = (x0 + x1) / 2; cy = W.roadY(j) + side * 54; ux = 1; uy = 0;
      }
      const bx0 = cx - ux * hl - 60, bx1 = cx + ux * hl + 60, by0 = cy - uy * hl - 60, by1 = cy + uy * hl + 60;
      if (W.diagsInRect(bx0, by0, bx1, by1, 80).length) continue;
      if (!vert && W.railsInRange(bx0, bx1).length) continue;
      let bad = false;
      for (let u = -hl; u <= hl; u += 40) if (W.riverDist(cx + ux * u, cy + uy * u) < 260) bad = true;
      if (bad) continue;
      return { x: cx, y: cy, ux, uy, ix: vert ? -side : 0, iy: vert ? 0 : -side, hl, hw };
    }
    return null;
  },
  district: W.districtAt,
  ready: () => true,
};
