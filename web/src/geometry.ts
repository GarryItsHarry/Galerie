import type { Bench, Gallery, ObjKind, Room } from './types';

/** Grundfläche (Breite × Tiefe in m) und Höhe der Objekte. */
export const OBJ_SIZE: Record<ObjKind, [number, number, number]> = { pedestal: [0.5, 0.5, 0.95], vitrine: [0.7, 0.7, 0.9], counter: [2, 0.6, 1.05] };

export const WALL_T = 0.12;      // Wanddicke (nach innen)
export const DOOR_H = 2.5;       // Türhöhe
export const DOOR_MARGIN = 0.15; // Mindestabstand Tür zur Ecke

export function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export interface Edge { ax: number; ay: number; bx: number; by: number; dx: number; dy: number; len: number; nx: number; ny: number }

/** Kante i eines Raums mit Richtung und nach innen zeigender Normale. */
export function edgeInfo(room: Room, i: number): Edge {
  const n = room.pts.length;
  const [ax, ay] = room.pts[i], [bx, by] = room.pts[(i + 1) % n];
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  const dx = (bx - ax) / len, dy = (by - ay) / len;
  const sg = signedArea(room.pts) >= 0 ? 1 : -1;
  return { ax, ay, bx, by, dx, dy, len, nx: -dy * sg, ny: dx * sg };
}

export function pointInPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(pts: [number, number][]): [number, number] {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) return pts[0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Ein sicherer Punkt im Raum (Schwerpunkt, sonst Mitte der längsten Innenlinie). */
export function interiorPoint(pts: [number, number][]): [number, number] {
  const c = centroid(pts);
  if (pointInPoly(c[0], c[1], pts)) return c;
  let best: [number, number] = pts[0], bd = -1;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const px = mx + (c[0] - mx) * 0.1, py = my + (c[1] - my) * 0.1;
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d > bd && pointInPoly(px, py, pts)) { bd = d; best = [px, py]; }
  }
  return best;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy || 1e-9;
  let t = ((px - ax) * vx + (py - ay) * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + vx * t, cy = ay + vy * t;
  return { d: Math.hypot(px - cx, py - cy), t, cx, cy };
}

export function doorWorld(room: Room, d: { edge: number; t: number }): [number, number] {
  const e = edgeInfo(room, d.edge);
  return [e.ax + e.dx * d.t, e.ay + e.dy * d.t];
}

/** Von der Wand freie Abschnitte [von,bis] einer Kante (ohne Türen). */
export function solidPieces(room: Room, i: number, withWindows = true): [number, number][] {
  const e = edgeInfo(room, i);
  const doors = [...room.doors, ...(withWindows ? room.windows || [] : [])].filter((d) => d.edge === i).map((d) => [d.t - d.w / 2, d.t + d.w / 2] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let cur = 0;
  for (const [a, b] of doors) {
    if (a > cur + 1e-4) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (e.len > cur + 1e-4) out.push([cur, e.len]);
  return out;
}

/** Freistehende Stellwand in großen Räumen (ab 60 m²): mittig, parallel zur längsten Wand, bis 5 m lang, mit 1,5 m
 *  Abstand zu allen Wänden. Als Pseudo-Raum mit 2 Punkten: Kante 0 und 1 sind die beiden Seiten, Normale zeigt nach außen. */
export function standWall(r: Room): Room | null {
  if (Math.abs(signedArea(r.pts)) < 60) return null;
  let best = 0, dx = 1, dy = 0;
  for (let i = 0; i < r.pts.length; i++) { const e = edgeInfo(r, i); if (e.len > best) { best = e.len; dx = e.dx; dy = e.dy; } }
  const proj = r.pts.map((p) => p[0] * dx + p[1] * dy), L = Math.min(5, 0.45 * (Math.max(...proj) - Math.min(...proj)));
  const [cx, cy] = interiorPoint(r.pts), ax = cx - (dx * L) / 2, ay = cy - (dy * L) / 2, bx = cx + (dx * L) / 2, by = cy + (dy * L) / 2;
  const m = 1.5, ok = [[ax - dx * m, ay - dy * m], [bx + dx * m, by + dy * m], [ax - dy * m, ay + dx * m], [ax + dy * m, ay - dx * m], [bx - dy * m, by + dx * m], [bx + dy * m, by - dx * m]]
    .every(([x, y]) => pointInPoly(x, y, r.pts));
  if (!ok || L < 2) return null;
  return { id: r.id + '~sw', name: '', tag: r.tag, height: r.height, frame: r.frame, wall: r.wall, pts: [[ax, ay], [bx, by]], doors: [], windows: [] };
}

/** Alle Räume plus ihre Stellwände (für Bildplatzierungen, die auf beiden Arten liegen können). */
export const allRooms = (rooms: Room[]) => [...rooms, ...rooms.map(standWall).filter((x): x is Room => !!x)];

/** Sitzpositionen einer Bank: in Räumen ab 40 m² zwei Bänke, in einer Reihe (0,4 m Abstand) oder parallel nebeneinander
 *  (0,3 m Abstand), wenn samt 1,2 m Laufweg Platz ist. */
export function benchSeats(b: Bench, rooms: Room[]): [number, number][] {
  const r = rooms.find((x) => pointInPoly(b.x, b.y, x.pts));
  // steht die Bank auf der Stellwand, rückt sie 1,6 m zur Seite
  const sw = r && standWall(r);
  if (sw) {
    const e = edgeInfo(sw, 0), { d } = distToSegment(b.x, b.y, e.ax, e.ay, e.bx, e.by);
    if (d < 1.4) b = { ...b, x: b.x + e.nx * (1.6 - d), y: b.y + e.ny * (1.6 - d) };
  }
  const par = b.layout === 'parallel';
  // Versatz der beiden Bänke: entlang der Bank (Reihe) oder quer dazu (parallel)
  const [ux, uy] = par ? [-Math.sin(b.rot), Math.cos(b.rot)] : [Math.cos(b.rot), Math.sin(b.rot)];
  const o = par ? 0.24 + 0.15 : b.len / 2 + 0.2;
  const reach = o + (par ? 0.24 : b.len / 2) + 1.2;
  const fits = r && Math.abs(signedArea(r.pts)) >= 40
    && pointInPoly(b.x + ux * reach, b.y + uy * reach, r.pts) && pointInPoly(b.x - ux * reach, b.y - uy * reach, r.pts);
  if (!fits) return [[b.x, b.y]];
  return [[b.x - ux * o, b.y - uy * o], [b.x + ux * o, b.y + uy * o]];
}

/** Bereinigt Türen/Bilder nach Änderungen am Grundriss. */
export function sanitize(G: Gallery) {
  const all = allRooms(G.rooms), roomIds = new Set(all.map((r) => r.id));
  for (const r of G.rooms) {
    const n = r.pts.length;
    const keep = (d: { edge: number; t: number; w: number }) => {
      if (d.edge >= n) return false;
      const L = edgeInfo(r, d.edge).len;
      if (L < d.w + 2 * DOOR_MARGIN) return false;
      d.t = Math.max(d.w / 2 + DOOR_MARGIN, Math.min(L - d.w / 2 - DOOR_MARGIN, d.t));
      return true;
    };
    r.doors = r.doors.filter(keep);
    r.windows = (r.windows || []).filter(keep);
  }
  G.benches = G.benches || [];
  G.objects = G.objects || [];
  const imgIds = new Set(G.images.map((i) => i.id));
  for (const o of G.objects) if (o.imageId && !imgIds.has(o.imageId)) delete o.imageId;
  G.placements = G.placements.filter((p) => {
    const r = all.find((x) => x.id === p.roomId);
    if (!r || !roomIds.has(p.roomId) || !imgIds.has(p.imageId) || p.edge >= r.pts.length) return false;
    const L = edgeInfo(r, p.edge).len;
    if (L < p.w + 0.2) return false;
    p.s = Math.max(p.w / 2 + 0.1, Math.min(L - p.w / 2 - 0.1, p.s));
    return true;
  });
}

/** Gegenstücke einer Tür in angrenzenden Räumen (kollineare, überlappende Kante). */
export function findNeighborEdges(G: Gallery, room: Room, edge: number, t: number): { room: Room; edge: number; t: number }[] {
  const e = edgeInfo(room, edge);
  const px = e.ax + e.dx * t, py = e.ay + e.dy * t;
  const res: { room: Room; edge: number; t: number }[] = [];
  for (const o of G.rooms) {
    if (o === room) continue;
    for (let j = 0; j < o.pts.length; j++) {
      const f = edgeInfo(o, j);
      const { d } = distToSegment(px, py, f.ax, f.ay, f.bx, f.by);
      if (d < 0.05 && Math.abs(f.dx * e.dy - f.dy * e.dx) < 0.02) {
        res.push({ room: o, edge: j, t: (px - f.ax) * f.dx + (py - f.ay) * f.dy });
      }
    }
  }
  return res;
}
