import { DEMO, G, changed, esc, imgUrl, onChange } from './store';
import type { Img } from './types';
import { sanitize } from './geometry';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const selected = new Set<string>();

function fmtOf(i: Img) { return i.aspect > 1.15 ? 'land' : i.aspect < 0.87 ? 'port' : 'sq'; }

export function initLibrary() {
  const drop = $('drop'), file = $<HTMLInputElement>('file');
  drop.onclick = () => file.click();
  file.onchange = () => { uploadFiles([...(file.files || [])]); file.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async (e) => {
    e.preventDefault(); drop.classList.remove('over');
    uploadFiles(await filesFromDrop(e.dataTransfer!));
  };
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('f-format').onchange = render; $('f-tag').onchange = render;
  $('sel-all').onclick = () => { visible().forEach((i) => selected.add(i.id)); render(); };
  $('sel-none').onclick = () => { selected.clear(); render(); };
  onChange(render);
  render();
}

async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: any): Promise<void> => {
    if (entry.isFile) {
      await new Promise<void>((res) => entry.file((f: File) => { out.push(f); res(); }, () => res()));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch: any[] = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  const entries = [...dt.items].map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e); else out.push(...dt.files);
  return out;
}

async function uploadFiles(files: File[]) {
  files = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|tiff?|heic|avif)$/i.test(f.name));
  if (!files.length) return;
  if (DEMO) { alert('In der Demo ist Hochladen abgeschaltet. Auf dem NAS funktioniert es.'); return; }
  const bar = $('progress'), fill = bar.querySelector('div') as HTMLElement, label = bar.querySelector('span') as HTMLElement;
  bar.hidden = false;
  const tags = $<HTMLInputElement>('up-tags').value;
  let done = 0, failed = 0;
  const tick = () => { fill.style.width = (100 * (done + failed)) / files.length + '%'; label.textContent = `${done + failed} / ${files.length}` + (failed ? ` · ${failed} Fehler` : ''); };
  tick();
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift()!;
      const fd = new FormData(); fd.append('tags', tags); fd.append('files', f);
      try {
        const r = await fetch('api/upload', { method: 'POST', body: fd });
        const j = await r.json();
        G.images.push(...j.added); done += j.added.length; failed += j.failed.length;
      } catch { failed++; }
      tick(); render();
    }
  };
  await Promise.all([worker(), worker()]);
  label.textContent += ' · fertig';
  setTimeout(() => (bar.hidden = true), 3000);
  changed();
}

function visible(): Img[] {
  const f = $<HTMLSelectElement>('f-format').value, t = $<HTMLSelectElement>('f-tag').value;
  return G.images.filter((i) => (!f || fmtOf(i) === f) && (!t || i.tags.includes(t)));
}

function render() {
  const tagSel = $<HTMLSelectElement>('f-tag'), cur = tagSel.value;
  const all = [...new Set(G.images.flatMap((i) => i.tags))].sort();
  tagSel.innerHTML = '<option value="">Alle</option>' + all.map((t) => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const list = visible();
  $('count').textContent = `${list.length} von ${G.images.length} Bildern`;
  const grid = $('grid');
  grid.innerHTML = list.map((i) => `<div class="card ${selected.has(i.id) ? 'sel' : ''}" data-id="${i.id}"><div class="im" style="background-image:url(${imgUrl(i.id, 'thumb')})"></div><div class="t">${esc(i.title)}</div><div class="tg">${esc(i.tags.join(', '))}</div></div>`).join('');
  grid.querySelectorAll<HTMLElement>('.card').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.id!;
      selected.has(id) ? selected.delete(id) : selected.add(id);
      render();
    };
  });
  renderEdit();
}

function renderEdit() {
  const p = $('edit-panel');
  const sel = G.images.filter((i) => selected.has(i.id));
  if (!sel.length) { p.innerHTML = '<p class="hint">Bilder anklicken, um Titel und Tags zu bearbeiten.</p>'; return; }
  const del = `<button id="e-del">${sel.length} Bild(er) löschen</button>`;
  if (sel.length === 1) {
    const i = sel[0];
    p.innerHTML = `<label>Titel<input id="e-title" value="${esc(i.title)}" /></label>
      <label>Bildunterschrift<textarea id="e-cap" rows="2">${esc(i.caption)}</textarea></label>
      <label>Tags (Komma getrennt)<input id="e-tags" value="${esc(i.tags.join(', '))}" /></label>
      <p class="hint">${i.width} × ${i.height} px</p>${del}`;
    const bind = (id: string, fn: (v: string) => void) => { ($(id) as HTMLInputElement).onchange = (e) => { fn((e.target as HTMLInputElement).value); changed(); }; };
    bind('e-title', (v) => (i.title = v));
    bind('e-cap', (v) => (i.caption = v));
    bind('e-tags', (v) => (i.tags = v.split(',').map((s) => s.trim()).filter(Boolean)));
  } else {
    p.innerHTML = `<label>Tags hinzufügen<input id="e-add" placeholder="z. B. Porträt" /></label>
      <div class="row"><button id="e-addbtn">Hinzufügen</button><button id="e-setbtn">Ersetzen</button></div>${del}`;
    const parse = () => ($('e-add') as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean);
    $('e-addbtn').onclick = () => { const t = parse(); sel.forEach((i) => (i.tags = [...new Set([...i.tags, ...t])])); changed(); };
    $('e-setbtn').onclick = () => { const t = parse(); sel.forEach((i) => (i.tags = t)); changed(); };
  }
  $('e-del').onclick = async () => {
    if (!confirm(`${sel.length} Bild(er) endgültig löschen?`)) return;
    for (const i of sel) {
      await fetch('api/images/' + i.id, { method: 'DELETE' });
      G.images = G.images.filter((x) => x.id !== i.id);
      selected.delete(i.id);
    }
    sanitize(G); changed();
  };
}
