#!/usr/bin/env node
// Generates public/og-default.jpg (1200x630) from the brand tokens in DESIGN.md.
// No photo is used on purpose: photos/ contains no licensed images yet (photo_map.json is
// "placeholder-only"), and every hero on the site is an Unsplash placeholder, so a typographic
// card is the only default we can ship with a clear licence position.
// Usage: node scripts/make-og-image.mjs
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og-default.jpg');
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#09090B"/>
      <stop offset="0.65" stop-color="#14141A"/>
      <stop offset="1" stop-color="#1B3A42"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.2" r="0.6">
      <stop offset="0" stop-color="#2A7B8C" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#2A7B8C" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="80" y="96" width="64" height="3" fill="#C9A96E"/>
  <text x="80" y="150" font-family="Helvetica, Arial, sans-serif" font-size="22" letter-spacing="6" fill="#C9A96E">LUXURY TRAVEL INTELLIGENCE</text>
  <text x="80" y="300" font-family="Georgia, 'Times New Roman', serif" font-size="96" fill="#F5F0E8">Beyond Paradise</text>
  <text x="80" y="406" font-family="Georgia, 'Times New Roman', serif" font-size="96" font-style="italic" fill="#F5F0E8">Adventures</text>
  <text x="80" y="500" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#F5F0E8" fill-opacity="0.72">Sourced wildlife seasons, ethics and costs for East Africa</text>
  <text x="80" y="560" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#C9A96E">beyondparadiseadventures.com</text>
</svg>`;
await sharp(Buffer.from(svg)).jpeg({ quality: 88, mozjpeg: true }).toFile(OUT);
const meta = await sharp(OUT).metadata();
console.log(`wrote ${OUT} ${meta.width}x${meta.height}`);
