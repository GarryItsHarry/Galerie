// Statische Demo bauen: node scripts/build-demo.mjs [Datenordner, Standard: demo/] [--artifact]  ->  demo-dist/
// Ohne Server lauffähig (z. B. GitHub Pages); --artifact entfernt das HTML-Grundgerüst, das claude.ai selbst setzt.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), artifact = args.includes('--artifact');
const data = args.find((a) => !a.startsWith('--')) || 'demo';
if (!fs.existsSync(path.join(data, 'gallery.json'))) throw new Error('Aufruf: node scripts/build-demo.mjs [Ordner mit gallery.json, tex/, thumb/] [--artifact]');
const out = 'demo-dist';
execSync('npx vite build --outDir ../demo-dist', { stdio: 'inherit', env: { ...process.env, VITE_DEMO: '1' } });
fs.copyFileSync(path.join(data, 'gallery.json'), path.join(out, 'gallery.json'));
for (const d of ['tex', 'thumb']) fs.cpSync(path.join(data, d), path.join(out, 'files', d), { recursive: true });

// Modelle: Binärdaten als data-URI einbetten und als .json ablegen (.gltf/.glb/.bin werden dort nicht ausgeliefert)
const b64 = (buf) => 'data:application/octet-stream;base64,' + buf.toString('base64');
for (const f of fs.readdirSync(path.join(out, 'models'), { recursive: true }).map((f) => path.join(out, 'models', f))) {
  if (f.endsWith('.gltf')) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const b of j.buffers || []) if (b.uri && !b.uri.startsWith('data:')) { const bin = path.join(path.dirname(f), b.uri); b.uri = b64(fs.readFileSync(bin)); fs.rmSync(bin); }
    fs.writeFileSync(f.replace(/\.gltf$/, '.json'), JSON.stringify(j)); fs.rmSync(f);
  } else if (f.endsWith('.glb')) {
    const g = fs.readFileSync(f), jl = g.readUInt32LE(12), j = JSON.parse(g.subarray(20, 20 + jl).toString('utf8'));
    const binStart = 20 + jl; // zweiter Chunk: Länge, Typ, Daten
    if (binStart < g.length) { j.buffers[0].uri = b64(g.subarray(binStart + 8, binStart + 8 + g.readUInt32LE(binStart))); }
    fs.writeFileSync(f.replace(/\.glb$/, '.json'), JSON.stringify(j)); fs.rmSync(f);
  }
}
const idx = path.join(out, 'index.html');
let html = fs.readFileSync(idx, 'utf8').replace('<title>Galerie</title>', '<title>Virtuelle Galerie</title>');
if (artifact) html = html.replace(/<!doctype html>\s*|<\/?html[^>]*>\s*|<\/?head>\s*|<\/?body>\s*|<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*/gi, '');
fs.writeFileSync(idx, html);
fs.writeFileSync(path.join(out, '.nojekyll'), ''); // GitHub Pages: Dateien unverändert ausliefern
const left = fs.readdirSync(out, { recursive: true }).filter((f) => /\.(gltf|glb|bin)$/.test(f));
console.assert(!left.length, 'nicht umgewandelt: ' + left);
console.log('Demo fertig in', out);
