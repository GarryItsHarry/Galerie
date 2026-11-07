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

const FILE = path.join(DATA, 'gallery.json');
let gallery = { images: [], rooms: [], placements: [], benches: [], objects: [] };
if (fs.existsSync(FILE)) gallery = { ...gallery, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(gallery, null, 2));
  fs.renameSync(tmp, FILE);
}

const upload = multer({ dest: path.join(DATA, 'tmp'), defParamCharset: 'utf8', limits: { fileSize: 200 * 1024 * 1024 } });
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/api/gallery', (_req, res) => res.json(gallery));

// Raum- und Wanddaten sowie Bildmetadaten speichern. Neue Bilder kommen nur über /api/upload.
app.put('/api/gallery', (req, res) => {
  const { rooms, placements, benches, objects, images } = req.body || {};
  if (Array.isArray(rooms)) gallery.rooms = rooms;
  if (Array.isArray(placements)) gallery.placements = placements;
  if (Array.isArray(benches)) gallery.benches = benches;
  if (Array.isArray(objects)) gallery.objects = objects;
  if (Array.isArray(images)) {
    const byId = new Map(gallery.images.map((i) => [i.id, i]));
    for (const u of images) {
      const cur = byId.get(u.id);
      if (cur) {
        if (typeof u.title === 'string') cur.title = u.title;
        if (typeof u.caption === 'string') cur.caption = u.caption;
        if (Array.isArray(u.tags)) cur.tags = u.tags.map(String);
      }
    }
  }
  save();
  res.json({ ok: true });
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  const added = [];
  const failed = [];
  const tags = String(req.body?.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  for (const f of req.files || []) {
    try {
      const id = crypto.randomBytes(8).toString('hex');
      const input = sharp(f.path, { limitInputPixels: false }).rotate();
      // Original EXIF-korrekt ausrichten und als JPEG ablegen; die Ausgabe liefert gleich die gedrehten Maße mit.
      const meta = await input.clone().jpeg({ quality: 95 }).toFile(path.join(DATA, 'original', id + '.jpg'));
      await input.clone().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(path.join(DATA, 'thumb', id + '.jpg'));
      await input.clone().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(path.join(DATA, 'tex', id + '.jpg'));
      const title = path.parse(f.originalname).name;
      const img = { id, name: f.originalname, title, caption: '', tags, width: meta.width, height: meta.height, aspect: meta.width / meta.height };
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
  app.use(express.static(dist));
  app.use((req, res) => (req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile(path.join(dist, 'index.html')) : res.status(404).end()));
}

app.listen(PORT, '0.0.0.0', () => console.log(`Galerie läuft auf http://localhost:${PORT} (Daten: ${DATA})`));
