import { G, changed, esc, imgUrl, onChange, uid } from './store';
import type { Bench, Door, Img, Obj, Placement, Room } from './types';
import { OBJ_SIZE, WALL_T, allRooms, benchSeats, standWall, distToSegment, edgeInfo, findNeighborEdges, pointInPoly, sanitize, signedArea, doorWorld } from './geometry';
import { autoLayout, sizeFor } from './layout';

type Tool = 'select' | 'rect' | 'poly' | 'door' | 'window' | 'bench' | 'object' | 'place';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GRID = 0.25;
const snap = (v: number) => Math.round(v / GRID) * GRID;

const HINTS: Record<Tool, string> = {
  select: 'Raum anklicken und verschieben, Eckpunkte ziehen (Alt = nur eine Ecke). Bilder an der Wand ziehen.',
  rect: 'Rechteck mit gedrückter Maustaste aufziehen. Direkt an einen Raum anbauen, dann teilen sie eine Wand.',
  poly: 'Eckpunkte nacheinander klicken. Ersten Punkt anklicken oder Enter schließt den Raum, Esc bricht ab.',
  door: 'Auf eine Wand klicken setzt eine Tür (1,4 m). Auf eine vorhandene Tür klicken entfernt sie. Gemeinsame Wände öffnen sich beidseitig.',
  window: 'Auf eine Außenwand klicken setzt ein Fenster (1,6 m) mit Tageslicht. Auf ein Fenster klicken entfernt es.',
  bench: 'In einen Raum klicken stellt eine Bank auf. Danach mit „Auswahl“ verschieben und drehen.',
  object: 'In einen Raum klicken stellt einen Sockel auf. Art (Sockel, Vitrine, Tresen) und Inhalt wählst du danach links.',
  place: 'Links ein Bild wählen, dann auf die Wand klicken, an der es hängen soll.',
};

let canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D;
let tool: Tool = 'select';
let selRoom: string | null = null, selPl: string | null = null, selImg: string | null = null, selBench: string | null = null, selObj: string | null = null;
const view = { ox: -2, oy: -2, scale: 40 };
let fitted = false, active = false, spaceDown = false;
let mouse = { x: 0, y: 0, wx: 0, wy: 0 };
let drag: any = null;
let rectStart: [number, number] | null = null;
let polyPts: [number, number][] = [];
let hoverEdge: { room: Room; edge: number; t: number; d: number } | null = null;

const toS = (x: number, y: number): [number, number] => [(x - view.ox) * view.scale, (y - view.oy) * view.scale];
const toW = (sx: number, sy: number): [number, number] => [sx / view.scale + view.ox, sy / view.scale + view.oy];
const room = (id: string | null) => allRooms(G.rooms).find((r) => r.id === id) || null;
const img = (id: string) => G.images.find((i) => i.id === id);

export function setActive(a: boolean) {
  active = a;
  if (a) { resize(); if (!fitted) fit(); renderPanels(); draw(); }
}

export function fit() {
  fitted = true;
  const pts = G.rooms.flatMap((r) => r.pts);
  const W = canvas.clientWidth || 800, H = canvas.clientHeight || 600;
  if (!pts.length) { view.scale = 40; view.ox = -2; view.oy = -2; return; }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  view.scale = Math.max(8, Math.min(80, Math.min(W / (x1 - x0 + 4), H / (y1 - y0 + 4))));
  view.ox = (x0 + x1) / 2 - W / view.scale / 2; view.oy = (y0 + y1) / 2 - H / view.scale / 2;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function initEditor() {
  canvas = $('plan') as HTMLCanvasElement;
  ctx = canvas.getContext('2d')!;
  new ResizeObserver(() => { if (active) { resize(); draw(); } }).observe(canvas);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', () => { hoverEdge = null; draw(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('dblclick', () => { if (tool === 'poly') closePoly(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [wx, wy] = toW(e.offsetX, e.offsetY);
    view.scale = Math.max(5, Math.min(250, view.scale * Math.exp(-e.deltaY * 0.0015)));
    view.ox = wx - e.offsetX / view.scale; view.oy = wy - e.offsetY / view.scale;
    draw();
  }, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
  document.querySelectorAll<HTMLElement>('#tools button').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool as Tool);
  });
  const opts = () => ({ longSide: Number($<HTMLSelectElement>('lay-size').value), centerY: 1.55, mode: $<HTMLSelectElement>('lay-mode').value as 'row' | 'salon' });
  const msg = (r: { placed: number; left: number }) => {
    $('lay-msg').textContent = `${r.placed} Bilder aufgehängt` + (r.left ? `, ${r.left} passen nicht mehr auf die Wände (mehr Raum bauen oder kleinere Bildgröße).` : '.');
    changed();
  };
  $('lay-all').onclick = () => {
    if (G.placements.length && !confirm('Alle Bilder neu verteilen? Manuelle Positionen gehen verloren.')) return;
    msg(autoLayout(G, { ...opts(), clear: true }));
  };
  $('lay-rest').onclick = () => msg(autoLayout(G, { ...opts(), clear: false }));
  onChange(() => { if (active) { renderPanels(); draw(); } });
  (window as any).__plan = { toS: (x: number, y: number) => { const r = canvas.getBoundingClientRect(); const [sx, sy] = toS(x, y); return [r.left + sx, r.top + sy]; } };
  setTool('select');
}

function setTool(t: Tool) {
  tool = t; polyPts = []; rectStart = null; drag = null; hoverEdge = null;
  document.querySelectorAll<HTMLElement>('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('tool-hint').textContent = HINTS[t];
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  renderPanels(); draw();
}

// ---------- Hilfsfunktionen für Treffer ----------
function pickEdge(wx: number, wy: number, tolPx: number) {
  const tol = tolPx / view.scale;
  let best: { room: Room; edge: number; t: number; d: number } | null = null, bs = Infinity;
  for (const r of allRooms(G.rooms)) {
    const inside = pointInPoly(wx, wy, r.pts);
    for (let i = 0; i < r.pts.length; i++) {
      const e = edgeInfo(r, i);
      const { d, t } = distToSegment(wx, wy, e.ax, e.ay, e.bx, e.by);
      if (d > tol) continue;
      const score = d - (inside ? tol * 0.5 : 0);
      if (score < bs) { bs = score; best = { room: r, edge: i, t: t * e.len, d }; }
    }
  }
  return best;
}

function placementSeg(p: Placement) {
  const r = room(p.roomId); if (!r) return null;
  const e = edgeInfo(r, p.edge);
  const off = 6 / view.scale;
  const cx = e.ax + e.dx * p.s + e.nx * off, cy = e.ay + e.dy * p.s + e.ny * off;
  return { x1: cx - (e.dx * p.w) / 2, y1: cy - (e.dy * p.w) / 2, x2: cx + (e.dx * p.w) / 2, y2: cy + (e.dy * p.w) / 2 };
}

function hitPlacement(wx: number, wy: number): Placement | null {
  const tol = 8 / view.scale;
  let best: Placement | null = null, bd = tol;
  for (const p of G.placements) {
    const s = placementSeg(p); if (!s) continue;
    const { d } = distToSegment(wx, wy, s.x1, s.y1, s.x2, s.y2);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function hitVertices(wx: number, wy: number) {
  const tol = 10 / view.scale;
  let best: [number, number] | null = null, bd = tol;
  for (const r of G.rooms) for (const p of r.pts) {
    const d = Math.hypot(p[0] - wx, p[1] - wy);
    if (d < bd) { bd = d; best = [p[0], p[1]]; }
  }
  return best;
}

function hitRoom(wx: number, wy: number): Room | null {
  let best: Room | null = null, ba = Infinity;
  for (const r of G.rooms) if (pointInPoly(wx, wy, r.pts)) { const a = Math.abs(signedArea(r.pts)); if (a < ba) { ba = a; best = r; } }
  return best;
}

// ---------- Eingaben ----------
function updMouse(e: PointerEvent) {
  mouse.x = e.offsetX; mouse.y = e.offsetY;
  [mouse.wx, mouse.wy] = toW(e.offsetX, e.offsetY);
}

function onDown(e: PointerEvent) {
  updMouse(e);
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 2 || e.button === 1 || spaceDown) { drag = { kind: 'pan', sx: e.offsetX, sy: e.offsetY, ox: view.ox, oy: view.oy }; return; }
  if (e.button !== 0) return;
  const { wx, wy } = mouse;
  if (tool === 'select') {
    const p = hitPlacement(wx, wy);
    if (p) { selPl = p.id; selRoom = null; selBench = null; selObj = null; drag = { kind: 'pl', p, moved: false }; renderPanels(); draw(); return; }
    const b = hitBench(wx, wy);
    if (b) { selBench = b.id; selPl = null; selRoom = null; selObj = null; drag = { kind: 'bench', b, ox: b.x - wx, oy: b.y - wy, moved: false }; renderPanels(); draw(); return; }
    const ob = hitObj(wx, wy);
    if (ob) { selObj = ob.id; selBench = null; selPl = null; selRoom = null; drag = { kind: 'bench', b: ob, ox: ob.x - wx, oy: ob.y - wy, moved: false }; renderPanels(); draw(); return; }
    const v = hitVertices(wx, wy);
    if (v) {
      const refs: { pt: [number, number] }[] = [];
      for (const r of G.rooms) for (const pt of r.pts) {
        if (e.altKey ? pt[0] === v[0] && pt[1] === v[1] && refs.length === 0 : Math.hypot(pt[0] - v[0], pt[1] - v[1]) < 1e-3) refs.push({ pt });
      }
      drag = { kind: 'vtx', refs, moved: false };
      return;
    }
    const r = hitRoom(wx, wy);
    selPl = null; selBench = null; selObj = null; selRoom = r ? r.id : null;
    if (r) drag = { kind: 'room', r, start: r.pts.map((p) => [...p] as [number, number]), sx: wx, sy: wy, moved: false,
      benches: [...G.benches, ...G.objects].filter((b) => pointInPoly(b.x, b.y, r.pts)).map((b) => ({ b, x: b.x, y: b.y })) };
    renderPanels(); draw();
  } else if (tool === 'rect') {
    rectStart = [snap(wx), snap(wy)];
  } else if (tool === 'poly') {
    const p: [number, number] = [snap(wx), snap(wy)];
    if (polyPts.length >= 3 && Math.hypot(...toS(p[0] - polyPts[0][0] + view.ox, p[1] - polyPts[0][1] + view.oy)) < 12) closePoly();
    else polyPts.push(p);
    draw();
  } else if (tool === 'door') {
    const h = pickEdge(wx, wy, 14); if (h) toggleDoor(h);
  } else if (tool === 'window') {
    const h = pickEdge(wx, wy, 14); if (h) toggleWindow(h);
  } else if (tool === 'bench') {
    const r = hitRoom(wx, wy); if (r) addBench(r, snap(wx), snap(wy));
  } else if (tool === 'object') {
    if (hitRoom(wx, wy)) addObj(snap(wx), snap(wy));
  } else if (tool === 'place') {
    const h = pickEdge(wx, wy, 16); if (h && selImg) placeImage(h);
  }
}

function onMove(e: PointerEvent) {
  updMouse(e);
  const { wx, wy } = mouse;
  if (drag?.kind === 'pan') {
    view.ox = drag.ox - (e.offsetX - drag.sx) / view.scale; view.oy = drag.oy - (e.offsetY - drag.sy) / view.scale;
  } else if (drag?.kind === 'vtx') {
    const x = snap(wx), y = snap(wy);
    for (const r of drag.refs) { if (r.pt[0] !== x || r.pt[1] !== y) drag.moved = true; r.pt[0] = x; r.pt[1] = y; }
  } else if (drag?.kind === 'room') {
    const dx = snap(wx - drag.sx), dy = snap(wy - drag.sy);
    drag.r.pts.forEach((p: [number, number], i: number) => { p[0] = drag.start[i][0] + dx; p[1] = drag.start[i][1] + dy; });
    for (const o of drag.benches) { o.b.x = o.x + dx; o.b.y = o.y + dy; }
    if (dx || dy) drag.moved = true;
  } else if (drag?.kind === 'bench') {
    const x = snap(wx + drag.ox), y = snap(wy + drag.oy);
    if (x !== drag.b.x || y !== drag.b.y) { drag.b.x = x; drag.b.y = y; drag.moved = true; }
  } else if (drag?.kind === 'pl') {
    const h = pickEdge(wx, wy, 40);
    if (h) {
      const p: Placement = drag.p, L = edgeInfo(h.room, h.edge).len;
      p.roomId = h.room.id; p.edge = h.edge;
      p.s = Math.max(p.w / 2 + 0.1, Math.min(L - p.w / 2 - 0.1, Math.round(h.t * 20) / 20));
      drag.moved = true;
    }
  } else if (tool === 'door' || tool === 'window' || tool === 'place') {
    hoverEdge = pickEdge(wx, wy, tool === 'place' ? 16 : 14);
  }
  draw();
}

function onUp(e: PointerEvent) {
  updMouse(e);
  if (tool === 'rect' && rectStart) {
    const x1 = snap(mouse.wx), y1 = snap(mouse.wy), [x0, y0] = rectStart;
    rectStart = null;
    if (Math.abs(x1 - x0) >= 1.5 && Math.abs(y1 - y0) >= 1.5) addRoom([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  }
  if (drag && (drag.kind === 'vtx' || drag.kind === 'room' || drag.kind === 'pl' || drag.kind === 'bench') && drag.moved) { sanitize(G); changed(); }
  drag = null;
  draw();
}

function onKey(e: KeyboardEvent) {
  if (!active) return;
  const t = e.target as HTMLElement;
  if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
  if (e.key === 'Escape') { polyPts = []; rectStart = null; selPl = null; selRoom = null; selBench = null; selObj = null; renderPanels(); draw(); }
  if (e.key === 'Enter' && tool === 'poly') closePoly();
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selPl) removePlacement(selPl);
    else if (selBench) removeBench(selBench);
    else if (selObj) removeObj(selObj);
    else if (selRoom) removeRoom(selRoom);
  }
  if (e.key === 'f' || e.key === 'F') { fit(); draw(); }
  if ((e.key === 'r' || e.key === 'R') && selBench) rotateBench(selBench);
  if ((e.key === 'r' || e.key === 'R') && selObj) rotateObj(selObj);
}

// ---------- Aktionen ----------
function addRoom(pts: [number, number][]) {
  if (Math.abs(signedArea(pts)) < 2) return;
  const r: Room = { id: uid(), name: `Raum ${G.rooms.length + 1}`, tag: '', height: 3.2, pts, doors: [] };
  G.rooms.push(r); selRoom = r.id; selPl = null;
  setTool('select'); changed();
}

function closePoly() {
  if (polyPts.length >= 3) { const p = polyPts; polyPts = []; addRoom(p); } else polyPts = [];
}

function toggleDoor(h: { room: Room; edge: number; t: number }) {
  const hit = h.room.doors.find((d) => d.edge === h.edge && Math.abs(d.t - h.t) < d.w / 2);
  if (hit) {
    const [wx, wy] = doorWorld(h.room, hit);
    for (const r of G.rooms) r.doors = r.doors.filter((d) => { const [x, y] = doorWorld(r, d); return Math.hypot(x - wx, y - wy) > 0.25; });
  } else {
    const d: Door = { edge: h.edge, t: Math.round(h.t / GRID) * GRID, w: 1.4 };
    const len = edgeInfo(h.room, h.edge).len;
    if (len < d.w + 0.3) return;
    d.t = Math.max(d.w / 2 + 0.15, Math.min(len - d.w / 2 - 0.15, d.t));
    h.room.doors.push(d);
    for (const n of findNeighborEdges(G, h.room, h.edge, d.t)) n.room.doors.push({ edge: n.edge, t: n.t, w: d.w });
  }
  sanitize(G); changed();
}

function toggleWindow(h: { room: Room; edge: number; t: number }) {
  const ws = (h.room.windows ||= []);
  const hit = ws.find((d) => d.edge === h.edge && Math.abs(d.t - h.t) < d.w / 2);
  if (hit) h.room.windows = ws.filter((d) => d !== hit);
  else {
    const len = edgeInfo(h.room, h.edge).len, w = Math.min(1.6, len - 0.6);
    if (w < 0.6) return;
    const t = Math.max(w / 2 + 0.3, Math.min(len - w / 2 - 0.3, Math.round(h.t / GRID) * GRID));
    if (h.room.doors.some((d) => d.edge === h.edge && Math.abs(d.t - t) < (d.w + w) / 2 + 0.2)) return;
    ws.push({ edge: h.edge, t, w });
  }
  sanitize(G); changed();
}

function addBench(r: Room, x: number, y: number) {
  let best = 0, rot = 0;
  for (let i = 0; i < r.pts.length; i++) { const e = edgeInfo(r, i); if (e.len > best) { best = e.len; rot = Math.atan2(e.dy, e.dx); } }
  const b: Bench = { id: uid(), x, y, rot, len: 1.8 };
  G.benches.push(b); selBench = b.id; selRoom = null; selPl = null;
  setTool('select'); changed();
}
function hitBench(wx: number, wy: number): Bench | null {
  for (const b of G.benches) for (const [bx, by] of benchSeats(b, G.rooms)) {
    const dx = wx - bx, dy = wy - by, c = Math.cos(-b.rot), s = Math.sin(-b.rot);
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (Math.abs(lx) <= b.len / 2 + 0.05 && Math.abs(ly) <= 0.28) return b;
  }
  return null;
}
function addObj(x: number, y: number) {
  const o: Obj = { id: uid(), kind: 'pedestal', x, y, rot: 0, item: 'camera', imageId: G.images[0]?.id };
  G.objects.push(o); selObj = o.id; selRoom = null; selPl = null; selBench = null;
  setTool('select'); changed();
}
function hitObj(wx: number, wy: number): Obj | null {
  for (const o of G.objects) {
    const [w, d] = OBJ_SIZE[o.kind], dx = wx - o.x, dy = wy - o.y, c = Math.cos(-o.rot), s = Math.sin(-o.rot);
    if (Math.abs(dx * c - dy * s) <= w / 2 + 0.05 && Math.abs(dx * s + dy * c) <= d / 2 + 0.05) return o;
  }
  return null;
}
function rotateObj(id: string) { const o = G.objects.find((x) => x.id === id); if (o) { o.rot += Math.PI / 4; changed(); } }
function removeObj(id: string) { G.objects = G.objects.filter((o) => o.id !== id); selObj = null; changed(); }
function rotateBench(id: string) { const b = G.benches.find((x) => x.id === id); if (b) { b.rot += Math.PI / 4; changed(); } }
function removeBench(id: string) { G.benches = G.benches.filter((b) => b.id !== id); selBench = null; changed(); }

function placeImage(h: { room: Room; edge: number; t: number }) {
  const im = img(selImg!); if (!im) return;
  const { w } = sizeFor(im, Number($<HTMLSelectElement>('lay-size').value), h.room.height, 1.55);
  const L = edgeInfo(h.room, h.edge).len;
  if (L < w + 0.2) return;
  const p: Placement = { id: uid(), imageId: im.id, roomId: h.room.id, edge: h.edge, s: Math.max(w / 2 + 0.1, Math.min(L - w / 2 - 0.1, h.t)), y: 1.55, w };
  G.placements.push(p); selPl = p.id;
  const placed = new Set(G.placements.map((x) => x.imageId));
  selImg = G.images.find((i) => !placed.has(i.id))?.id ?? null;
  changed();
}

function removePlacement(id: string) { G.placements = G.placements.filter((p) => p.id !== id); selPl = null; changed(); }
function removeRoom(id: string) {
  const r = room(id); if (!r) return;
  if (!confirm(`„${r.name}“ löschen?`)) return;
  G.benches = G.benches.filter((b) => !pointInPoly(b.x, b.y, r.pts));
  G.objects = G.objects.filter((o) => !pointInPoly(o.x, o.y, r.pts));
  G.rooms = G.rooms.filter((x) => x.id !== id);
  sanitize(G); selRoom = null; changed();
}

// ---------- Seitenleisten ----------
function renderPanels() {
  const un = $('unplaced');
  const placed = new Set(G.placements.map((p) => p.imageId));
  const list = G.images.filter((i) => !placed.has(i.id));
  if (selImg && !list.some((i) => i.id === selImg)) selImg = null;
  un.innerHTML = list.length ? list.map((i) => `<div class="mini ${i.id === selImg ? 'sel' : ''}" data-id="${i.id}" title="${esc(i.title)}" style="background-image:url(${imgUrl(i.id, 'thumb')})"></div>`).join('') : '<p class="hint">Alle Bilder hängen.</p>';
  un.querySelectorAll<HTMLElement>('.mini').forEach((el) => { el.onclick = () => { selImg = el.dataset.id!; setTool('place'); }; });

  const rp = $('room-panel'), r = room(selRoom);
  if (!r) rp.innerHTML = '';
  else {
    const area = Math.abs(signedArea(r.pts));
    rp.innerHTML = `<h4>Raum</h4>
      <label>Name<input id="r-name" value="${esc(r.name)}" /></label>
      <label>Wandhöhe (m)<input id="r-h" type="number" min="2.2" max="8" step="0.1" value="${r.height}" /></label>
      <label>Rahmen<select id="r-frame"><option value="slim" ${(r.frame || 'slim') === 'slim' ? 'selected' : ''}>schwarz, schmal</option><option value="wide" ${r.frame === 'wide' ? 'selected' : ''}>schwarz, breit mit Passepartout</option><option value="none" ${r.frame === 'none' ? 'selected' : ''}>ohne Rahmen</option></select></label>
      <div class="row"><label style="flex:1">Wandfarbe<input id="r-wall" type="color" value="${r.wall || '#ffffff'}" /></label>
      <label style="flex:2">Boden<select id="r-floor"><option value="concrete" ${(r.floor || 'concrete') === 'concrete' ? 'selected' : ''}>Beton, hell poliert</option><option value="dark" ${r.floor === 'dark' ? 'selected' : ''}>Beton, dunkel</option><option value="oak" ${r.floor === 'oak' ? 'selected' : ''}>Eichenparkett</option></select></label></div>
      <label>Thema / Tag (Bilder mit diesem Tag kommen bevorzugt hierher)<input id="r-tag" value="${esc(r.tag)}" /></label>
      <label>Einführungstext (erscheint als Wandtafel neben der ersten Tür)<textarea id="r-intro" rows="4">${esc(r.intro || '')}</textarea></label>
      <p class="hint">${area.toFixed(1)} m² · ${r.doors.length} Tür(en) · ${(r.windows || []).length} Fenster</p>
      <button id="r-del">Raum löschen</button>`;
    ($('r-name') as HTMLInputElement).onchange = (e) => { r.name = (e.target as HTMLInputElement).value; changed(); };
    ($('r-h') as HTMLInputElement).onchange = (e) => { r.height = Math.max(2.2, Math.min(8, Number((e.target as HTMLInputElement).value) || 3.2)); changed(); };
    ($('r-tag') as HTMLInputElement).onchange = (e) => { r.tag = (e.target as HTMLInputElement).value.trim(); changed(); };
    ($('r-intro') as HTMLTextAreaElement).onchange = (e) => { r.intro = (e.target as HTMLTextAreaElement).value.trim(); changed(); };
    ($('r-frame') as HTMLSelectElement).onchange = (ev) => { r.frame = (ev.target as HTMLSelectElement).value as Room['frame']; changed(); };
    ($('r-wall') as HTMLInputElement).onchange = (ev) => { r.wall = (ev.target as HTMLInputElement).value; changed(); };
    ($('r-floor') as HTMLSelectElement).onchange = (ev) => { r.floor = (ev.target as HTMLSelectElement).value as Room['floor']; changed(); };
    $('r-del').onclick = () => removeRoom(r.id);
  }

  const pp = $('pl-panel'), p = G.placements.find((x) => x.id === selPl), im = p && img(p.imageId);
  const bn = G.benches.find((x) => x.id === selBench), ob = G.objects.find((x) => x.id === selObj);
  if (ob) {
    const opt = (v: string, l: string, cur?: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`;
    pp.innerHTML = `<hr /><h4>Objekt</h4>
      <label>Art<select id="o-kind">${opt('pedestal', 'Sockel', ob.kind)}${opt('vitrine', 'Vitrine (mit Glashaube)', ob.kind)}${opt('counter', 'Empfangstresen', ob.kind)}</select></label>
      ${ob.kind === 'counter' ? '<p class="hint">Auf dem Tresen liegen Postkarten und ein Katalog.</p>' : `<label>Inhalt<select id="o-item">${opt('camera', 'Alte Kamera', ob.item)}${opt('videocam', 'Alte Filmkamera', ob.item)}${opt('books', 'Fotobücher', ob.item)}${opt('print', 'Kleiner gerahmter Print', ob.item)}${opt('none', 'leer', ob.item)}</select></label>`}
      ${ob.kind === 'counter' || ob.item === 'books' || ob.item === 'print' ? `<label>Foto für ${ob.kind === 'counter' ? 'den Katalog' : ob.item === 'books' ? 'die Cover' : 'den Print'}<select id="o-img">${G.images.map((i) => opt(i.id, esc(i.title), ob.imageId)).join('')}</select></label>` : ''}
      <div class="row"><button id="o-rot">Drehen 45° (R)</button><button id="o-del">Entfernen</button></div>`;
    ($('o-kind') as HTMLSelectElement).onchange = (ev) => { ob.kind = (ev.target as HTMLSelectElement).value as Obj['kind']; changed(); };
    const it = document.getElementById('o-item') as HTMLSelectElement | null; if (it) it.onchange = () => { ob.item = it.value as Obj['item']; changed(); };
    const im2 = document.getElementById('o-img') as HTMLSelectElement | null; if (im2) im2.onchange = () => { ob.imageId = im2.value; changed(); };
    $('o-rot').onclick = () => rotateObj(ob.id);
    $('o-del').onclick = () => removeObj(ob.id);
  } else if (bn) {
    pp.innerHTML = `<hr /><h4>Bank</h4>
      <label>Länge<select id="b-len">${[1.2, 1.8, 2.4].map((v) => `<option value="${v}" ${v === bn.len ? 'selected' : ''}>${String(v).replace('.', ',')} m</option>`).join('')}</select></label>
      <label>Anordnung in großen Räumen (ab 40 m²)<select id="b-lay"><option value="row" ${bn.layout !== 'parallel' ? 'selected' : ''}>zwei Bänke in einer Reihe</option><option value="parallel" ${bn.layout === 'parallel' ? 'selected' : ''}>zwei Bänke parallel nebeneinander</option></select></label>
      <div class="row"><button id="b-rot">Drehen 45° (R)</button><button id="b-del">Entfernen</button></div>`;
    ($('b-len') as HTMLSelectElement).onchange = (ev) => { bn.len = Number((ev.target as HTMLSelectElement).value); changed(); };
    ($('b-lay') as HTMLSelectElement).onchange = (ev) => { bn.layout = (ev.target as HTMLSelectElement).value as 'row' | 'parallel'; changed(); };
    $('b-rot').onclick = () => rotateBench(bn.id);
    $('b-del').onclick = () => removeBench(bn.id);
  } else if (!p || !im) pp.innerHTML = '';
  else {
    pp.innerHTML = `<hr /><h4>${esc(im.title)}</h4>
      <label>Breite: <b id="p-wv">${p.w.toFixed(2)}</b> m · Höhe ${(p.w / im.aspect).toFixed(2)} m<input id="p-w" type="range" min="0.2" max="3" step="0.05" value="${p.w}" /></label>
      <label>Höhe der Bildmitte: <b id="p-yv">${p.y.toFixed(2)}</b> m<input id="p-y" type="range" min="0.8" max="2.6" step="0.05" value="${p.y}" /></label>
      <label style="display:flex;gap:8px;align-items:center"><input id="p-rope" type="checkbox" style="width:auto" ${p.rope ? 'checked' : ''} />Absperrkordel davor</label>
      <button id="p-del">Abhängen</button>`;
    const bind = (id: string, fn: (v: number) => void, out: string) => {
      const el = $(id) as HTMLInputElement;
      el.oninput = () => { fn(Number(el.value)); $(out).textContent = Number(el.value).toFixed(2); draw(); };
      el.onchange = () => { sanitize(G); changed(); };
    };
    bind('p-w', (v) => (p.w = v), 'p-wv'); bind('p-y', (v) => (p.y = v), 'p-yv');
    ($('p-rope') as HTMLInputElement).onchange = (ev) => { p.rope = (ev.target as HTMLInputElement).checked; changed(); };
    $('p-del').onclick = () => removePlacement(p.id);
  }
}

// ---------- Zeichnen ----------
function draw() {
  if (!active || !ctx) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  // Raster
  const [x0, y0] = toW(0, 0), [x1, y1] = toW(W, H);
  const step = view.scale >= 40 ? 0.5 : view.scale >= 16 ? 1 : 5;
  ctx.lineWidth = 1;
  for (let x = Math.floor(x0 / step) * step; x < x1; x += step) {
    const [sx] = toS(x, 0); ctx.strokeStyle = Math.round(x) === x && x % 5 === 0 ? '#34373c' : '#26292d';
    ctx.beginPath(); ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, H); ctx.stroke();
  }
  for (let y = Math.floor(y0 / step) * step; y < y1; y += step) {
    const [, sy] = toS(0, y); ctx.strokeStyle = Math.round(y) === y && y % 5 === 0 ? '#34373c' : '#26292d';
    ctx.beginPath(); ctx.moveTo(0, sy + 0.5); ctx.lineTo(W, sy + 0.5); ctx.stroke();
  }
  // Räume
  for (const r of G.rooms) {
    const sel = r.id === selRoom;
    ctx.beginPath();
    r.pts.forEach((p, i) => { const [sx, sy] = toS(p[0], p[1]); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.fillStyle = sel ? '#3a3524' : '#2d3035'; ctx.fill();
    ctx.lineWidth = Math.max(3, WALL_T * view.scale * 2); ctx.strokeStyle = sel ? '#e0b469' : '#b9bcc2'; ctx.lineJoin = 'miter'; ctx.stroke();
  }
  // Stellwände (automatisch in Räumen ab 60 m²)
  for (const r of G.rooms) {
    const sw = standWall(r); if (!sw) continue;
    const [ax, ay] = toS(sw.pts[0][0], sw.pts[0][1]), [bx, by] = toS(sw.pts[1][0], sw.pts[1][1]);
    ctx.lineWidth = Math.max(4, WALL_T * 2 * view.scale); ctx.strokeStyle = '#b9bcc2'; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  // Türen (als Lücke in der Wand) und Fenster (blau mit Mittellinie)
  for (const r of G.rooms) for (const [list, win] of [[r.doors, false], [r.windows || [], true]] as [Door[], boolean][]) for (const d of list) {
    const e = edgeInfo(r, d.edge);
    const [ax, ay] = toS(e.ax + e.dx * (d.t - d.w / 2), e.ay + e.dy * (d.t - d.w / 2));
    const [bx, by] = toS(e.ax + e.dx * (d.t + d.w / 2), e.ay + e.dy * (d.t + d.w / 2));
    ctx.lineWidth = Math.max(5, WALL_T * view.scale * 2 + (win ? 1 : 3)); ctx.strokeStyle = win ? '#9fd3ff' : '#4a4636'; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    if (win) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#2d3035'; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
  }
  // Bänke
  for (const b of G.benches) for (const [bx, by] of benchSeats(b, G.rooms)) {
    ctx.save(); const [sx, sy] = toS(bx, by); ctx.translate(sx, sy); ctx.rotate(b.rot);
    ctx.fillStyle = '#8a5a34'; ctx.fillRect((-b.len / 2) * view.scale, -0.225 * view.scale, b.len * view.scale, 0.45 * view.scale);
    if (b.id === selBench) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect((-b.len / 2) * view.scale, -0.225 * view.scale, b.len * view.scale, 0.45 * view.scale); }
    ctx.restore();
  }
  // Objekte
  for (const o of G.objects) {
    const [w, d] = OBJ_SIZE[o.kind];
    ctx.save(); const [sx, sy] = toS(o.x, o.y); ctx.translate(sx, sy); ctx.rotate(o.rot);
    ctx.fillStyle = o.kind === 'counter' ? '#6b6f76' : '#d9d6cf'; ctx.fillRect((-w / 2) * view.scale, (-d / 2) * view.scale, w * view.scale, d * view.scale);
    if (o.kind === 'vitrine') { ctx.strokeStyle = '#9fd3ff'; ctx.lineWidth = 2; ctx.strokeRect((-w / 2) * view.scale + 2, (-d / 2) * view.scale + 2, w * view.scale - 4, d * view.scale - 4); }
    if (o.id === selObj) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect((-w / 2) * view.scale, (-d / 2) * view.scale, w * view.scale, d * view.scale); }
    ctx.restore();
  }
  // Beschriftung
  ctx.textAlign = 'center'; ctx.font = '13px system-ui'; ctx.fillStyle = '#9a9ea5';
  for (const r of G.rooms) {
    const cx = r.pts.reduce((s, p) => s + p[0], 0) / r.pts.length, cy = r.pts.reduce((s, p) => s + p[1], 0) / r.pts.length;
    const [sx, sy] = toS(cx, cy);
    ctx.fillText(r.name + (r.tag ? ` · ${r.tag}` : ''), sx, sy);
    ctx.font = '11px system-ui'; ctx.fillText(`${Math.abs(signedArea(r.pts)).toFixed(0)} m²`, sx, sy + 15); ctx.font = '13px system-ui';
  }
  // Bilder
  for (const p of G.placements) {
    const s = placementSeg(p); if (!s) continue;
    const im = img(p.imageId);
    const [ax, ay] = toS(s.x1, s.y1), [bx, by] = toS(s.x2, s.y2);
    ctx.lineCap = 'round';
    ctx.lineWidth = p.id === selPl ? 8 : 5;
    ctx.strokeStyle = p.id === selPl ? '#ffffff' : !im ? '#888' : im.aspect > 1.15 ? '#6fb3e0' : im.aspect < 0.87 ? '#e08a6f' : '#8fd18f';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.lineCap = 'butt';
  // Eckpunkte des gewählten Raums
  const sr = room(selRoom);
  if (sr && tool === 'select') {
    ctx.fillStyle = '#e0b469';
    for (const p of sr.pts) { const [sx, sy] = toS(p[0], p[1]); ctx.fillRect(sx - 4, sy - 4, 8, 8); }
  }
  // Vorschauen
  ctx.strokeStyle = '#e0b469'; ctx.fillStyle = 'rgba(224,180,105,.15)'; ctx.lineWidth = 2;
  if (rectStart) {
    const [ax, ay] = toS(rectStart[0], rectStart[1]), [bx, by] = toS(snap(mouse.wx), snap(mouse.wy));
    ctx.fillRect(ax, ay, bx - ax, by - ay); ctx.strokeRect(ax, ay, bx - ax, by - ay);
    ctx.fillStyle = '#e0b469'; ctx.textAlign = 'left';
    ctx.fillText(`${Math.abs(snap(mouse.wx) - rectStart[0]).toFixed(2)} × ${Math.abs(snap(mouse.wy) - rectStart[1]).toFixed(2)} m`, bx + 8, by + 16);
  }
  if (polyPts.length) {
    ctx.beginPath();
    polyPts.forEach((p, i) => { const [sx, sy] = toS(p[0], p[1]); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.lineTo(...toS(snap(mouse.wx), snap(mouse.wy))); ctx.stroke();
    ctx.fillStyle = '#e0b469';
    for (const p of polyPts) { const [sx, sy] = toS(p[0], p[1]); ctx.fillRect(sx - 3, sy - 3, 6, 6); }
  }
  if (hoverEdge && (tool === 'door' || tool === 'window' || tool === 'place')) {
    const e = edgeInfo(hoverEdge.room, hoverEdge.edge);
    const half = (tool === 'door' ? 1.4 : tool === 'window' ? 1.6 : (img(selImg || '') ? sizeFor(img(selImg!) as Img, Number($<HTMLSelectElement>('lay-size').value), 3.2, 1.55).w : 1)) / 2;
    const t = hoverEdge.t;
    const [ax, ay] = toS(e.ax + e.dx * (t - half), e.ay + e.dy * (t - half)), [bx, by] = toS(e.ax + e.dx * (t + half), e.ay + e.dy * (t + half));
    ctx.lineWidth = 6; ctx.strokeStyle = tool === 'door' ? 'rgba(255,200,80,.8)' : 'rgba(255,255,255,.7)';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  if (tool === 'rect' || tool === 'poly') {
    const [sx, sy] = toS(snap(mouse.wx), snap(mouse.wy)); ctx.fillStyle = '#e0b469'; ctx.fillRect(sx - 2, sy - 2, 4, 4);
  }
}
