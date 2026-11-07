#!/usr/bin/env node
'use strict';
// Copies only what the app needs into www/ (Capacitor's webDir).
//   node scripts/build-www.js                 data/places is NOT copied (native app fetches it remotely)
//   node scripts/build-www.js --with-places   also copies data/places (about 180 MB) and marks the build "local"
// Leaflet is copied from node_modules into www/vendor/leaflet so the native app works offline.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'www');
const withPlaces = process.argv.includes('--with-places');

const FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'panduan.html'];

function copy(src, dst, filter) {
  fs.cpSync(src, dst, { recursive: true, filter });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) copy(src, path.join(OUT, f));
  else console.warn(`skip (missing): ${f}`);
}

// data/ without the places shards unless asked for.
const placesDir = path.join(ROOT, 'data', 'places');
copy(path.join(ROOT, 'data'), path.join(OUT, 'data'), (src) => withPlaces || path.resolve(src) !== placesDir);

// Leaflet offline: copy the dist and point index.html at it.
const leafletDist = path.join(ROOT, 'node_modules', 'leaflet', 'dist');
if (fs.existsSync(leafletDist)) {
  copy(leafletDist, path.join(OUT, 'vendor', 'leaflet'), (src) => !/\.(map|esm\.js)$/.test(src) && !/leaflet-src/.test(src));
  const p = path.join(OUT, 'index.html');
  let html = fs.readFileSync(p, 'utf8');
  html = html
    .replace('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'vendor/leaflet/leaflet.css')
    .replace('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'vendor/leaflet/leaflet.js');
  fs.writeFileSync(p, html);
} else {
  console.warn('node_modules/leaflet not found: run npm install. The app will load Leaflet from the CDN.');
}

// Tell the app whether the shards are bundled (see PLACES_BASE in index.html).
if (withPlaces) {
  const p = path.join(OUT, 'index.html');
  const html = fs.readFileSync(p, 'utf8');
  const marker = '<meta name="sembilan-places" content="remote">';
  if (!html.includes(marker)) throw new Error('places marker not found in index.html');
  fs.writeFileSync(p, html.replace(marker, '<meta name="sembilan-places" content="local">'));
}

console.log(`www/ built (${withPlaces ? 'with' : 'without'} data/places)`);
