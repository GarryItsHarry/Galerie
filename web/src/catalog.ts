import { PageFlip } from 'page-flip';
import 'page-flip/src/Style/stPageFlip.css';
import { G, esc, imgUrl, tourPlacements } from './store';
import type { Img } from './types';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
let book: PageFlip | null = null;
export const catalogOpen = () => !!book;

/** Kleiner Zufallsgenerator mit festem Startwert: dasselbe Bildangebot ergibt immer denselben Katalog. */
function rng(seed: number) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

const fig = (i: Img, cls = '') => `<figure class="${cls}"><img data-src="${imgUrl(i.id, 'tex')}" alt="" draggable="false" /><figcaption>${esc(i.title)}</figcaption></figure>`;

/** Bilder in Rundgang-Reihenfolge, danach die nicht aufgehängten. */
function ordered(): Img[] {
  const placed = tourPlacements();
  const seen = new Set<string>(), out: Img[] = [];
  for (const id of [...placed.map((p) => p.imageId), ...G.images.map((i) => i.id)]) {
    const im = G.images.find((x) => x.id === id);
    if (im && !seen.has(id)) { seen.add(id); out.push(im); }
  }
  return out;
}

/** Innenseiten mit wechselndem Layout: ein Bild groß, zwei Bilder, oder ein großes und zwei kleine. */
function innerPages(imgs: Img[]) {
  const rnd = rng(imgs.length * 7919 + 17), pages: string[] = [];
  let i = 0;
  while (i < imgs.length) {
    const a = imgs[i], b = imgs[i + 1], c = imgs[i + 2], r = rnd();
    if (!b || r < 0.3 || a.aspect < 0.8 && b.aspect >= 0.8) { pages.push(`<div class="cat-one">${fig(a)}</div>`); i += 1; }
    else if (!c || r < 0.7) { pages.push(`<div class="cat-two ${a.aspect < 0.8 && b.aspect < 0.8 ? 'side' : ''}">${fig(a)}${fig(b)}</div>`); i += 2; }
    else { pages.push(`<div class="cat-three">${fig(a, 'big')}<div class="row2">${fig(b)}${fig(c)}</div></div>`); i += 3; }
  }
  return pages;
}

export function openCatalog(coverId?: string) {
  if (book || !G.images.length) return;
  const imgs = ordered(), cover = G.images.find((i) => i.id === coverId) || imgs[0];
  const pages: string[] = [
    `<div class="cat-page cat-cover" data-density="hard"><div class="cov-img" style="background-image:url(${imgUrl(cover.id, 'tex')})"></div><h1>Katalog</h1><p>Fotografien · ${imgs.length} Arbeiten</p></div>`,
    `<div class="cat-page"><div class="cat-intro"><h2>Ausgewählte Arbeiten</h2><p>Die Reihenfolge folgt dem Rundgang durch die Ausstellung.</p>${G.rooms.map((r) => `<p class="room">${esc(r.name)}</p>`).join('')}</div></div>`,
    ...innerPages(imgs).map((html, k) => `<div class="cat-page">${html}<span class="pg-no">${k + 3}</span></div>`),
  ];
  if (pages.length % 2) pages.push('<div class="cat-page"><div class="cat-intro"><p>Notizen</p></div></div>');
  pages.push('<div class="cat-page cat-cover back" data-density="hard"><h1>Galerie</h1></div>');
  const host = $('c-book'); host.innerHTML = pages.join('');
  const ov = $('catalog'); ov.hidden = false;
  // Buch an die Fensterhöhe anpassen (page-flip setzt die Höhe selbst)
  const maxH = Math.max(360, ov.clientHeight - 110), maxW = Math.min(620, Math.round((maxH * 440) / 600));
  book = new PageFlip(host, {
    width: 440, height: 600, size: 'stretch', minWidth: 200, maxWidth: maxW, minHeight: 270, maxHeight: maxH,
    showCover: true, maxShadowOpacity: 0.45, flippingTime: 900, mobileScrollSupport: false, usePortrait: true,
  });
  const pageEls = [...host.querySelectorAll<HTMLElement>('.cat-page')];
  // Bilder der nächsten Seiten vorladen, damit beim Umblättern nichts leer ist (alle auf einmal wären bei 200 Fotos zu viel)
  const preload = (from: number) => pageEls.slice(Math.max(0, from - 2), from + 7).forEach((p) =>
    p.querySelectorAll<HTMLImageElement>('img[data-src]').forEach((im) => { im.src = im.dataset.src!; im.removeAttribute('data-src'); }));
  preload(0);
  book.loadFromHTML(pageEls);
  book.on('flip', (e) => preload(e.data));
}

export function closeCatalog() {
  if (!book) return;
  book.destroy(); book = null;
  $('catalog').hidden = true;
  // destroy() entfernt den Container mit; für das nächste Öffnen neu anlegen
  if (!document.getElementById('c-book')) { const d = document.createElement('div'); d.id = 'c-book'; $('catalog').appendChild(d); }
}

export const flipNext = () => book?.flipNext();
export const flipPrev = () => book?.flipPrev();

export function initCatalog() {
  $('c-close').onclick = closeCatalog;
  $('c-prev').onclick = flipPrev;
  $('c-next').onclick = flipNext;
}
