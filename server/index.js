import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const PORT = Number(process.env.PORT || 3000);
for (const d of ['original', 'tex', 'thumb', 'tmp']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

// Im Docker-Container als root gestartet: Datenordner an „node“ (1000) übergeben und Root-Rechte abgeben.
// Klappt chown nicht (exotisches Dateisystem), läuft er wie bisher weiter, statt die Galerie lahmzulegen.
const parents = (p) => (path.dirname(p) === p ? [] : [path.dirname(p), ...parents(path.dirname(p))]);
const reachable = parents(DATA).every((d) => { const st = fs.statSync(d); return st.uid === 1000 || (st.mode & 0o001) !== 0; });
if (process.getuid?.() === 0 && reachable) {
  try {
    const own = (p) => { fs.lchownSync(p, 1000, 1000); if (fs.lstatSync(p).isDirectory()) for (const f of fs.readdirSync(p)) own(path.join(p, f)); };
    own(DATA);
    process.setgroups([]); process.setgid(1000); process.setuid(1000);
  } catch (e) { console.warn('Rechte nicht abgegeben, läuft als root weiter:', e.message); }
}

const FILE = path.join(DATA, 'gallery.json');
let gallery = { images: [], rooms: [], placements: [], benches: [], objects: [] };
if (fs.existsSync(FILE)) gallery = { ...gallery, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(gallery, null, 2));
  fs.renameSync(tmp, FILE);
}

// ---------- Eingaben prüfen: nur bekannte Felder mit passendem Typ übernehmen (Vertrauensgrenze) ----------
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneOf = (v, allowed) => (allowed.includes(v) ? v : undefined);
const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter(Boolean) : null);
const nums = (o, keys) => keys.every((k) => num(o?.[k]) !== null);
const door = (d) => (nums(d, ['edge', 't', 'w']) ? { edge: Math.trunc(d.edge), t: d.t, w: d.w } : null);
const clean = {
  rooms: (r) => {
    const pts = list(r?.pts, 200, (p) => (Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null ? [p[0], p[1]] : null));
    if (!str(r?.id) || !pts || pts.length < 3 || num(r.height) === null) return null;
    return { id: str(r.id, 40), name: str(r.name), tag: str(r.tag), height: r.height, pts, doors: list(r.doors, 50, door) || [], windows: list(r.windows, 50, door) || [],
      frame: oneOf(r.frame, ['slim', 'wide', 'none']), wall: /^#[0-9a-f]{6}$/i.test(r.wall) ? r.wall : undefined,
      floor: oneOf(r.floor, ['concrete', 'oak', 'dark']), intro: str(r.intro, 4000) || undefined };
  },
  placements: (p) => (str(p?.id) && str(p.imageId) && str(p.roomId) && nums(p, ['edge', 's', 'y', 'w'])
    ? { id: str(p.id, 40), imageId: str(p.imageId, 40), roomId: str(p.roomId, 50), edge: Math.trunc(p.edge), s: p.s, y: p.y, w: p.w, rope: p.rope === true || undefined } : null),
  benches: (b) => (str(b?.id) && nums(b, ['x', 'y', 'rot', 'len'])
    ? { id: str(b.id, 40), x: b.x, y: b.y, rot: b.rot, len: b.len, layout: oneOf(b.layout, ['row', 'parallel']) } : null),
  objects: (o) => (str(o?.id) && oneOf(o.kind, ['pedestal', 'vitrine', 'counter']) && nums(o, ['x', 'y', 'rot'])
    ? { id: str(o.id, 40), kind: o.kind, x: o.x, y: o.y, rot: o.rot, item: oneOf(o.item, ['camera', 'videocam', 'books', 'print', 'none']), imageId: str(o.imageId, 40) || undefined } : null),
};
const MAX = { rooms: 200, placements: 5000, benches: 500, objects: 500 };

const upload = multer({ dest: path.join(DATA, 'tmp'), defParamCharset: 'utf8', limits: { fileSize: 200 * 1024 * 1024, files: 50 } });
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  });
  next();
});
app.use(express.json({ limit: '10mb' }));

app.get('/api/gallery', (_req, res) => res.json(gallery));

// Raum- und Wanddaten sowie Bildmetadaten speichern. Neue Bilder kommen nur über /api/upload.
app.put('/api/gallery', (req, res) => {
  const body = req.body || {};
  for (const k of Object.keys(clean)) { const v = list(body[k], MAX[k], clean[k]); if (v) gallery[k] = v; }
  if (Array.isArray(body.images)) {
    const byId = new Map(gallery.images.map((i) => [i.id, i]));
    for (const u of body.images) {
      const cur = byId.get(u?.id);
      if (cur) {
        if (typeof u.title === 'string') cur.title = str(u.title);
        if (typeof u.caption === 'string') cur.caption = str(u.caption, 2000);
        if (Array.isArray(u.tags)) cur.tags = u.tags.slice(0, 20).map((t) => str(String(t), 50).trim()).filter(Boolean);
      }
    }
  }
  save();
  res.json({ ok: true });
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  const added = [];
  const failed = [];
  const tags = String(req.body?.tags || '').split(',').slice(0, 20).map((t) => t.trim().slice(0, 50)).filter(Boolean);
  for (const f of req.files || []) {
    try {
      const id = crypto.randomBytes(8).toString('hex');
      const input = sharp(f.path).rotate(); // Standardlimit ~268 MP schützt vor Dekompressionsbomben
      // Original EXIF-korrekt ausrichten und als JPEG ablegen; die Ausgabe liefert gleich die gedrehten Maße mit.
      const meta = await input.clone().jpeg({ quality: 95 }).toFile(path.join(DATA, 'original', id + '.jpg'));
      await input.clone().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(path.join(DATA, 'thumb', id + '.jpg'));
      await input.clone().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(path.join(DATA, 'tex', id + '.jpg'));
      const title = path.parse(f.originalname).name.slice(0, 200);
      const img = { id, name: f.originalname.slice(0, 255), title, caption: '', tags, width: meta.width, height: meta.height, aspect: meta.width / meta.height };
      gallery.images.push(img);
      added.push(img);
    } catch (e) {
      failed.push({ name: f.originalname, error: String(e.message || e) });
    } finally {
      fs.rm(f.path, () => {});
    }
  }
  if (added.length) save();
  res.json({ added, failed });
});

app.delete('/api/images/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]+$/.test(id)) return res.status(400).end();
  gallery.images = gallery.images.filter((i) => i.id !== id);
  gallery.placements = gallery.placements.filter((p) => p.imageId !== id);
  for (const o of gallery.objects) if (o.imageId === id) delete o.imageId;
  for (const d of ['original', 'tex', 'thumb']) fs.rm(path.join(DATA, d, id + '.jpg'), () => {});
  save();
  res.json({ ok: true });
});

// nur die Bildordner freigeben (nicht gallery.json oder Upload-Reste in tmp/)
for (const d of ['original', 'tex', 'thumb']) app.use('/files/' + d, express.static(path.join(DATA, d), { maxAge: '7d', index: false }));

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  // Dateien mit Hash im Namen ändern sich nie; index.html immer neu prüfen, damit Updates sofort ankommen
  const cache = (res, p) => res.setHeader('Cache-Control', p.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : p.endsWith('.html') ? 'no-cache' : 'public, max-age=604800');
  app.use(express.static(dist, { setHeaders: cache }));
  app.use((req, res) => (req.method === 'GET' && !req.path.startsWith('/api') ? res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'index.html')) : res.status(404).end()));
}

// Fehler knapp beantworten, ohne Stacktrace
app.use((err, _req, res, _next) => {
  const code = err.type === 'entity.parse.failed' ? 400 : err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE' ? 413 : err instanceof multer.MulterError ? 400 : 500;
  if (code === 500) console.error(err);
  res.status(code).json({ error: code === 500 ? 'Serverfehler' : err.message });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Galerie läuft auf http://localhost:${PORT} (Daten: ${DATA})`));
