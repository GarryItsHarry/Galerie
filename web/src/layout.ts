import type { Gallery, Img, Room, Placement } from './types';
import { edgeInfo, solidPieces, standWall } from './geometry';
import { uid } from './store';

export interface LayoutOpts { longSide: number; centerY: number; clear: boolean; mode?: 'row' | 'salon' }

const FRAME = 0.07;       // Passepartout + Rahmen je Seite
const GAP_MIN = 0.45;
const GAP_MAX = 1.1;
const CORNER = 0.5;
const DOOR_CLEAR = 0.4;

interface Seg { roomId: string; edge: number; a: number; b: number }

const fmt = (i: Img) => (i.aspect > 1.15 ? 0 : i.aspect < 0.87 ? 2 : 1);

export function sizeFor(img: Img, longSide: number, roomH: number, centerY: number) {
  let w = img.aspect >= 1 ? longSide : longSide * img.aspect;
  w = Math.min(w, 2.6);
  let h = w / img.aspect;
  const hmax = 2 * Math.min(centerY - 0.5, roomH - 0.3 - centerY);
  if (h > hmax) { w *= hmax / h; h = hmax; }
  return { w, h };
}

function segments(room: Room, existing: Placement[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < room.pts.length; i++) {
    const len = edgeInfo(room, i).len;
    for (const [a0, b0] of solidPieces(room, i)) {
      const a = a0 <= 1e-4 ? a0 + CORNER : a0 + DOOR_CLEAR;
      const b = Math.abs(b0 - len) <= 1e-4 ? b0 - CORNER : b0 - DOOR_CLEAR;
      let free: [number, number][] = b - a > 0.3 ? [[a, b]] : [];
      for (const p of existing.filter((p) => p.roomId === room.id && p.edge === i)) {
        const lo = p.s - p.w / 2 - FRAME - GAP_MIN / 2, hi = p.s + p.w / 2 + FRAME + GAP_MIN / 2;
        free = free.flatMap(([x, y]) => {
          if (hi <= x || lo >= y) return [[x, y] as [number, number]];
          const r: [number, number][] = [];
          if (lo - x > 0.3) r.push([x, lo]);
          if (y - hi > 0.3) r.push([hi, y]);
          return r;
        });
      }
      for (const [x, y] of free) out.push({ roomId: room.id, edge: i, a: x, b: y });
    }
  }
  return out;
}

const capacity = (segs: Seg[]) => segs.reduce((s, g) => s + (g.b - g.a), 0);

interface Unit { items: { img: Img; w: number; h: number }[]; fp: number }
const V_GAP = 0.16; // senkrechter Abstand in Gruppen (zwischen den Rahmen)

/** Fasst Bilder zu Hänge-Einheiten zusammen: Reihe = je ein Bild, Gruppe = Säulen aus 1–2 Bildern. */
function makeUnits(imgs: Img[], room: Room, o: LayoutOpts): Unit[] {
  const single = (img: Img, k = 1): Unit => { const { w, h } = sizeFor(img, o.longSide * k, room.height, o.centerY); return { items: [{ img, w, h }], fp: w + 2 * FRAME }; };
  if (o.mode !== 'salon') return imgs.map((i) => single(i));
  const hmax = 2 * Math.min(o.centerY - 0.45, room.height - 0.3 - o.centerY);
  const out: Unit[] = [];
  let i = 0, col = 0;
  while (i < imgs.length) {
    // jede dritte Säule ist ein einzelnes, größeres Ankerbild
    if (col % 3 === 1 || i === imgs.length - 1) { out.push(single(imgs[i], 0.85)); i++; col++; continue; }
    const a = sizeFor(imgs[i], o.longSide * 0.6, room.height, o.centerY), b = sizeFor(imgs[i + 1], o.longSide * 0.6, room.height, o.centerY);
    if (a.h + b.h + 4 * FRAME + V_GAP <= hmax) {
      out.push({ items: [{ img: imgs[i], ...a }, { img: imgs[i + 1], ...b }], fp: Math.max(a.w, b.w) + 2 * FRAME });
      i += 2;
    } else { out.push(single(imgs[i], 0.6)); i++; }
    col++;
  }
  return out;
}

/** Verteilt Bilder auf die Segmente eines Raums; liefert nicht untergebrachte Bilder zurück. */
function fillRoom(G: Gallery, room: Room, imgs: Img[], segs: Seg[], o: LayoutOpts): Img[] {
  let rest = makeUnits(imgs, room, o);
  const gapMin = o.mode === 'salon' ? 0.22 : GAP_MIN, gapMax = o.mode === 'salon' ? 0.4 : GAP_MAX;
  let remLen = capacity(segs);
  for (const seg of segs) {
    if (!rest.length) break;
    const len = seg.b - seg.a;
    const quota = Math.max(1, Math.ceil((rest.length * len) / remLen));
    remLen -= len;
    const take: Unit[] = [];
    let used = 0;
    for (const u of rest) {
      if (take.length >= quota) break;
      const need = used + u.fp + (take.length ? gapMin : 0);
      if (need > len) { if (!take.length) continue; else break; }
      take.push(u); used = need;
    }
    if (!take.length) continue;
    const sum = take.reduce((s, t) => s + t.fp, 0);
    const gap = Math.min(gapMax, (len - sum) / (take.length + 1));
    const total = sum + gap * (take.length - 1);
    let x = seg.a + (len - total) / 2;
    for (const u of take) {
      const s = x + u.fp / 2;
      if (u.items.length === 1) {
        const it = u.items[0];
        G.placements.push({ id: uid(), imageId: it.img.id, roomId: seg.roomId, edge: seg.edge, s, y: o.centerY, w: it.w });
      } else {
        const [t, b] = u.items, T = t.h + b.h + 4 * FRAME + V_GAP;
        G.placements.push({ id: uid(), imageId: t.img.id, roomId: seg.roomId, edge: seg.edge, s, y: o.centerY + T / 2 - FRAME - t.h / 2, w: t.w });
        G.placements.push({ id: uid(), imageId: b.img.id, roomId: seg.roomId, edge: seg.edge, s, y: o.centerY - T / 2 + FRAME + b.h / 2, w: b.w });
      }
      x += u.fp + gap;
    }
    rest = rest.filter((u) => !take.includes(u));
  }
  return rest.flatMap((u) => u.items.map((it) => it.img));
}

export function autoLayout(G: Gallery, o: LayoutOpts): { placed: number; left: number } {
  if (o.clear) G.placements = [];
  const placedIds = new Set(G.placements.map((p) => p.imageId));
  let pool = G.images.filter((i) => !placedIds.has(i.id));
  const total = pool.length;
  const key = (i: Img) => (i.tags[0] || '').toLowerCase();
  const order = (a: Img, b: Img) => key(a).localeCompare(key(b)) || fmt(a) - fmt(b) || a.title.localeCompare(b.title);
  pool.sort(order);

  const segMap = new Map<string, Seg[]>();
  // Stellwand-Seiten gehören zum Raum dazu
  const segsOf = (r: Room) => { const sw = standWall(r); const s = [...segments(r, G.placements), ...(sw ? segments(sw, G.placements) : [])]; segMap.set(r.id, s); return s; };

  // 1. Themenräume: Bilder, deren Tag zum Raum-Tag passt
  const themed = G.rooms.filter((r) => r.tag.trim());
  for (const r of themed) {
    const t = r.tag.trim().toLowerCase();
    const match = pool.filter((i) => i.tags.some((x) => x.toLowerCase() === t));
    if (!match.length) continue;
    const left = fillRoom(G, r, match, segsOf(r), o);
    const placed = new Set(match.filter((m) => !left.includes(m)).map((m) => m.id));
    pool = pool.filter((i) => !placed.has(i.id));
  }

  // 2. freie Räume: anteilig nach Wandlänge
  const free = G.rooms.filter((r) => !r.tag.trim());
  let capLeft = free.reduce((s, r) => s + capacity(segsOf(r)), 0);
  for (const r of free) {
    if (!pool.length) break;
    const segs = segMap.get(r.id)!;
    const cap = capacity(segs);
    const quota = Math.max(1, Math.ceil((pool.length * cap) / Math.max(capLeft, 1e-6)));
    capLeft -= cap;
    const part = pool.slice(0, quota);
    const left = fillRoom(G, r, part, segs, o);
    pool = [...left, ...pool.slice(quota)];
  }

  // 3. Rest in beliebige Räume mit freier Wand
  for (const r of G.rooms) {
    if (!pool.length) break;
    pool = fillRoom(G, r, pool, segsOf(r), o);
  }
  return { placed: total - pool.length, left: pool.length };
}
