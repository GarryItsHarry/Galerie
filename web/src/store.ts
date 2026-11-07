import type { Gallery } from './types';
import { sanitize } from './geometry';

/** Statische Demo (npm run build:demo): Galerie aus gallery.json, kein Server, nichts wird gespeichert. */
export const DEMO = !!import.meta.env.VITE_DEMO;
export const G: Gallery = { images: [], rooms: [], placements: [], benches: [], objects: [] };
const listeners = new Set<() => void>();
let timer: number | undefined;
let statusEl: HTMLElement | null = null;

export const uid = () => Math.random().toString(36).slice(2, 10);
export const onChange = (fn: () => void) => { listeners.add(fn); };
export const setStatusEl = (el: HTMLElement) => { statusEl = el; };
const status = (s: string) => { if (statusEl) statusEl.textContent = s; };

export async function load() {
  const r = await fetch(DEMO ? 'gallery.json' : 'api/gallery');
  Object.assign(G, { benches: [], objects: [] }, await r.json());
  sanitize(G);
}

export function changed() {
  for (const fn of listeners) fn();
  status('Änderungen …');
  clearTimeout(timer);
  timer = window.setTimeout(save, 600);
}

export async function save() {
  if (DEMO) return status('Demo: Änderungen werden nicht gespeichert');
  try {
    const r = await fetch('api/gallery', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rooms: G.rooms, placements: G.placements, benches: G.benches, objects: G.objects, images: G.images }),
    });
    status(r.ok ? 'Gespeichert' : 'Speichern fehlgeschlagen');
  } catch { status('Speichern fehlgeschlagen'); }
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Bildplatzierungen in Rundgang-Reihenfolge (Raum, Wand, Position); Stellwände zählen zu ihrem Raum. */
export function tourPlacements() {
  const ri = new Map(G.rooms.map((r, i) => [r.id, i]));
  return G.placements.filter((p) => ri.has(p.roomId.split('~')[0])).sort((a, b) => ri.get(a.roomId.split('~')[0])! - ri.get(b.roomId.split('~')[0])! || a.edge - b.edge || a.s - b.s);
}

export const imgUrl = (id: string, kind: 'thumb' | 'tex' | 'original') => `files/${DEMO && kind === 'original' ? 'tex' : kind}/${id}.jpg`;
