export type Quality = 'high' | 'medium';
export interface Prefs { quality: Quality; sound: boolean; bob: boolean; evening: boolean; music: boolean; figures: boolean }

const KEY = 'galerie-prefs';

export function autoQuality(): Quality {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 700;
  return coarse || small ? 'medium' : 'high';
}

export function loadPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const quality = saved.quality === 'high' || saved.quality === 'medium' ? saved.quality : autoQuality();
  return { quality, sound: saved.sound ?? true, bob: saved.bob ?? quality === 'high', evening: saved.evening ?? true, music: saved.music ?? true, figures: saved.figures ?? true };
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* privater Modus o. ä. */ }
}
