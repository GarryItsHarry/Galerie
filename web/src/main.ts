import './style.css';
import { DEMO, load, setStatusEl, G } from './store';
import { initLibrary } from './library';
import { initEditor, setActive as editorActive } from './editor';
// 3D-Teil (three.js, ~1 MB) erst laden, wenn der Rundgang geöffnet wird: Bilder und Editor starten schneller
let viewer: Promise<typeof import('./viewer')> | null = null;
const loadViewer = () => (viewer ||= Promise.all([import('./viewer'), import('./catalog')]).then(([v, c]) => { v.initViewer(); c.initCatalog(); return v; }));

const views = ['library', 'editor', 'tour'] as const;
let current: (typeof views)[number] = 'library';

function show(v: (typeof views)[number]) {
  if (current === 'tour' && v !== 'tour') viewer?.then((m) => m.leaveTour());
  current = v;
  for (const n of views) (document.getElementById('view-' + n) as HTMLElement).hidden = n !== v;
  document.querySelectorAll<HTMLElement>('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  editorActive(v === 'editor');
  if (v === 'tour') loadViewer().then((m) => { if (current === 'tour') m.enterTour(); });
  location.hash = v;
}

async function main() {
  setStatusEl(document.getElementById('status')!);
  await load();
  initLibrary(); initEditor();
  document.querySelectorAll<HTMLElement>('nav button').forEach((b) => (b.onclick = () => show(b.dataset.view as any)));
  const h = location.hash.slice(1) as any;
  show(views.includes(h) ? h : DEMO ? 'tour' : G.images.length ? 'editor' : 'library');
}
main();
