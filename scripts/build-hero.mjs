#!/usr/bin/env node
/**
 * Rasterize a handwritten hero image for the README. Uses whichever
 * handwritten face is installed on the build machine (Bradley Hand on macOS
 * by default; falls through to other handwritten families as fallbacks).
 *
 * Output: resources/hero.png — referenced via <img> in README.md so the
 * handwritten look renders regardless of the GitHub viewer's font stack.
 */

import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 2× density so the rendered PNG stays crisp on retina displays.
const scale = 2;
const width = 1600;
const height = 220;

// Soft cream background — matches clawdSlate's docs theme. GitHub won't honor
// prefers-color-scheme for inline README images, so the image must carry
// its own background.
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#faf4e8"/>
      <stop offset="100%" stop-color="#f3ead7"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="url(#bg)"/>
  <style>
    text {
      font-family: 'Bradley Hand', 'Marker Felt', 'Segoe Print', 'Comic Sans MS', cursive;
      font-weight: 700;
      fill: #1a1614;
      letter-spacing: -0.005em;
    }
  </style>
  <text x="${width / 2}" y="150" text-anchor="middle" font-size="104">
    Paste anything. Get a whiteboard.
  </text>
</svg>`;

mkdirSync(join(root, 'resources'), { recursive: true });

await sharp(Buffer.from(svg), { density: 144 * scale })
  .resize(width * scale, height * scale)
  .png({ compressionLevel: 9 })
  .toFile(join(root, 'resources', 'hero.png'));

console.log('  ✓ resources/hero.png');
