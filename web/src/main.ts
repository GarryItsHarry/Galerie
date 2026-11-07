import './style.css';
import { DEMO, load, setStatusEl, G } from './store';
import { initLibrary } from './library';
import { initEditor, setActive as editorActive } from './editor';
import { initViewer, enterTour, leaveTour } from './viewer';
import { initCatalog } from './catalog';

const views = ['library', 'editor', 'tour'] as const;
let current: (typeof views)[number] = 'library';

function show(v: (typeof views)[number]) {
  if (current === 'tour' && v !== 'tour') leaveTour();
  current = v;
  for (const n of views) (document.getElementById('view-' + n) as HTMLElement).hidden = n !== v;
  document.querySelectorAll<HTMLElement>('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  editorActive(v === 'editor');
  if (v === 'tour') enterTour();
  location.hash = v;
}

async function main() {
  setStatusEl(document.getElementById('status')!);
  await load();
  initLibrary(); initEditor(); initViewer(); initCatalog();
  document.querySelectorAll<HTMLElement>('nav button').forEach((b) => (b.onclick = () => show(b.dataset.view as any)));
  const h = location.hash.slice(1) as any;
  show(views.includes(h) ? h : DEMO ? 'tour' : G.images.length ? 'editor' : 'library');
}
main();
