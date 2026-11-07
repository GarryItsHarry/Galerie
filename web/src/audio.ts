// Raumklang und Schritte, komplett synthetisch (keine Audiodateien nötig).
let ctx: AudioContext | null = null;
let master: GainNode, dry: GainNode, wet: GainNode, conv: ConvolverNode;
let enabled = true;
let roomKey = '';

function noiseBuffer(sec: number, brown = false) {
  const len = Math.floor(ctx!.sampleRate * sec), b = ctx!.createBuffer(1, len, ctx!.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return b;
}

function impulse(sec: number) {
  const rate = ctx!.sampleRate, len = Math.floor(rate * sec), b = ctx!.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return b;
}

/** Muss aus einer Nutzergeste heraus aufgerufen werden (Autoplay-Regel). */
export function startAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = enabled ? 0.6 : 0; master.connect(ctx.destination);
  dry = ctx.createGain(); dry.gain.value = 0.75; dry.connect(master);
  conv = ctx.createConvolver(); conv.buffer = impulse(1.2);
  wet = ctx.createGain(); wet.gain.value = 0.35; conv.connect(wet); wet.connect(master);
  // Raumrauschen
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(4, true); src.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
  const g = ctx.createGain(); g.gain.value = 0.035;
  src.connect(lp); lp.connect(g); g.connect(master); g.connect(conv);
  src.start();
}

export function setSound(on: boolean) {
  enabled = on;
  if (ctx) master.gain.setTargetAtTime(on ? 0.6 : 0, ctx.currentTime, 0.08);
}

export const audioState = () => (ctx ? ctx.state : 'none');

/** Hall an Raumgröße anpassen (nur bei Raumwechsel). */
export function setRoom(key: string, area: number, height: number) {
  if (!ctx || key === roomKey) return;
  roomKey = key;
  const vol = area * height;
  const sec = Math.max(0.7, Math.min(2.4, 0.5 + vol / 180));
  conv.buffer = impulse(sec);
  wet.gain.setTargetAtTime(Math.min(0.55, 0.22 + vol / 900), ctx.currentTime, 0.2);
}

// ---------- Ambient-Musik: langsam wechselnde Akkordflächen, gefiltert und mit Hall ----------
const CHORDS = [[130.81, 164.81, 196, 246.94, 293.66], [110, 130.81, 164.81, 196, 246.94], [87.31, 110, 130.81, 164.81, 196], [98, 123.47, 146.83, 185, 220]];
let musicGain: GainNode | null = null, musicFilter: BiquadFilterNode, musicOn = true, chordIdx = 0;

function playChord() {
  if (!ctx || !musicOn || ctx.state !== 'running') return;
  const t = ctx.currentTime, dur = 12;
  for (const f of CHORDS[chordIdx++ % CHORDS.length]) for (const det of [-4, 4]) {
    const o = ctx.createOscillator(); o.type = det < 0 ? 'sine' : 'triangle'; o.frequency.value = f; o.detune.value = det;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.045, t + 4); g.gain.setValueAtTime(0.045, t + dur - 4); g.gain.linearRampToValueAtTime(0, t + dur + 2);
    o.connect(g); g.connect(musicFilter); o.start(t); o.stop(t + dur + 2.1);
  }
}

export function setMusic(on: boolean) {
  musicOn = on;
  if (!ctx) return;
  if (!musicGain) {
    musicFilter = ctx.createBiquadFilter(); musicFilter.type = 'lowpass'; musicFilter.frequency.value = 900;
    musicGain = ctx.createGain(); musicGain.gain.value = 0;
    musicFilter.connect(musicGain); musicGain.connect(master); musicGain.connect(conv);
    setInterval(playChord, 10000);
  }
  musicGain.gain.setTargetAtTime(on ? 0.5 : 0, ctx.currentTime, 1.5);
  if (on) playChord();
}

export function footstep(floor: string, strength = 1) {
  if (!ctx || !enabled || ctx.state !== 'running') return;
  const t = ctx.currentTime, oak = floor === 'oak';
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.12);
  const f = ctx.createBiquadFilter();
  f.type = oak ? 'lowpass' : 'bandpass';
  f.frequency.value = (oak ? 700 : 1900) * (0.9 + Math.random() * 0.2); f.Q.value = oak ? 0.7 : 0.9;
  const g = ctx.createGain();
  const peak = (oak ? 0.32 : 0.22) * strength * (0.85 + Math.random() * 0.3);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.004); g.gain.exponentialRampToValueAtTime(0.001, t + (oak ? 0.12 : 0.08));
  src.connect(f); f.connect(g); g.connect(dry); g.connect(conv);
  src.start(t); src.stop(t + 0.14);
  // dumpfer Anteil (Absatz)
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(oak ? 95 : 120, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.06);
  const og = ctx.createGain(); og.gain.setValueAtTime(0.12 * strength, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  o.connect(og); og.connect(dry); o.start(t); o.stop(t + 0.08);
}
