// VELDARA — a travel poster for a place that isn't there.
// main.ts (Node 22): generates the poster entirely in code — no network,
// no downloaded images — and writes one PNG to /output/entry.png
// (falls back to ./output/entry.png when /output is not writable).
// Pure TypeScript, only node built-ins (fs, path, zlib).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Deterministic PRNG (so the poster is identical on every run)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Colour helpers. Colours are [r, g, b, a] with channels 0..255, alpha 0..1.
// ---------------------------------------------------------------------------
type RGBA = [number, number, number, number];

function mix(c1: RGBA, c2: RGBA, t: number): RGBA {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
    c1[3] + (c2[3] - c1[3]) * t,
  ];
}

function gradientAt(stops: Array<[number, RGBA]>, t: number): RGBA {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Canvas: a supersampled RGBA buffer. All drawing is done in poster space
// (1024 x 1024); the buffer is SS times larger and downsampled at the end,
// which anti-aliases every hard edge.
// ---------------------------------------------------------------------------
const SS = 2;
const W = 1024;
const H = 1024;
const CW = W * SS;
const CH = H * SS;

class Canvas {
  data: Uint8ClampedArray = new Uint8ClampedArray(CW * CH * 4);

  // Source-over blend of one working-resolution pixel.
  blend(wx: number, wy: number, r: number, g: number, b: number, a: number): void {
    const xi = Math.round(wx);
    const yi = Math.round(wy);
    if (xi < 0 || yi < 0 || xi >= CW || yi >= CH || a <= 0) return;
    if (a > 1) a = 1;
    const i = (yi * CW + xi) * 4;
    const ia = 1 - a;
    const d = this.data;
    d[i] = r * a + d[i] * ia;
    d[i + 1] = g * a + d[i + 1] * ia;
    d[i + 2] = b * a + d[i + 2] * ia;
    d[i + 3] = 255;
  }

  // Fill one working-resolution row with a solid colour.
  fillRow(wy: number, r: number, g: number, b: number): void {
    const d = this.data;
    const base = wy * CW * 4;
    for (let x = 0; x < CW; x++) {
      const i = base + x * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }

  // Vertical gradient over the whole canvas, y in poster space.
  vgradient(stops: Array<[number, RGBA]>): void {
    for (let wy = 0; wy < CH; wy++) {
      const c = gradientAt(stops, wy / CH);
      this.fillRow(wy, c[0], c[1], c[2]);
    }
  }

  // Vertical gradient over a horizontal band only, y0..y1 in poster space.
  vgradientBand(y0: number, y1: number, stops: Array<[number, RGBA]>): void {
    const wy0 = Math.max(0, Math.floor(y0 * SS));
    const wy1 = Math.min(CH - 1, Math.ceil(y1 * SS));
    for (let wy = wy0; wy <= wy1; wy++) {
      const c = gradientAt(stops, (wy / SS - y0) / (y1 - y0));
      this.fillRow(wy, c[0], c[1], c[2]);
    }
  }

  // Radial glow: one pass over the bounding box, alpha falling off
  // quadratically from peakAlpha at the centre to 0 at radius.
  radialGlow(cx: number, cy: number, radius: number, c: RGBA, peak: number): void {
    const x0 = Math.max(0, Math.floor((cx - radius) * SS));
    const x1 = Math.min(CW - 1, Math.ceil((cx + radius) * SS));
    const y0 = Math.max(0, Math.floor((cy - radius) * SS));
    const y1 = Math.min(CH - 1, Math.ceil((cy + radius) * SS));
    for (let wy = y0; wy <= y1; wy++) {
      const dy = wy / SS - cy;
      for (let wx = x0; wx <= x1; wx++) {
        const dx = wx / SS - cx;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= radius) continue;
        const t = 1 - dist / radius;
        this.blend(wx, wy, c[0], c[1], c[2], peak * t * t);
      }
    }
  }

  // Soft-edged filled disc, centre/radius in poster space.
  disc(cx: number, cy: number, rad: number, c: RGBA, soft = 1): void {
    const x0 = Math.max(0, Math.floor((cx - rad - soft) * SS));
    const x1 = Math.min(CW - 1, Math.ceil((cx + rad + soft) * SS));
    const y0 = Math.max(0, Math.floor((cy - rad - soft) * SS));
    const y1 = Math.min(CH - 1, Math.ceil((cy + rad + soft) * SS));
    for (let wy = y0; wy <= y1; wy++) {
      const dy = wy / SS - cy;
      for (let wx = x0; wx <= x1; wx++) {
        const dx = wx / SS - cx;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > rad + soft) continue;
        const a = dist <= rad ? c[3] : c[3] * (1 - (dist - rad) / soft);
        this.blend(wx, wy, c[0], c[1], c[2], a);
      }
    }
  }

  // Soft-edged filled ellipse, radii in poster space.
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGBA, soft = 1.5): void {
    const x0 = Math.max(0, Math.floor((cx - rx - soft) * SS));
    const x1 = Math.min(CW - 1, Math.ceil((cx + rx + soft) * SS));
    const y0 = Math.max(0, Math.floor((cy - ry - soft) * SS));
    const y1 = Math.min(CH - 1, Math.ceil((cy + ry + soft) * SS));
    for (let wy = y0; wy <= y1; wy++) {
      const dy = (wy / SS - cy) / ry;
      for (let wx = x0; wx <= x1; wx++) {
        const dx = (wx / SS - cx) / rx;
        const q = dx * dx + dy * dy;
        if (q > 1.3) continue;
        const a = q <= 1 ? c[3] : c[3] * (1 - (Math.sqrt(q) - 1) / 0.14);
        this.blend(wx, wy, c[0], c[1], c[2], Math.max(0, a));
      }
    }
  }

  // Thick line with round caps, in poster space.
  line(x1: number, y1: number, x2: number, y2: number, width: number, c: RGBA): void {
    const half = width / 2;
    const x0 = Math.max(0, Math.floor((Math.min(x1, x2) - half - 1) * SS));
    const x1w = Math.min(CW - 1, Math.ceil((Math.max(x1, x2) + half + 1) * SS));
    const y0 = Math.max(0, Math.floor((Math.min(y1, y2) - half - 1) * SS));
    const y1w = Math.min(CH - 1, Math.ceil((Math.max(y1, y2) + half + 1) * SS));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    for (let wy = y0; wy <= y1w; wy++) {
      const py = wy / SS;
      for (let wx = x0; wx <= x1w; wx++) {
        const px = wx / SS;
        let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
        t = clamp01(t);
        const qx = x1 + t * dx - px;
        const qy = y1 + t * dy - py;
        const dist = Math.sqrt(qx * qx + qy * qy);
        if (dist > half + 1) continue;
        const a = dist <= half ? c[3] : c[3] * (1 - (dist - half));
        this.blend(wx, wy, c[0], c[1], c[2], Math.max(0, a));
      }
    }
  }

  // Filled polygon (even-odd), points in poster space. Hard edge; the
  // 2x supersample + downsample anti-aliases it.
  poly(points: Array<[number, number]>, c: RGBA): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y0 = Math.max(0, Math.floor(minY * SS));
    const y1 = Math.min(CH - 1, Math.ceil(maxY * SS));
    const n = points.length;
    for (let wy = y0; wy <= y1; wy++) {
      const py = (wy + 0.5) / SS;
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % n];
        if ((ay <= py && by > py) || (by <= py && ay > py)) {
          xs.push(ax + ((py - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k] * SS));
        const xb = Math.min(CW - 1, Math.ceil(xs[k + 1] * SS));
        for (let wx = xa; wx <= xb; wx++) {
          this.blend(wx, wy, c[0], c[1], c[2], c[3]);
        }
      }
    }
  }

  // Subtle darkening towards the corners.
  vignette(amount: number): void {
    const d = this.data;
    for (let wy = 0; wy < CH; wy++) {
      const ny = (wy / SS - H / 2) / (H / 2);
      for (let wx = 0; wx < CW; wx++) {
        const nx = (wx / SS - W / 2) / (W / 2);
        const dist = Math.sqrt(nx * nx + ny * ny);
        const f = 1 - amount * smoothstep(0.72, 1.38, dist);
        const i = (wy * CW + wx) * 4;
        d[i] *= f;
        d[i + 1] *= f;
        d[i + 2] *= f;
      }
    }
  }

  // Downsample 2x2 box average into a 1024x1024 RGBA buffer.
  downsample(): Buffer {
    const out = Buffer.alloc(W * H * 4);
    const d = this.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * CW + (x * SS + sx)) * 4;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
          }
        }
        const o = (y * W + x) * 4;
        const n = SS * SS;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
        out[o + 3] = 255;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Stroke font: each glyph is a list of polylines on a 6 (wide) x 10 (tall)
// grid. Drawn as thick round-capped strokes, which reads like hand-lettered
// poster type at large sizes.
// ---------------------------------------------------------------------------
const GLYPHS: Record<string, Array<Array<[number, number]>>> = {
  V: [[[0, 0], [3, 10], [6, 0]]],
  E: [[[6, 0], [0, 0], [0, 10], [6, 10]], [[0, 5], [4.2, 5]]],
  L: [[[0, 0], [0, 10], [6, 10]]],
  D: [[[0, 0], [0, 10], [4.2, 10], [6, 8], [6, 2], [4.2, 0], [0, 0]]],
  A: [[[0, 10], [3, 0], [6, 10]], [[1.4, 6.6], [4.6, 6.6]]],
  R: [[[0, 10], [0, 0], [4, 0], [6, 2], [4, 4], [0, 4]], [[3.6, 4], [6, 10]]],
};

function drawText(cv: Canvas, text: string, cx: number, y: number, height: number, c: RGBA): void {
  const scale = height / 10;
  const advance = 6 * scale;
  const tracking = 0.34 * height;
  const strokeW = 0.17 * height;
  const total = text.length * advance + (text.length - 1) * tracking;
  let x = cx - total / 2;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (const stroke of glyph) {
        for (let i = 0; i + 1 < stroke.length; i++) {
          const [ax, ay] = stroke[i];
          const [bx, by] = stroke[i + 1];
          cv.line(x + ax * scale, y + ay * scale, x + bx * scale, y + by * scale, strokeW, c);
        }
        // Round the joints.
        for (const [px, py] of stroke) {
          cv.disc(x + px * scale, y + py * scale, strokeW / 2, c, 0.6);
        }
      }
    }
    x += advance + tracking;
  }
}

// ---------------------------------------------------------------------------
// The poster: VELDARA — an island that floats above a sea of clouds at
// sunset, its lighthouse lit, a waterfall spilling off its edge into the
// clouds below. One landmark, one light, one name.
// ---------------------------------------------------------------------------
function drawPoster(): Canvas {
  const cv = new Canvas();
  const rand = mulberry32(20261121);

  // 1. Sunset sky.
  cv.vgradient([
    [0.0, [26, 14, 54, 1]],
    [0.28, [84, 36, 92, 1]],
    [0.46, [163, 74, 104, 1]],
    [0.6, [224, 122, 82, 1]],
    [0.72, [246, 165, 92, 1]],
    [1.0, [246, 165, 92, 1]],
  ]);

  // 2. Stars in the deep part of the sky (kept clear of the title band).
  for (let i = 0; i < 110; i++) {
    const sx = rand() * W;
    const sy = rand() * 300;
    if (sx > 190 && sx < 834 && sy > 70 && sy < 240) continue;
    const a = 0.25 + rand() * 0.65;
    cv.disc(sx, sy, 0.8 + rand() * 1.4, [255, 248, 224, a], 0.8);
  }

  // 3. Low sun + glow, centred so the island sits below it.
  const sunX = 512;
  const sunY = 382;
  cv.radialGlow(sunX, sunY, 340, [255, 179, 92, 1], 0.16);
  cv.disc(sunX, sunY, 102, [255, 233, 168, 1], 3);
  cv.disc(sunX, sunY, 96, [255, 214, 130, 1], 2);
  cv.disc(sunX, sunY + 30, 88, [247, 185, 92, 0.85], 2);

  // 4. Birds.
  const birdC: RGBA = [42, 18, 48, 0.85];
  for (const [bx, by, s] of [[348, 296, 1], [688, 262, 0.8], [762, 330, 0.65]] as const) {
    cv.line(bx - 15 * s, by + 7 * s, bx, by, 3.2, birdC);
    cv.line(bx, by, bx + 15 * s, by + 7 * s, 3.2, birdC);
  }

  // 5. Distant mountain ridges, far then near.
  cv.poly(
    [[0, 640], [90, 606], [190, 632], [300, 598], [420, 628], [540, 600], [660, 630], [780, 602], [900, 628], [1024, 604], [1024, 700], [0, 700]],
    [107, 58, 110, 0.9],
  );
  cv.poly(
    [[0, 668], [120, 640], [240, 664], [380, 636], [520, 662], [680, 640], [820, 666], [1024, 642], [1024, 720], [0, 720]],
    [74, 42, 85, 0.95],
  );

  // 5b. A small distant islet, muted by haze, so Veldara is not the only
  // thing floating in this sky — it gives the main island its scale.
  cv.ellipse(170, 498, 56, 9, [150, 110, 95, 0.95], 2);
  cv.poly(
    [[118, 500], [222, 500], [210, 528], [192, 550], [170, 560], [150, 546], [132, 526]],
    [74, 42, 85, 0.95],
  );
  cv.ellipse(158, 486, 4, 13, [47, 93, 58, 0.9], 1.5);
  cv.ellipse(188, 490, 3, 9, [47, 93, 58, 0.85], 1.5);

  // 6. Sea of clouds (lower band only) + sun's reflection on it.
  cv.vgradientBand(776, 1024, [
    [0.0, [248, 205, 166, 1]],
    [0.45, [217, 168, 200, 1]],
    [1.0, [125, 90, 142, 1]],
  ]);
  cv.ellipse(512, 832, 360, 34, [255, 217, 160, 0.45], 6);
  // Bumps along the cloud sea's top edge.
  for (let x = -40; x < 1064; x += 88) {
    const r = 0.5 + rand() * 0.5;
    cv.ellipse(x + rand() * 30, 776, 62 + r * 48, 16 + r * 12, [248, 205, 166, 1], 4);
  }
  // Scattered puffs and shadows inside the cloud sea: many small, soft,
  // overlapping puffs so they merge into cloud banks instead of reading
  // as separate ovals.
  for (let i = 0; i < 46; i++) {
    const px = rand() * W;
    const py = 796 + rand() * 212;
    const prx = 22 + rand() * 58;
    const pry = 8 + rand() * 14;
    const shade = rand() < 0.42;
    cv.ellipse(
      px, py, prx, pry,
      shade ? [154, 106, 158, 0.38] : [244, 202, 162, 0.42],
      5,
    );
  }
  // A second row of small bright puffs hugging the cloud sea's top edge
  // breaks the hard horizontal line where sky meets cloud.
  for (let i = 0; i < 26; i++) {
    const px = rand() * W;
    const py = 776 + rand() * 26;
    cv.ellipse(px, py, 26 + rand() * 42, 9 + rand() * 10, [250, 214, 176, 0.55], 5);
  }

  // 7. The floating island: golden grass cap, plum rock tapering to a point.
  cv.ellipse(512, 620, 272, 22, [194, 164, 79, 1], 3);
  cv.ellipse(512, 626, 268, 12, [125, 143, 69, 1], 2);
  cv.poly(
    [
      [246, 624], [778, 624], [762, 688], [732, 748], [692, 800],
      [642, 844], [582, 872], [512, 890], [452, 866], [392, 816],
      [342, 756], [302, 700], [264, 660],
    ],
    [91, 58, 85, 1],
  );
  // Rock shading: a darker cap over the island's lower half, bounded by a
  // curved top edge (dipping in the middle) and the rock's own lower
  // contour, so it stays inside the silhouette with no straight seam.
  cv.poly(
    [
      [352, 766], [380, 795], [440, 818], [512, 838], [584, 818],
      [644, 795], [694, 768], [692, 800], [642, 844], [582, 872],
      [512, 890], [452, 866], [392, 816], [342, 756],
    ],
    [58, 34, 62, 0.5],
  );
  cv.line(246, 624, 778, 624, 3, [247, 201, 138, 0.85]);
  // Cracks in the rock.
  cv.line(430, 660, 470, 730, 2.5, [58, 34, 62, 0.6]);
  cv.line(470, 730, 450, 790, 2.5, [58, 34, 62, 0.6]);
  cv.line(600, 668, 570, 740, 2.5, [58, 34, 62, 0.55]);
  // Bushes along the plateau.
  for (const [bx, br] of [[300, 12], [352, 9], [700, 11], [748, 8]] as const) {
    cv.disc(bx, 618, br, [72, 102, 52, 1], 2);
  }

  // 8. Lighthouse on the plateau (right side), lamp lit, beam to the right.
  const lx = 648;
  cv.poly(
    [[lx + 8, 538], [860, 512], [860, 556], [lx + 8, 554]],
    [255, 233, 168, 0.1],
  );
  cv.poly(
    [[lx + 8, 542], [830, 524], [830, 544], [lx + 8, 550]],
    [255, 233, 168, 0.14],
  );
  cv.poly([[lx - 13, 620], [lx + 13, 620], [lx + 8, 528], [lx - 8, 528]], [245, 239, 224, 1]);
  cv.poly([[lx - 12, 592], [lx + 12, 592], [lx + 10, 566], [lx - 10, 566]], [192, 57, 43, 1]);
  cv.disc(lx, 522, 26, [255, 214, 130, 0.5], 6);
  cv.poly([[lx - 9, 528], [lx + 9, 528], [lx + 9, 508], [lx - 9, 508]], [42, 32, 48, 1]);
  cv.disc(lx, 522, 5, [255, 240, 170, 1], 1);
  cv.poly([[lx - 11, 508], [lx + 11, 508], [lx, 496]], [192, 57, 43, 1]);
  cv.line(lx - 13, 620, lx + 13, 620, 2, [120, 90, 100, 0.6]);

  // 9. Cottage on the plateau (left side), windows warm.
  cv.poly([[372, 620], [372, 588], [424, 588], [424, 620]], [232, 214, 180, 1]);
  cv.poly([[364, 590], [432, 590], [398, 562]], [160, 62, 58, 1]);
  cv.poly([[392, 620], [392, 600], [404, 600], [404, 620]], [58, 40, 52, 1]);
  cv.disc(382, 602, 4, [255, 215, 106, 1], 1);
  cv.disc(414, 602, 4, [255, 215, 106, 1], 1);

  // 10. Cypress trees.
  for (const [tx, th, tw] of [[298, 46, 13], [726, 38, 11]] as const) {
    cv.line(tx, 620, tx, 620 - th + 12, 3, [52, 44, 40, 1]);
    cv.ellipse(tx, 620 - th, tw, th, [47, 93, 58, 1], 2);
  }

  // 11. Waterfall spilling off the island's left edge into the clouds:
  // one smooth tapered ribbon along a gentle S-curve (not a chain of
  // discs), with a bright thread of water down its middle.
  const fall: Array<[number, number, number]> = [
    [272, 626, 15], [266, 660, 14], [272, 696, 13], [282, 732, 12],
    [292, 768, 11], [298, 802, 10], [300, 836, 9], [298, 866, 8],
  ];
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < fall.length; i++) {
    const [fx, fy, fr] = fall[i];
    const [px, py] = fall[Math.max(0, i - 1)];
    const [nx, ny] = fall[Math.min(fall.length - 1, i + 1)];
    let dx = nx - px;
    let dy = ny - py;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len;
    dy /= len;
    // Normal to the flow direction.
    left.push([fx - dy * fr, fy + dx * fr]);
    right.push([fx + dy * fr, fy - dx * fr]);
  }
  cv.poly([...left, ...right.reverse()], [216, 236, 247, 0.92]);
  for (let i = 0; i + 1 < fall.length; i++) {
    const [ax, ay] = fall[i];
    const [bx, by] = fall[i + 1];
    cv.line(ax, ay, bx, by, 4.5, [255, 255, 255, 0.7]);
  }

  // 12. Foreground clouds: the island's tip and the waterfall's base
  // disappear into them; heavy masses anchor the bottom corners.
  cv.ellipse(512, 908, 130, 34, [248, 205, 166, 0.9], 6);
  cv.disc(298, 872, 26, [255, 248, 238, 0.55], 8);
  cv.disc(320, 884, 20, [255, 248, 238, 0.45], 8);
  cv.ellipse(110, 1010, 260, 90, [125, 90, 142, 0.85], 8);
  cv.ellipse(120, 962, 200, 50, [216, 164, 196, 0.7], 6);
  cv.ellipse(60, 990, 120, 42, [232, 182, 205, 0.55], 6);
  cv.ellipse(210, 1000, 130, 44, [150, 110, 160, 0.5], 6);
  cv.ellipse(920, 1020, 280, 100, [125, 90, 142, 0.85], 8);
  cv.ellipse(900, 968, 210, 52, [216, 164, 196, 0.7], 6);
  cv.ellipse(980, 992, 120, 42, [232, 182, 205, 0.55], 6);
  cv.ellipse(830, 1002, 130, 44, [150, 110, 160, 0.5], 6);

  // 13. The place name, set large across the top: first a soft drop shadow
  // (same glyphs, shifted 6px down, dark plum at low alpha), then the name
  // itself in cream — plus a small rule-and-diamond ornament beneath it.
  // No other copy anywhere on the poster.
  drawText(cv, "VELDARA", 512, 96, 100, [42, 18, 48, 0.45]);
  drawText(cv, "VELDARA", 512, 90, 100, [255, 243, 208, 1]);
  cv.line(362, 226, 492, 226, 2.5, [255, 243, 208, 0.8]);
  cv.line(532, 226, 662, 226, 2.5, [255, 243, 208, 0.8]);
  cv.poly([[512, 218], [520, 226], [512, 234], [504, 226]], [255, 243, 208, 0.9]);

  // 14. Gentle vignette to hold the edges together.
  cv.vignette(0.16);

  return cv;
}

// ---------------------------------------------------------------------------
// PNG encoding: 8-bit RGBA, filter 0, zlib level 9. CRC32 table, standard.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
function main(): void {
  const cv = drawPoster();
  const rgba = cv.downsample();
  const png = encodePng(rgba, W, H);
  const outName = "entry.png";
  let written = false;
  for (const dir of ["/output", path.join(process.cwd(), "output")]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, outName), png);
      console.log(`Wrote ${path.join(dir, outName)} (${png.length} bytes, ${W}x${H})`);
      written = true;
      break;
    } catch {
      // Try the next location.
    }
  }
  if (!written) {
    throw new Error("Could not write entry.png to /output or ./output");
  }
}

main();
