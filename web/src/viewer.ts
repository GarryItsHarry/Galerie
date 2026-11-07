import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { loadPrefs, savePrefs, type Prefs } from './quality';
import { startAudio, setSound, setMusic, setRoom, footstep, audioState } from './audio';
import { buildOutdoor } from './outdoor';
import { openCatalog, closeCatalog, catalogOpen, flipNext, flipPrev } from './catalog';
import { DEMO, G, imgUrl, tourPlacements } from './store';
import type { Placement, Room } from './types';
import { DOOR_H, OBJ_SIZE, WALL_T, allRooms, benchSeats, distToSegment, standWall, edgeInfo, interiorPoint, pointInPoly, signedArea, solidPieces } from './geometry';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const RADIUS = 0.32, EYE = 1.62;
// Demo-Hosting liefert nur gängige Web-Typen: dort liegen die Modelle als glTF mit eingebetteten Daten in .json (scripts/build-demo.mjs)
const GLTF = DEMO ? '.json' : '.gltf', GLB = DEMO ? '.json' : '.glb';

let renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera;
let world: THREE.Group | null = null;
let running = false, raf = 0, last = 0, tickAcc = 0;
let yaw = 0, pitch = 0, yawT = 0, pitchT = 0;
const vel = new THREE.Vector2();
let bobPhase = 0, bobAmt = 0;
let prefs: Prefs;
let composer: EffectComposer | null = null;
let reflector: Reflector | null = null;
let curRoom: Room | null = null;
let spotI = 22; // Spot-Helligkeit, am Abend stärker
const pos = new THREE.Vector2(0, 0); // x, z
const keys = new Set<string>();
let joy = { x: 0, y: 0 };
let colliders: [number, number, number, number][] = [];
let paints: Paint[] = [];
let pickables: THREE.Mesh[] = [];
const rayCaster = new THREE.Raycaster();
let bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
let hintTimer = 0;
let detailOpen = false;
let loaderBusy = 0;
let envTex: THREE.Texture | null = null;
interface Slot { sp: THREE.SpotLight; cur: Paint | null; next: Paint | null | undefined; lvl: number }
let slots: Slot[] = [];
const loadQueue: (() => void)[] = [];

interface Paint { grp: THREE.Group; oW: number; oH: number; spotAt: THREE.Vector3; label: THREE.Mesh | null; p: Placement; mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; at: THREE.Vector3; level: 0 | 1 | 2; want: 0 | 1 | 2; loading: boolean; tex: THREE.Texture | null; thumb: THREE.Texture | null }

/** Vier Kollisionskanten eines um rot gedrehten Rechtecks (halbe Breite hx, halbe Tiefe hz). */
function boxCollider(x: number, z: number, hx: number, hz: number, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([u, v]) => [x + u * c - v * s, z + u * s + v * c]);
  for (let k = 0; k < 4; k++) colliders.push([P[k][0], P[k][1], P[(k + 1) % 4][0], P[(k + 1) % 4][1]]);
}
/** Schatten für ein geladenes Modell (nur auf „Hoch“). */
const shade = (o: THREE.Object3D, high: boolean) => { if (high) o.traverse((c: any) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } }); return o; };

// ---------- Texturen ----------
// Texturen von Poly Haven (CC0), einmal geladen und zwischengespeichert
const texCache = new Map<string, THREE.Texture>();
function tex(name: string, srgb = false) {
  let t = texCache.get(name);
  if (!t) {
    t = new THREE.TextureLoader().load('textures/' + name + '_1k.jpg');
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(name, t);
  }
  return t;
}

function spotCookie() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.55, '#e8e8e8'); gr.addColorStop(0.72, '#fafafa'); gr.addColorStop(0.8, '#9a9a9a'); gr.addColorStop(1, '#000');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** Wandtafel: Raumname groß, darunter der Einführungstext (1 m breit). */
function introTexture(name: string, intro: string) {
  const W = 1024, c = document.createElement('canvas'), g0 = c.getContext('2d')!;
  g0.font = '32px system-ui, sans-serif';
  const lines: string[] = [];
  for (const para of intro.split(/\n+/)) {
    let line = '';
    for (const w of para.split(' ')) { const t = line ? line + ' ' + w : w; if (g0.measureText(t).width > W - 40 && line) { lines.push(line); line = w; } else line = t; }
    lines.push(line);
  }
  c.width = W; c.height = Math.ceil(120 + lines.length * 46 + 20);
  const g = c.getContext('2d')!;
  g.fillStyle = '#2f2f2f'; g.font = '300 64px system-ui, sans-serif'; g.textBaseline = 'top';
  g.fillText(name.toUpperCase().split('').join(String.fromCharCode(8202)), 20, 14);
  g.fillStyle = '#4a4a4a'; g.font = '32px system-ui, sans-serif';
  lines.forEach((l, i) => g.fillText(l, 20, 110 + i * 46));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return { t, h: c.height / W };
}

function textTexture(text: string) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a3a3a'; g.font = '300 96px system-ui, sans-serif'; g.textBaseline = 'middle';
  const shown = text.toUpperCase().split('').join(String.fromCharCode(8202));
  g.fillText(shown, 8, 84);
  const w = Math.min(1024, g.measureText(shown).width + 24); // gezeichneten Text messen, sonst wird der Rand abgeschnitten
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return { t, aspect: w / 160, u: w / 1024 };
}

function wallTexture() {
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 256, 0, 0); // unten -> oben
  gr.addColorStop(0, '#9c9a96'); gr.addColorStop(0.25, '#e4e2de'); gr.addColorStop(0.55, '#ffffff'); gr.addColorStop(0.85, '#d9d7d3'); gr.addColorStop(1, '#a8a6a2');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,236,205,1)'); gr.addColorStop(0.5, 'rgba(255,236,205,.35)'); gr.addColorStop(1, 'rgba(255,236,205,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function labelTexture(title: string, caption: string) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 120;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7f6f2'; g.fillRect(0, 0, 320, 120);
  g.strokeStyle = '#d6d4cf'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 317, 117);
  g.fillStyle = '#1b1b1b'; g.font = '600 28px system-ui, sans-serif'; g.textBaseline = 'top';
  const fit = (t: string, max: number) => { while (g.measureText(t).width > max && t.length > 3) t = t.slice(0, -2); return t; };
  g.fillText(fit(title, 290), 14, 12);
  g.fillStyle = '#555'; g.font = '22px system-ui, sans-serif';
  const words = caption.split(' '); let line = '', y = 52, n = 0;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (g.measureText(test).width > 290 && line) { g.fillText(line, 14, y); y += 28; line = w; if (++n >= 2) break; } else line = test;
  }
  if (n < 2 && line) g.fillText(fit(line, 290), 14, y);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

function shadowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.shadowColor = '#000'; g.shadowBlur = 14; g.fillStyle = '#000';
  g.fillRect(32, 32, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- Aufbau ----------
export function initViewer() {
  const canvas = $('three') as HTMLCanvasElement;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
  prefs = loadPrefs();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene(); scene.background = new THREE.Color(0xc9dcef);
  camera = new THREE.PerspectiveCamera(62, 1, 0.05, 400); camera.rotation.order = 'YXZ';
  RectAreaLightUniformsLib.init();
  const pm = new THREE.PMREMGenerator(renderer);
  envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
  new ResizeObserver(resize).observe(canvas);
  setupInput(canvas);
  setupDetail();
  setupBar();
  canvas.addEventListener('pointerdown', () => { startAudio(); setSound(prefs.sound); setMusic(prefs.music); });
  (window as any).__galerie = { teleport: (x: number, z: number, y = 0, p = 0) => { pos.set(x, z); yaw = yawT = y; pitch = pitchT = p; vel.set(0, 0); }, pos: () => [pos.x, pos.y], audio: () => audioState(), quality: () => prefs.quality, spots: () => slots.map((s) => Math.round(s.sp.intensity * 10) / 10), figures: () => mixers.length };
}

function resize() {
  const c = renderer.domElement, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  composer?.setSize(w, h);
  if (running) render();
}

function disposeWorld() {
  if (!world) return;
  world.traverse((o: any) => {
    o.geometry?.dispose?.();
    if (o.material) { for (const m of [].concat(o.material)) { (m as any).map?.dispose?.(); (m as any).dispose?.(); } }
  });
  reflector?.dispose(); reflector = null;
  composer?.dispose(); composer = null;
  scene.remove(world); world = null; paints = []; pickables = []; colliders = []; curRoom = null;
  loadQueue.length = 0; mixers = [];
}

function floorGeo(r: Room, y: number, up: boolean) {
  const contour = r.pts.map((p) => new THREE.Vector2(p[0], p[1]));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [];
  for (const f of faces) {
    let [a, b, c] = f.map((i) => r.pts[i]);
    const cross = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    if ((cross > 0) !== up) [b, c] = [c, b];
    for (const p of [a, b, c]) { pos.push(p[0], y, p[1]); uv.push(p[0] * 0.4, p[1] * 0.4); nrm.push(0, up ? 1 : -1, 0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

function build(resetPos = true) {
  disposeWorld();
  world = new THREE.Group(); scene.add(world);
  const high = prefs.quality === 'high', eve = prefs.evening;
  spotI = eve ? 34 : 22;
  renderer.shadowMap.enabled = high;
  const wallTex = wallTexture();
  const wallMats = new Map<string, THREE.MeshStandardMaterial>();
  const wallMatFor = (r: Room) => {
    const c = r.wall || '#ffffff';
    if (!wallMats.has(c)) wallMats.set(c, new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.94, map: wallTex, normalMap: tex('plaster_grey_04_nor_gl'), normalScale: new THREE.Vector2(0.22, 0.22), roughnessMap: tex('plaster_grey_04_rough') }));
    return wallMats.get(c)!;
  };
  const baseMat = new THREE.MeshStandardMaterial({ color: 0xe4e1da, roughness: 0.7 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 1 });
  const gapMat = new THREE.MeshStandardMaterial({ color: 0x2a2826, roughness: 1 });
  const concrete = tex('concrete_floor_worn_001_diff', true), cN = tex('concrete_floor_worn_001_nor_gl'), cR = tex('concrete_floor_worn_001_rough');
  const darkC = tex('hangar_concrete_floor_diff', true), dN = tex('hangar_concrete_floor_nor_gl'), dR = tex('hangar_concrete_floor_rough');
  const plank = tex('wood_floor_diff', true), pN = tex('wood_floor_nor_gl'), pR = tex('wood_floor_rough');
  // Auf „Hoch“ liegt unter dem Boden ein Spiegel; der Boden wird leicht durchscheinend.
  const fl = (o: number) => (high ? { transparent: true, opacity: o } : {});
  const floorMats = {
    concrete: new THREE.MeshStandardMaterial({ map: concrete, normalMap: cN, roughnessMap: cR, roughness: 0.75, metalness: 0.05, envMap: envTex, envMapIntensity: 0.5, ...fl(0.86) }),
    dark: new THREE.MeshStandardMaterial({ map: darkC, normalMap: dN, roughnessMap: dR, color: 0xffffff, roughness: 0.7, metalness: 0.08, envMap: envTex, envMapIntensity: 0.55, ...fl(0.8) }),
    oak: new THREE.MeshStandardMaterial({ map: plank, normalMap: pN, roughnessMap: pR, roughness: 1, metalness: 0.02, envMap: envTex, envMapIntensity: 0.3, ...fl(0.92) }),
  };
  const winFrameMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.6 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, roughness: 0.05, depthWrite: false });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a4e2b, roughness: 0.55, map: plank });
  const floorGlowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: eve ? 0.05 : 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const contactMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0.55, depthWrite: false });
  let rectLights = 0;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.5 });
  const matMat = new THREE.MeshStandardMaterial({ color: 0xf6f4ee, roughness: 1 });
  const shMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
  const box = (len: number, h: number, t: number) => new THREE.BoxGeometry(len, h, t);
  /** Wandkasten mit zweitem UV-Satz in Metern, damit die Putzstruktur nicht gestreckt wird. */
  const wbox = (len: number, h: number, t: number) => {
    const g = box(len, h, t), uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const uv1 = new Float32Array(uv.count * 2);
    for (let k = 0; k < uv.count; k++) { uv1[2 * k] = (uv.getX(k) * len) / 2; uv1[2 * k + 1] = (uv.getY(k) * h) / 2; }
    g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2)); return g;
  };
  const shadowy = (m: THREE.Mesh, cast = true, recv = true) => { if (high) { m.castShadow = cast; m.receiveShadow = recv; } return m; };

  const xs: number[] = [], ys: number[] = [];
  for (const r of G.rooms) {
    r.pts.forEach((p) => { xs.push(p[0]); ys.push(p[1]); });
    const H = r.height;
    const wallMat = wallMatFor(r);
    world.add(shadowy(new THREE.Mesh(floorGeo(r, 0, true), floorMats[r.floor || 'concrete']), false, true));
    world.add(new THREE.Mesh(floorGeo(r, H, false), ceilMat));
    for (let i = 0; i < r.pts.length; i++) {
      const e = edgeInfo(r, i), rotY = -Math.atan2(e.dy, e.dx);
      const put = (m: THREE.Mesh, s: number, off: number, y: number) => {
        m.position.set(e.ax + e.dx * s + e.nx * off, y, e.ay + e.dy * s + e.ny * off); m.rotation.y = rotY; world!.add(m); return m;
      };
      for (const [a, b] of solidPieces(r, i)) {
        const len = b - a, mid = (a + b) / 2;
        shadowy(put(new THREE.Mesh(wbox(len, H, WALL_T), wallMat), mid, WALL_T / 2, H / 2));
        put(new THREE.Mesh(box(len, 0.1, 0.014), baseMat), mid, WALL_T + 0.007, 0.05);
        put(new THREE.Mesh(box(len, 0.025, 0.02), gapMat), mid, WALL_T + 0.005, H - 0.0125); // Schattenfuge
      }
      const cx = WALL_T / 2;
      for (const [a, b] of solidPieces(r, i, false)) {
        colliders.push([e.ax + e.dx * a + e.nx * cx, e.ay + e.dy * a + e.ny * cx, e.ax + e.dx * b + e.nx * cx, e.ay + e.dy * b + e.ny * cx]);
      }
      // Fenster: Brüstung, Sturz, Rahmen, Glas und Flächenlicht. Draußen liegt die Landschaft (outdoor.ts).
      for (const w of (r.windows || []).filter((d) => d.edge === i)) {
        const sill = 0.45, top = Math.max(sill + 0.8, H - 0.35), wh = top - sill;
        shadowy(put(new THREE.Mesh(wbox(w.w, sill, WALL_T), wallMat), w.t, WALL_T / 2, sill / 2));
        put(new THREE.Mesh(box(w.w, 0.1, 0.014), baseMat), w.t, WALL_T + 0.007, 0.05);
        shadowy(put(new THREE.Mesh(wbox(w.w, H - top, WALL_T), wallMat), w.t, WALL_T / 2, top + (H - top) / 2));
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(w.w, wh), glassMat);
        put(glass, w.t, WALL_T / 2, sill + wh / 2); glass.rotation.y = Math.atan2(e.nx, e.ny);
        const fw = 0.05, fd = 0.06;
        put(new THREE.Mesh(box(w.w, fw, fd), winFrameMat), w.t, WALL_T / 2, sill + fw / 2);
        put(new THREE.Mesh(box(w.w, fw, fd), winFrameMat), w.t, WALL_T / 2, top - fw / 2);
        const nm = Math.max(1, Math.round(w.w / 0.8));
        for (let k = 0; k <= nm; k++) put(new THREE.Mesh(box(fw, wh, fd), winFrameMat), w.t - w.w / 2 + fw / 2 + (k * (w.w - fw)) / nm, WALL_T / 2, sill + wh / 2);
        put(new THREE.Mesh(box(w.w + 0.06, 0.03, WALL_T + 0.05), winFrameMat), w.t, WALL_T / 2 + 0.025, sill);
        if (rectLights < 6) {
          rectLights++;
          const rl = new THREE.RectAreaLight(eve ? 0xffb07a : 0xe4eeff, eve ? 1.6 : 7, w.w, wh);
          const cxw = e.ax + e.dx * w.t + e.nx * (WALL_T + 0.02), czw = e.ay + e.dy * w.t + e.ny * (WALL_T + 0.02);
          rl.position.set(cxw, sill + wh / 2, czw); rl.lookAt(cxw + e.nx, sill + wh / 2, czw + e.ny); world!.add(rl);
        }
        const fg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorGlowMat);
        fg.rotation.set(-Math.PI / 2, 0, -Math.atan2(e.dy, e.dx)); fg.scale.set(w.w * 1.8, 2.4, 1);
        fg.position.set(e.ax + e.dx * w.t + e.nx * (WALL_T + 1.1), 0.003, e.ay + e.dy * w.t + e.ny * (WALL_T + 1.1)); world!.add(fg);
      }
      for (const d of r.doors.filter((d) => d.edge === i)) {
        if (H > DOOR_H + 0.01) shadowy(put(new THREE.Mesh(wbox(d.w, H - DOOR_H, WALL_T), wallMat), d.t, WALL_T / 2, DOOR_H + (H - DOOR_H) / 2));
        // Zarge: zwei Pfosten und ein Kopfstück, leicht vor der Wand
        for (const sd of [-1, 1]) put(new THREE.Mesh(box(0.05, DOOR_H, WALL_T + 0.02), baseMat), d.t + sd * (d.w / 2 - 0.025), WALL_T / 2, DOOR_H / 2);
        put(new THREE.Mesh(box(d.w, 0.05, WALL_T + 0.02), baseMat), d.t, WALL_T / 2, DOOR_H - 0.025);
      }
    }
    // Stellwand: freistehend, doppelt so dick wie eine Raumwand, mit Sockelleisten auf beiden Seiten
    const sw = standWall(r);
    if (sw) {
      const e = edgeInfo(sw, 0), Hs = Math.min(H - 0.4, 3), mx = (e.ax + e.bx) / 2, mz = (e.ay + e.by) / 2;
      const m = shadowy(new THREE.Mesh(wbox(e.len, Hs, WALL_T * 2), wallMat)); m.position.set(mx, Hs / 2, mz); m.rotation.y = -Math.atan2(e.dy, e.dx); world.add(m);
      for (const sd of [1, -1]) { const bb = new THREE.Mesh(box(e.len, 0.1, 0.014), baseMat); bb.position.set(mx + e.nx * sd * (WALL_T + 0.007), 0.05, mz + e.ny * sd * (WALL_T + 0.007)); bb.rotation.y = m.rotation.y; world.add(bb); }
      colliders.push([e.ax, e.ay, e.bx, e.by]);
    }
    // Raumname als Wandschrift neben der ersten Tür, wenn dort Platz ist
    const d0 = r.doors[0];
    if (d0 && (r.name || r.intro)) {
      const txt = r.intro ? null : textTexture(r.name);
      const it = r.intro ? introTexture(r.name, r.intro) : null;
      const th = it ? it.h : 0.13, tw = it ? 1 : th * txt!.aspect;
      const isFree = (edge: number, s0: number) => s0 - tw / 2 > 0.3 && s0 + tw / 2 < edgeInfo(r, edge).len - 0.3
        && !G.placements.some((p) => p.roomId === r.id && p.edge === edge && Math.abs(p.s - s0) < p.w / 2 + tw / 2 + 0.2)
        && !r.doors.concat(r.windows || []).some((o) => o.edge === edge && Math.abs(o.t - s0) < o.w / 2 + tw / 2 + 0.1);
      // bevorzugt direkt neben der ersten Tür, sonst die erste freie Stelle an irgendeiner Wand
      const cands: [number, number][] = [[d0.edge, d0.t + d0.w / 2 + 0.35 + tw / 2], [d0.edge, d0.t - d0.w / 2 - 0.35 - tw / 2]];
      for (let i = 0; i < r.pts.length; i++) for (let s1 = 0.3 + tw / 2; s1 < edgeInfo(r, i).len; s1 += 0.25) cands.push([i, s1]);
      for (const [edge, s0] of cands) {
        if (!isFree(edge, s0)) continue;
        const e = edgeInfo(r, edge);
        if (txt) txt.t.repeat.set(txt.u, 1);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(tw, th), new THREE.MeshStandardMaterial({ map: it ? it.t : txt!.t, transparent: true, roughness: 0.9 }));
        m.position.set(e.ax + e.dx * s0 + e.nx * (WALL_T + 0.003), it ? 2.15 - th / 2 : 2.05, e.ay + e.dy * s0 + e.ny * (WALL_T + 0.003));
        m.rotation.y = Math.atan2(e.nx, e.ny); world.add(m);
        break;
      }
    }
    // Deckenlicht
    const area = Math.abs(signedArea(r.pts));
    const n = Math.min(3, Math.max(1, Math.round(area / 35)));
    const cands: [number, number][] = [];
    const rx = r.pts.map((p) => p[0]), ry = r.pts.map((p) => p[1]);
    for (let x = Math.min(...rx); x <= Math.max(...rx); x += 1.5) for (let y = Math.min(...ry); y <= Math.max(...ry); y += 1.5) if (pointInPoly(x, y, r.pts)) cands.push([x, y]);
    const lp: [number, number][] = [interiorPoint(r.pts)];
    while (lp.length < n && cands.length) {
      let best = cands[0], bd = -1;
      for (const c of cands) { const d = Math.min(...lp.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1]))); if (d > bd) { bd = d; best = c; } }
      lp.push(best);
    }
    for (const [x, y] of lp) {
      const L = new THREE.PointLight(eve ? 0xffd2a4 : 0xfff1de, (eve ? 0.42 : 1) * (high ? 13 : 15) * (H / 3.2) ** 2 * Math.min(1.6, Math.max(0.8, area / lp.length / 25)), 0, 2);
      L.position.set(x, H - 0.3, y); world.add(L);
    }
  }
  world.add(eve ? new THREE.HemisphereLight(0xffe0c0, 0x3a2e28, high ? 0.3 : 0.38) : new THREE.HemisphereLight(0xffffff, 0xcfc9bf, high ? 0.72 : 0.9));
  // Sockel, Vitrinen, Empfangstresen (Modelle für Kamera/Postkarten folgen in placeProps)
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.6 });
  const counterMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2d, roughness: 0.45 });
  const vGlass = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, roughness: 0.02, depthWrite: false });
  const photoMat = (id?: string) => {
    const im = G.images.find((i) => i.id === id) || G.images[0];
    if (!im) return { mat: plinthMat, aspect: 1.4 };
    const t = new THREE.TextureLoader().load(imgUrl(im.id, 'tex')); t.colorSpace = THREE.SRGBColorSpace;
    return { mat: new THREE.MeshStandardMaterial({ map: t, roughness: 0.55 }), aspect: im.aspect };
  };
  const bookColors = [0x1f2a33, 0x6b2b24, 0xd8d2c4];
  for (const o of G.objects || []) {
    const [w, d, h] = OBJ_SIZE[o.kind];
    const g = new THREE.Group(); g.position.set(o.x, 0, o.y); g.rotation.y = -o.rot; g.userData.obj = o;
    const body = shadowy(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), o.kind === 'counter' ? counterMat : plinthMat)); body.position.y = h / 2; g.add(body);
    let top = h;
    if (o.kind === 'counter') { const slab = shadowy(new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.04, d + 0.04), woodMat)); slab.position.y = h + 0.02; g.add(slab); top = h + 0.04; }
    if (o.kind === 'vitrine') {
      const gl = new THREE.Mesh(new THREE.BoxGeometry(w - 0.02, 0.45, d - 0.02), vGlass); gl.position.y = h + 0.225; g.add(gl);
      // dünne schwarze Kanten, damit die Glashaube als Vitrine erkennbar ist
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const k = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.45, 0.012), frameMat); k.position.set(sx * (w / 2 - 0.016), h + 0.225, sz * (d / 2 - 0.016)); g.add(k); }
      for (const [bw, bd, z, x] of [[w - 0.02, 0.012, d / 2 - 0.016, 0], [w - 0.02, 0.012, -(d / 2 - 0.016), 0], [0.012, d - 0.02, 0, w / 2 - 0.016], [0.012, d - 0.02, 0, -(w / 2 - 0.016)]]) {
        const k = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.012, bd), frameMat); k.position.set(x, h + 0.45, z); g.add(k);
      }
    }
    g.userData.top = top;
    const item = o.kind === 'counter' ? 'catalog' : o.item;
    if (item === 'books' || item === 'catalog') {
      // Stapel Fotobücher, das oberste mit deinem Foto auf dem Cover
      const ph = photoMat(o.imageId);
      let y = top;
      const stack = item === 'catalog' ? [[0.22, 0.02, 0.3]] : [[0.26, 0.032, 0.32], [0.23, 0.028, 0.3], [0.24, 0.03, 0.29]];
      stack.forEach(([bw, bh, bd], k) => {
        const b = shadowy(new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshStandardMaterial({ color: bookColors[k % 3], roughness: 0.7 })));
        b.position.set(item === 'catalog' ? -0.55 : 0, y + bh / 2, 0); b.rotation.y = (k - 1) * 0.12; g.add(b); y += bh;
      });
      const cw = 0.2, cov = new THREE.Mesh(new THREE.PlaneGeometry(cw, Math.min(0.27, cw / ph.aspect)), ph.mat);
      cov.rotation.set(-Math.PI / 2, 0, item === 'catalog' ? 0 : 0.12); cov.position.set(item === 'catalog' ? -0.55 : 0, y + 0.001, 0); g.add(cov);
      if (item === 'catalog') { cov.userData.catalog = o.imageId || ''; pickables.push(cov); } // anklickbar: öffnet den Katalog
    } else if (item === 'print') {
      // kleiner gerahmter Abzug auf einem Aufsteller, leicht nach hinten geneigt
      const ph = photoMat(o.imageId), pw = ph.aspect >= 1 ? 0.3 : 0.3 * ph.aspect, phh = pw / ph.aspect;
      const f = new THREE.Group(); f.position.set(0, top + phh / 2 + 0.03, 0); f.rotation.x = -0.2;
      const fr = shadowy(new THREE.Mesh(new THREE.BoxGeometry(pw + 0.05, phh + 0.05, 0.02), frameMat)); f.add(fr);
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(pw, phh), ph.mat); pic.position.z = 0.011; f.add(pic);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.02, phh * 0.9, 0.01), frameMat); leg.position.set(0, -0.02, -0.06); leg.rotation.x = 0.55; f.add(leg);
      g.add(f);
    }
    world.add(g);
    boxCollider(o.x, o.y, w / 2 + 0.02, d / 2 + 0.02, o.rot);
  }
  // Bänke mit Kontaktschatten
  for (const b of G.benches || []) for (const [bx, by] of benchSeats(b, G.rooms)) {
    const g = new THREE.Group(); g.position.set(bx, 0, by); g.rotation.y = -b.rot; g.userData.bench = b;
    const seat = shadowy(new THREE.Mesh(new THREE.BoxGeometry(b.len, 0.07, 0.42), woodMat)); seat.position.y = 0.415; g.add(seat);
    for (const sx of [-1, 1]) { const leg = shadowy(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.38, 0.42), woodMat)); leg.position.set(sx * (b.len / 2 - 0.035), 0.19, 0); g.add(leg); }
    const cs = new THREE.Mesh(new THREE.PlaneGeometry(b.len * 2.1, 0.42 * 2.6), contactMat); cs.rotation.x = -Math.PI / 2; cs.position.y = 0.004; g.add(cs);
    world.add(g);
    boxCollider(bx, by, b.len / 2, 0.24, b.rot);
  }
  if (xs.length) bounds = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  world.add(buildOutdoor(bounds, eve));
  if (high && xs.length) {
    const w = bounds.x1 - bounds.x0 + 2, d = bounds.y1 - bounds.y0 + 2, c = renderer.domElement;
    reflector = new Reflector(new THREE.PlaneGeometry(w, d), { textureWidth: Math.max(256, c.clientWidth / 2), textureHeight: Math.max(256, c.clientHeight / 2), color: 0x8a8a8a, clipBias: 0.003 });
    reflector.rotation.x = -Math.PI / 2; reflector.position.set((bounds.x0 + bounds.x1) / 2, -0.002, (bounds.y0 + bounds.y1) / 2);
    world.add(reflector);
  }

  // Spot-Pool: wenige echte Spots folgen dem Besucher, alle anderen Bilder haben nur einen Lichtschein
  slots = [];
  // iPhone/iPad erlauben nur 16 Texturen je Shader; 8 Schatten + 8 Cookies + Materialtexturen wären zu viel
  const cookie = high && renderer.capabilities.maxTextures >= 24 ? spotCookie() : null;
  for (let i = 0; i < 8; i++) {
    const sp = new THREE.SpotLight(eve ? 0xffcf9e : 0xffe4c4, 0, 0, 0.42, 0.75, 2);
    if (high) {
      sp.castShadow = true; sp.map = cookie; sp.shadow.mapSize.set(1024, 1024);
      sp.shadow.bias = -0.0004; sp.shadow.normalBias = 0.02; sp.shadow.camera.near = 0.2; sp.shadow.camera.far = 8;
    }
    world.add(sp, sp.target); slots.push({ sp, cur: null, next: undefined, lvl: 0 });
  }
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: (high ? 0.12 : 0.2) * (eve ? 1.6 : 1), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.6 });
  const fixGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.16, 10);
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.9, roughness: 0.3, envMap: envTex });
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0x7a1020, roughness: 0.8 });

  // Bilder
  const planeGeo = new THREE.PlaneGeometry(1, 1);
  const rails = new Map<string, { r: Room; edge: number; lo: number; hi: number }>();
  const rooms = allRooms(G.rooms);
  for (const p of G.placements) {
    const r = rooms.find((x) => x.id === p.roomId), im = G.images.find((i) => i.id === p.imageId);
    if (!r || !im) continue;
    const e = edgeInfo(r, p.edge), h = p.w / im.aspect;
    const st = r.frame || 'slim';
    const matB = st === 'wide' ? 0.09 : st === 'none' ? 0 : 0.045, frB = st === 'wide' ? 0.055 : st === 'none' ? 0 : 0.028, depth = st === 'wide' ? 0.055 : st === 'none' ? 0.02 : 0.04;
    const oW = p.w + 2 * (matB + frB), oH = h + 2 * (matB + frB);
    const g = new THREE.Group();
    g.position.set(e.ax + e.dx * p.s + e.nx * WALL_T, p.y, e.ay + e.dy * p.s + e.ny * WALL_T);
    g.rotation.y = Math.atan2(e.nx, e.ny);
    const gl = new THREE.Mesh(planeGeo, glowMat); gl.scale.set(oW * 2.4 + 0.6, oH * 2.4 + 0.6, 1); gl.position.set(0, oH * 0.15, 0.003); g.add(gl);
    if (!high) { const sh = new THREE.Mesh(planeGeo, shMat); sh.scale.set(oW * 2, oH * 2, 1); sh.position.set(0, -0.035, 0.002); g.add(sh); }
    const fr = shadowy(new THREE.Mesh(new THREE.BoxGeometry(oW, oH, depth), frameMat), true, false); fr.position.z = depth / 2; g.add(fr);
    if (matB > 0) { const mt = shadowy(new THREE.Mesh(planeGeo, matMat), false, true); mt.scale.set(p.w + 2 * matB, h + 2 * matB, 1); mt.position.z = depth + 0.001; g.add(mt); }
    // Foto als beleuchtetes Material: Farbe + schwaches Eigenleuchten, auf „Hoch“ mit leichtem Glanz
    const pm: THREE.MeshStandardMaterial = high
      ? new THREE.MeshPhysicalMaterial({ color: 0x8a8a8a, roughness: 0.65, clearcoat: 0.25, clearcoatRoughness: 0.35, envMap: envTex, envMapIntensity: 0.25, emissive: 0x000000, emissiveIntensity: 0.32 })
      : new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.75, emissive: 0x000000, emissiveIntensity: 0.38 });
    const mesh = shadowy(new THREE.Mesh(planeGeo, pm), false, true); mesh.scale.set(p.w, h, 1); mesh.position.z = depth + 0.003; mesh.userData.pid = p.id; g.add(mesh);
    world.add(g); pickables.push(mesh);
    g.updateMatrixWorld(true);
    const at = new THREE.Vector3(); mesh.getWorldPosition(at);
    // Schiene + Strahler
    const RAIL = 1.1, H = r.height;
    const spotAt = new THREE.Vector3(e.ax + e.dx * p.s + e.nx * (WALL_T + RAIL), H - 0.1, e.ay + e.dy * p.s + e.ny * (WALL_T + RAIL));
    const fix = new THREE.Mesh(fixGeo, railMat); fix.position.copy(spotAt);
    fix.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), at.clone().sub(spotAt).normalize()); world.add(fix);
    const key = r.id + ':' + p.edge, rl = rails.get(key);
    if (rl) { rl.lo = Math.min(rl.lo, p.s); rl.hi = Math.max(rl.hi, p.s); } else rails.set(key, { r, edge: p.edge, lo: p.s, hi: p.s });
    if (p.rope) addRope(e, p.s, oW);
    paints.push({ grp: g, oW, oH, spotAt, label: null, p, mesh, mat: pm, at, level: 0, want: 0, loading: false, tex: null, thumb: null });
  }
  // Absperrkordel: zwei Messingpfosten 0,75 m vor der Wand, dazwischen eine durchhängende Samtkordel
  function addRope(e: ReturnType<typeof edgeInfo>, s: number, oW: number) {
    const d = WALL_T + 0.75, half = oW / 2 + 0.25, P: THREE.Vector3[] = [];
    for (const sd of [-1, 1]) {
      const x = e.ax + e.dx * (s + sd * half) + e.nx * d, z = e.ay + e.dy * (s + sd * half) + e.ny * d;
      const post = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.92, 12), brassMat)); post.position.set(x, 0.46, z); world!.add(post);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.03, 24), brassMat); base.position.set(x, 0.015, z); world!.add(base);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), brassMat); ball.position.set(x, 0.94, z); world!.add(ball);
      P.push(new THREE.Vector3(x, 0.88, z));
    }
    const mid = P[0].clone().add(P[1]).multiplyScalar(0.5); mid.y -= 0.16;
    world!.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(P[0], mid, P[1]), 24, 0.016, 8), ropeMat));
    colliders.push([P[0].x, P[0].z, P[1].x, P[1].z]);
  }
  for (const { r, edge, lo, hi } of rails.values()) {
    const e = edgeInfo(r, edge), a = Math.max(0, lo - 0.35), b = Math.min(e.len, hi + 0.35), mid = (a + b) / 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(b - a, 0.03, 0.04), railMat);
    m.position.set(e.ax + e.dx * mid + e.nx * (WALL_T + 1.1), r.height - 0.03, e.ay + e.dy * mid + e.ny * (WALL_T + 1.1));
    m.rotation.y = -Math.atan2(e.dy, e.dx); world.add(m);
  }
  placeProps(world, high);
  placeFigures(world, high);
  renderer.shadowMap.needsUpdate = true;
  setupComposer();
  // Shader vorab übersetzen, damit der erste Schritt nicht ruckelt
  const hint = $('tour-hint'), prev = hint.textContent;
  hint.textContent = 'Licht wird eingerichtet …'; hint.style.opacity = '1';
  renderer.compileAsync(scene, camera).catch(() => {}).finally(() => { if (hint.textContent === 'Licht wird eingerichtet …') hint.textContent = prev; });
  // Startposition
  const r0 = G.rooms[0];
  if (r0 && resetPos) {
    const ip = interiorPoint(r0.pts); pos.set(ip[0], ip[1]); vel.set(0, 0);
    const first = paints.find((q) => q.p.roomId === r0.id) || paints[0];
    yaw = yawT = first ? Math.atan2(-(first.at.x - pos.x), -(first.at.z - pos.y)) : 0; pitch = pitchT = 0;
  }
}

// ---------- Ausstattung: Pflanzen, Feuerlöscher (Poly Haven, CC0), Notausgang-Schild ----------
const MODELS = { plant1: 'potted_plant_01', plant2: 'potted_plant_02', ext: 'korean_fire_extinguisher_01', bench: 'Ottoman_01', camera: 'Camera_01', videocam: 'vintage_video_camera', postcards: 'postcard_set_01' } as const;
let modelsReady: Promise<Record<keyof typeof MODELS, THREE.Object3D>> | null = null;
let mixers: THREE.AnimationMixer[] = [];
let figuresReady: Promise<{ body: THREE.Object3D; clips: THREE.AnimationClip[] }> | null = null;
// KayKit Mannequin + Idle-Animationen (CC0, Kay Lousberg)
function loadFigures() {
  const l = new GLTFLoader();
  return (figuresReady ||= Promise.all([l.loadAsync('models/kaykit/mannequin' + GLB), l.loadAsync('models/kaykit/anims_general' + GLB)])
    .then(([m, a]) => ({ body: m.scene, clips: a.animations.filter((c) => c.name.startsWith('Idle'))
      .map((c) => new THREE.AnimationClip(c.name, c.duration, c.tracks.filter((t) => !t.name.startsWith('handslot') && !t.name.endsWith('.scale')))) })));
}
const CLOTHES = [0x4a5d7a, 0xb3a487, 0x6e6e72, 0x7d8a66, 0xa0634c, 0xc4c9cf];

/** Ein bis zwei Besucher je Raum: 1,5 m vor einem Bild stehend, dem Bild zugewandt, leicht animiert. */
function placeFigures(w: THREE.Group, high: boolean) {
  if (!prefs.figures) return;
  loadFigures().then(({ body, clips }) => {
    if (world !== w) return;
    const rooms = allRooms(G.rooms), size = new THREE.Box3().setFromObject(body).getSize(new THREE.Vector3());
    const blocked = (x: number, z: number) => colliders.some(([ax, ay, bx, by]) => distToSegment(x, z, ax, ay, bx, by).d < 0.6);
    let n = 0;
    G.rooms.forEach((room) => {
      const pl = G.placements.filter((p) => p.roomId === room.id || p.roomId === room.id + '~sw');
      const want = pl.length >= 6 ? 2 : pl.length ? 1 : 0, start = Math.floor(pl.length * 0.3);
      let placed = 0;
      for (let k = 0; k < pl.length && placed < want; k++) {
        const p = pl[(start + k * 3) % pl.length]; // verteilt über den Raum, nicht nebeneinander
        const r = rooms.find((x) => x.id === p.roomId); if (!r) continue;
        const e = edgeInfo(r, p.edge), d = WALL_T + 1.5 + (n % 2) * 0.3;
        const x = e.ax + e.dx * (p.s + 0.3) + e.nx * d, z = e.ay + e.dy * (p.s + 0.3) + e.ny * d;
        if (!pointInPoly(x, z, room.pts) || blocked(x, z)) continue;
        const f = cloneSkinned(body);
        f.scale.setScalar((1.68 + (n % 3) * 0.06) / size.y);
        f.position.set(x, 0, z); f.rotation.y = Math.atan2(-e.nx, -e.ny); // Blick zum Bild (+Z ist vorne)
        const col = new THREE.Color(CLOTHES[n % CLOTHES.length]);
        // einfarbig wie eine Schaufensterpuppe in Kleidungsfarbe, ohne die bunte Original-Textur
        f.traverse((c: any) => { if (c.isMesh) { c.material = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: col, emissiveIntensity: 0.18 }); if (high) { c.castShadow = true; c.receiveShadow = true; } } });
        // KayKit hat Comic-Proportionen: Kopf verkleinern, damit die Figur erwachsener wirkt
        const head = f.getObjectByName('head'); if (head) head.scale.setScalar(0.58);
        w.add(f);
        if (clips.length) {
          const mx = new THREE.AnimationMixer(f), act = mx.clipAction(clips[n % clips.length]);
          act.play(); act.time = Math.random() * clips[n % clips.length].duration; mixers.push(mx);
        }
        boxCollider(x, z, 0.25, 0.25);
        n++; placed++;
      }
    });
    renderer.shadowMap.needsUpdate = true;
  }).catch((err) => console.warn('Figuren nicht geladen', err));
}
function loadModels() {
  const loader = new GLTFLoader();
  const one = (id: string) => loader.loadAsync(`models/${id}/${id}_1k` + GLTF).then((g) => g.scene);
  return (modelsReady ||= Promise.all(Object.values(MODELS).map(one)).then((l) => Object.fromEntries(Object.keys(MODELS).map((k, i) => [k, l[i]])) as any));
}

function exitSignTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0f8a3c'; g.fillRect(0, 0, 512, 192);
  g.strokeStyle = '#fff'; g.lineWidth = 10; g.strokeRect(24, 30, 90, 132); // Tür
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(150, 96); g.lineTo(200, 56); g.lineTo(200, 80); g.lineTo(250, 80); g.lineTo(250, 112); g.lineTo(200, 112); g.lineTo(200, 136); g.closePath(); g.fill(); // Pfeil
  g.font = '600 52px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText('EXIT', 290, 98);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** Stellt je Raum eine Pflanze in eine freie Ecke, einen Feuerlöscher neben die erste Tür und ein Notausgang-Schild darüber. */
function placeProps(w: THREE.Group, high: boolean) {
  const signMat = new THREE.MeshBasicMaterial({ map: exitSignTexture(), toneMapped: false });
  for (const r of G.rooms) {
    const d0 = r.doors[0];
    if (d0 && r.height - DOOR_H >= 0.35) {
      const e = edgeInfo(r, d0.edge), m = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.135), signMat);
      m.position.set(e.ax + e.dx * d0.t + e.nx * (WALL_T + 0.004), DOOR_H + 0.2, e.ay + e.dy * d0.t + e.ny * (WALL_T + 0.004));
      m.rotation.y = Math.atan2(e.nx, e.ny); w.add(m);
    }
  }
  loadModels().then((M) => {
    if (world !== w) return; // inzwischen neu aufgebaut
    const put = (src: THREE.Object3D, x: number, z: number, rotY: number) => {
      const o = src.clone(); o.position.set(x, 0, z); o.rotation.y = rotY;
      w.add(shade(o, high));
      const b = new THREE.Box3().setFromObject(o);
      boxCollider(x, z, (b.max.x - b.min.x) / 2, (b.max.z - b.min.z) / 2);
    };
    const busy = (r: Room, edge: number, s: number, rad: number) =>
      G.placements.some((p) => p.roomId === r.id && p.edge === edge && Math.abs(p.s - s) < p.w / 2 + rad)
      || r.doors.concat(r.windows || []).some((d) => d.edge === edge && Math.abs(d.t - s) < d.w / 2 + rad);
    // Kamera, Filmkamera, Postkarten auf Sockeln/Vitrinen/Tresen: auf Zielgröße skaliert, Unterkante auf der Oberfläche
    const fitOn = (src: THREE.Object3D, size: number, top: number, x = 0, rotY = 0) => {
      const o = src.clone(), b = new THREE.Box3().setFromObject(o), sz = b.getSize(new THREE.Vector3()), k = size / Math.max(sz.x, sz.y, sz.z);
      o.scale.setScalar(k); o.rotation.y = rotY;
      const b2 = new THREE.Box3().setFromObject(o), c2 = b2.getCenter(new THREE.Vector3());
      o.position.set(x - c2.x, top - b2.min.y, -c2.z);
      return shade(o, high);
    };
    for (const g of w.children.filter((c) => c.userData.obj)) {
      const o = g.userData.obj, top = g.userData.top as number;
      if (o.kind === 'counter') g.add(fitOn(M.postcards, 0.2, top, 0.45, 0.3));
      else if (o.item === 'camera') g.add(fitOn(M.camera, 0.24, top, 0, -0.5));
      else if (o.item === 'videocam') g.add(fitOn(M.videocam, 0.32, top, 0, 0.6));
    }
    // Bänke: Polster-Ottomane auf Banklänge gestreckt und auf Sitzhöhe gestaucht; die Klotz-Bank bleibt nur bis zum Laden
    const ob = new THREE.Box3().setFromObject(M.bench), osz = ob.getSize(new THREE.Vector3());
    for (const g of w.children.filter((c) => c.userData.bench)) {
      const b = g.userData.bench as { len: number };
      g.children.filter((c) => (c as THREE.Mesh).geometry?.type === 'BoxGeometry').forEach((c) => g.remove(c));
      const o = M.bench.clone();
      o.scale.set(b.len / osz.x, 0.46 / osz.y, 0.48 / osz.z);
      o.position.set(-(ob.min.x + osz.x / 2) * o.scale.x, -ob.min.y * o.scale.y, -(ob.min.z + osz.z / 2) * o.scale.z);
      g.add(shade(o, high));
    }
    G.rooms.forEach((r, ri) => {
      const n = r.pts.length;
      // Pflanze: erste Ecke, an der beide Wände im Umkreis von 1 m frei sind
      for (let i = 0; i < n; i++) {
        const a = edgeInfo(r, (i + n - 1) % n), b = edgeInfo(r, i);
        const bx = a.nx + b.nx, bz = a.ny + b.ny, bl = Math.hypot(bx, bz);
        if (bl < 0.5) continue;
        const x = b.ax + (bx / bl) * 0.6, z = b.ay + (bz / bl) * 0.6;
        if (!pointInPoly(x, z, r.pts) || busy(r, i, 0, 1) || busy(r, (i + n - 1) % n, a.len, 1)) continue;
        if ((G.benches || []).some((q) => benchSeats(q, G.rooms).some(([qx, qy]) => Math.hypot(qx - x, qy - z) < q.len / 2 + 0.6))) continue;
        put(ri % 2 ? M.plant2 : M.plant1, x, z, ri);
        break;
      }
      // Feuerlöscher neben der ersten Tür
      const d0 = r.doors[0];
      if (d0) {
        const e = edgeInfo(r, d0.edge);
        for (const sd of [1, -1]) {
          const t = d0.t + sd * (d0.w / 2 + 0.35);
          if (t < 0.3 || t > e.len - 0.3) continue;
          put(M.ext, e.ax + e.dx * t + e.nx * (WALL_T + 0.18), e.ay + e.dy * t + e.ny * (WALL_T + 0.18), Math.atan2(e.nx, e.ny));
          break;
        }
      }
    });
    renderer.shadowMap.needsUpdate = true;
  }).catch((err) => console.warn('Modelle nicht geladen', err));
}

/** Nachbearbeitung nur auf „Hoch“: Umgebungsverdeckung (GTAO), Kantenglättung per MSAA. */
function setupComposer() {
  composer?.dispose(); composer = null;
  if (prefs.quality !== 'high') return;
  const c = renderer.domElement, w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
  // MSAA im Zwischenpuffer statt SMAA (SMAA franste die Rahmen aus)
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const ao = new GTAOPass(scene, camera, w, h);
  ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.5, thickness: 1.2, scale: 1.1, samples: 12 });
  ao.blendIntensity = 0.85;
  composer.addPass(ao);
  composer.addPass(new OutputPass());
  composer.setSize(w, h);
}

function render() {
  if (composer) composer.render(); else renderer.render(scene, camera);
}

// ---------- Texturen nachladen ----------
function enqueue(job: () => void) { loadQueue.push(job); pump(); }
function pump() {
  while (loaderBusy < 4 && loadQueue.length) { loaderBusy++; loadQueue.shift()!(); }
}
function loadTex(url: string, cb: (t: THREE.Texture | null) => void) {
  enqueue(() => {
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; loaderBusy--; pump(); cb(t);
    }, undefined, () => { loaderBusy--; pump(); cb(null); });
  });
}

/** Weist die nächstgelegenen Bilder den Spots zu. Wechsel werden in animateSpots weich überblendet. */
function updateSpots() {
  const want = paints.map((q) => ({ q, d: q.at.distanceTo(camera.position) })).filter((x) => x.d < 14).sort((a, b) => a.d - b.d).slice(0, slots.length).map((x) => x.q);
  const wantSet = new Set(want);
  for (const s of slots) if (s.cur && !wantSet.has(s.cur) && s.next === undefined) s.next = null;
  const covered = new Set(slots.map((s) => (s.next === undefined ? s.cur : s.next)).filter(Boolean));
  for (const q of want) {
    if (covered.has(q)) continue;
    const free = slots.find((s) => (s.cur === null && s.next === undefined) || s.next === null);
    if (!free) break;
    free.next = q; covered.add(q);
  }
}
function animateSpots(dt: number) {
  for (const s of slots) {
    if (s.next !== undefined) {
      s.lvl -= dt * 3;
      if (s.lvl <= 0 || !s.cur) {
        s.lvl = 0; s.cur = s.next; s.next = undefined;
        if (s.cur) { s.sp.position.copy(s.cur.spotAt); s.sp.target.position.copy(s.cur.at); s.sp.target.updateMatrixWorld(); renderer.shadowMap.needsUpdate = true; }
      }
    } else if (s.cur) s.lvl = Math.min(1, s.lvl + dt * 2);
    s.sp.intensity = s.lvl * spotI;
  }
}

function updateLabel(q: Paint, d: number) {
  if (d < 9 && !q.label) {
    const im = G.images.find((i) => i.id === q.p.imageId); if (!im || !im.title) return;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), new THREE.MeshBasicMaterial({ map: labelTexture(im.title, im.caption), toneMapped: false }));
    m.position.set(q.oW / 2 + 0.14, -q.oH / 2 + 0.06, 0.012); q.grp.add(m); q.label = m;
  } else if (d > 16 && q.label) {
    (q.label.material as THREE.MeshBasicMaterial).map?.dispose(); (q.label.material as THREE.Material).dispose(); q.label.geometry.dispose(); q.grp.remove(q.label); q.label = null;
  }
}

function updateTextures() {
  updateSpots();
  for (const q of paints) {
    const d = q.at.distanceTo(camera.position);
    updateLabel(q, d);
    q.want = d < 7 ? 2 : d < 30 ? 1 : 0;
    if (q.loading) continue;
    if (q.want >= 1 && !q.thumb) {
      q.loading = true;
      loadTex(imgUrl(q.p.imageId, 'thumb'), (t) => { q.loading = false; if (!t || !world) return; q.thumb = t; if (q.level < 1) apply(q, t, 1); });
    } else if (q.want === 2 && q.level < 2 && q.thumb) {
      q.loading = true;
      loadTex(imgUrl(q.p.imageId, 'tex'), (t) => { q.loading = false; if (!t || !world) return; q.tex = t; apply(q, t, 2); });
    } else if (q.level === 2 && d > 11 && q.tex) {
      q.tex.dispose(); q.tex = null; apply(q, q.thumb, 1);
    } else if (q.level === 1 && d > 55 && q.thumb) {
      q.thumb.dispose(); q.thumb = null; apply(q, null, 0);
    }
  }
}
function apply(q: Paint, t: THREE.Texture | null, level: 0 | 1 | 2) {
  q.mat.map = t; q.mat.emissiveMap = t; q.mat.color.set(t ? 0xffffff : 0x8a8a8a); q.mat.emissive.set(t ? 0xffffff : 0x000000); q.mat.needsUpdate = true; q.level = level;
}

// ---------- Eingabe ----------
function setupInput(canvas: HTMLCanvasElement) {
  window.addEventListener('keydown', (e) => {
    if (!running) return;
    if (catalogOpen()) { if (e.key === 'Escape') closeCatalog(); else if (e.key === 'ArrowRight') flipNext(); else if (e.key === 'ArrowLeft') flipPrev(); return; }
    if (detailOpen) { detailKey(e); return; }
    keys.add(e.code);
    if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  let down: { id: number; x: number; y: number; t: number; moved: number } | null = null;
  const locked = () => document.pointerLockElement === canvas;
  canvas.addEventListener('pointerdown', (e) => {
    if (joyId === e.pointerId) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const k = e.pointerType === 'touch' ? 0.005 : 0.004;
    if (locked()) { yawT -= e.movementX * 0.0022; pitchT = clampPitch(pitchT - e.movementY * 0.0022); return; }
    if (down && e.pointerId === down.id) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down.moved += Math.abs(dx) + Math.abs(dy);
      yawT += dx * k; pitchT = clampPitch(pitchT + dy * k);
      down.x = e.clientX; down.y = e.clientY;
    } else if (e.pointerType === 'mouse') hover(e.clientX, e.clientY);
  });
  const finish = (e: PointerEvent) => {
    if (!down || e.pointerId !== down.id) return;
    const wasClick = down.moved < 6 && performance.now() - down.t < 500;
    down = null;
    if (!wasClick) return;
    const pid = locked() ? pickAt(null) : pickAt([e.clientX, e.clientY]);
    if (pid) { if (locked()) document.exitPointerLock(); if (pid.startsWith('catalog:')) { keys.clear(); openCatalog(pid.slice(8)); } else openDetail(pid); }
    else if (e.pointerType === 'mouse' && !locked()) { try { (canvas.requestPointerLock() as any)?.catch?.(() => {}); } catch { /* ignorieren */ } }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => (down = null));

  // Joystick
  const jel = $('joy'), knob = jel.firstElementChild as HTMLElement;
  if (matchMedia('(pointer: coarse)').matches) jel.hidden = false;
  const setJoy = (e: PointerEvent) => {
    const r = jel.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / 50, dy = (e.clientY - (r.top + r.height / 2)) / 50;
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    joy = { x: dx, y: -dy }; knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
  };
  jel.addEventListener('pointerdown', (e) => { joyId = e.pointerId; jel.setPointerCapture(e.pointerId); setJoy(e); e.stopPropagation(); });
  jel.addEventListener('pointermove', (e) => { if (joyId === e.pointerId) setJoy(e); });
  const endJoy = (e: PointerEvent) => { if (joyId === e.pointerId) { joyId = -1; joy = { x: 0, y: 0 }; knob.style.transform = ''; } };
  jel.addEventListener('pointerup', endJoy); jel.addEventListener('pointercancel', endJoy);
}
let joyId = -1;
const clampPitch = (p: number) => Math.max(-1.35, Math.min(1.35, p));

function pickAt(pt: [number, number] | null): string | null {
  const c = renderer.domElement, r = c.getBoundingClientRect();
  const ndc = pt ? new THREE.Vector2(((pt[0] - r.left) / r.width) * 2 - 1, -((pt[1] - r.top) / r.height) * 2 + 1) : new THREE.Vector2(0, 0);
  rayCaster.setFromCamera(ndc, camera);
  rayCaster.far = 14;
  const hit = rayCaster.intersectObjects(pickables, false)[0];
  if (!hit) return null;
  return hit.object.userData.catalog !== undefined ? 'catalog:' + hit.object.userData.catalog : (hit.object.userData.pid as string);
}

let tip: HTMLElement | null = null;
function hover(x: number, y: number) {
  if (!tip) { tip = document.createElement('div'); tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(0,0,0,.7);padding:3px 8px;border-radius:4px;font-size:12px;display:none;z-index:3'; $('view-tour').appendChild(tip); }
  const pid = detailOpen ? null : pickAt([x, y]);
  const p = pid ? G.placements.find((q) => q.id === pid) : null, im = p && G.images.find((i) => i.id === p.imageId);
  const label = pid?.startsWith('catalog:') ? 'Katalog – zum Blättern anklicken' : im?.title;
  if (label) { tip.textContent = label; tip.style.display = 'block'; const r = $('view-tour').getBoundingClientRect(); tip.style.left = x - r.left + 14 + 'px'; tip.style.top = y - r.top + 14 + 'px'; renderer.domElement.style.cursor = 'pointer'; }
  else { tip.style.display = 'none'; renderer.domElement.style.cursor = 'grab'; }
}

// ---------- Bewegung ----------
const ACCEL_T = 0.15, LOOK_T = 0.045, STEP_LEN = 0.72;

function step(dt: number) {
  let f = 0, s = 0;
  if (!detailOpen) {
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD')) s += 1;
    if (keys.has('KeyA')) s -= 1;
    if (keys.has('ArrowLeft')) yawT += 1.8 * dt;
    if (keys.has('ArrowRight')) yawT -= 1.8 * dt;
    f += joy.y; s += joy.x;
  }
  const m = Math.hypot(f, s); if (m > 1) { f /= m; s /= m; }
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4.2 : 2.2;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  // sanftes Anfahren und Abbremsen
  const k = 1 - Math.exp(-dt / ACCEL_T);
  vel.x += ((fx * f + rx * s) * speed - vel.x) * k; vel.y += ((fz * f + rz * s) * speed - vel.y) * k;
  if (vel.lengthSq() < 1e-5) { vel.set(0, 0); return 0; }
  const ox = pos.x, oy = pos.y;
  pos.x += vel.x * dt; pos.y += vel.y * dt;
  for (let it = 0; it < 3; it++) for (const [ax, ay, bx, by] of colliders) {
    const { d, cx, cy } = distToSegment(pos.x, pos.y, ax, ay, bx, by), dx = pos.x - cx, dy = pos.y - cy;
    if (d < RADIUS) {
      if (d > 1e-6) { pos.x += (dx / d) * (RADIUS - d); pos.y += (dy / d) * (RADIUS - d); }
      else { pos.x += RADIUS; }
    }
  }
  return Math.hypot(pos.x - ox, pos.y - oy);
}

function currentRoom(): Room | null {
  return G.rooms.find((r) => pointInPoly(pos.x, pos.y, r.pts)) || null;
}

function frame(now: number) {
  if (!running) return;
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const moved = step(dt) || 0;
  // Blick folgt der Eingabe leicht verzögert
  const lk = 1 - Math.exp(-dt / LOOK_T);
  yaw += (yawT - yaw) * lk; pitch += (pitchT - pitch) * lk;
  // Gehwippen und Schritte (Schrittlänge ca. 0,72 m)
  const speedN = Math.min(1, vel.length() / 2.2);
  bobAmt += ((moved > 0 ? speedN : 0) - bobAmt) * (1 - Math.exp(-dt / 0.2));
  const before = Math.floor(bobPhase / Math.PI);
  bobPhase += (moved / STEP_LEN) * Math.PI;
  if (Math.floor(bobPhase / Math.PI) !== before && moved > 0) footstep(curRoom?.floor || 'concrete', 0.6 + speedN * 0.5);
  const bob = prefs.bob ? -0.022 * bobAmt * (1 - Math.cos(2 * bobPhase)) / 2 : 0;
  const sway = prefs.bob ? 0.008 * bobAmt * Math.sin(bobPhase) : 0;
  camera.position.set(pos.x + Math.cos(yaw) * sway, EYE + bob, pos.y - Math.sin(yaw) * sway);
  camera.rotation.set(pitch, yaw, 0);
  tickAcc += dt;
  if (tickAcc > 0.35) {
    tickAcc = 0; updateTextures();
    const r = currentRoom();
    if (r) { curRoom = r; setRoom(r.id, Math.abs(signedArea(r.pts)), r.height); }
  }
  animateSpots(dt);
  for (const m of mixers) m.update(dt);
  render();
  drawMinimap();
}

// ---------- Werkzeugleiste (Qualität, Ton, Gehwippen, Tag/Abend, Musik, Besucher) ----------
function setupBar() {
  const q = $('q-btn'), snd = $('snd-btn'), bob = $('bob-btn'), tm = $('time-btn'), mus = $('mus-btn'), fig = $('fig-btn');
  const label = () => {
    tm.textContent = prefs.evening ? 'Abend' : 'Tag';
    mus.textContent = prefs.music ? 'Musik an' : 'Musik aus'; mus.classList.toggle('off', !prefs.music);
    fig.textContent = prefs.figures ? 'Besucher an' : 'Besucher aus'; fig.classList.toggle('off', !prefs.figures);
    q.textContent = 'Qualität: ' + (prefs.quality === 'high' ? 'Hoch' : 'Mittel');
    snd.textContent = prefs.sound ? 'Ton an' : 'Ton aus';
    bob.textContent = prefs.bob ? 'Gehwippen an' : 'Gehwippen aus';
    snd.classList.toggle('off', !prefs.sound); bob.classList.toggle('off', !prefs.bob);
  };
  q.onclick = () => {
    prefs.quality = prefs.quality === 'high' ? 'medium' : 'high'; savePrefs(prefs); label();
    if (running) { build(false); resize(); }
  };
  snd.onclick = () => { prefs.sound = !prefs.sound; savePrefs(prefs); startAudio(); setSound(prefs.sound); label(); };
  bob.onclick = () => { prefs.bob = !prefs.bob; savePrefs(prefs); label(); };
  tm.onclick = () => { prefs.evening = !prefs.evening; savePrefs(prefs); label(); if (running) { build(false); resize(); } };
  mus.onclick = () => { prefs.music = !prefs.music; savePrefs(prefs); startAudio(); setMusic(prefs.music); label(); };
  fig.onclick = () => { prefs.figures = !prefs.figures; savePrefs(prefs); label(); if (running) { build(false); resize(); } };
  label();
}

function drawMinimap() {
  const c = $('minimap') as HTMLCanvasElement, g = c.getContext('2d')!;
  const W = c.width, H = c.height, pad = 10;
  g.clearRect(0, 0, W, H);
  const sc = Math.min((W - 2 * pad) / (bounds.x1 - bounds.x0 || 1), (H - 2 * pad) / (bounds.y1 - bounds.y0 || 1));
  const ox = (W - sc * (bounds.x1 - bounds.x0)) / 2 - bounds.x0 * sc, oy = (H - sc * (bounds.y1 - bounds.y0)) / 2 - bounds.y0 * sc;
  g.fillStyle = 'rgba(255,255,255,.22)'; g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
  for (const r of G.rooms) {
    g.beginPath(); r.pts.forEach((p, i) => (i ? g.lineTo(p[0] * sc + ox, p[1] * sc + oy) : g.moveTo(p[0] * sc + ox, p[1] * sc + oy))); g.closePath(); g.fill(); g.stroke();
  }
  const px = pos.x * sc + ox, py = pos.y * sc + oy;
  g.fillStyle = '#e0b469'; g.beginPath(); g.arc(px, py, 4, 0, 7); g.fill();
  g.strokeStyle = '#e0b469'; g.beginPath(); g.moveTo(px, py); g.lineTo(px - Math.sin(yaw) * 14, py - Math.cos(yaw) * 14); g.stroke();
}

export function enterTour() {
  if (!renderer) return;
  build(); resize();
  running = true; last = performance.now(); tickAcc = 1;
  const hint = $('tour-hint'); hint.style.opacity = '1';
  clearTimeout(hintTimer); hintTimer = window.setTimeout(() => (hint.style.opacity = '0'), 9000);
  if (!G.rooms.length) hint.textContent = 'Noch keine Räume. Bitte erst im Schritt „Räume & Wände“ einen Raum bauen.';
  raf = requestAnimationFrame(frame);
}
export function leaveTour() {
  running = false; cancelAnimationFrame(raf); keys.clear();
  if (document.pointerLockElement) document.exitPointerLock();
  closeDetail(); closeCatalog();
}

// ---------- Detailansicht ----------
let order: Placement[] = [], cur = -1;
let z = { s: 1, x: 0, y: 0 }, resetZoom = () => {};
function setupDetail() {
  const stage = $('d-stage'), im = $('d-img') as HTMLImageElement;
  $('d-close').onclick = closeDetail;
  $('d-prev').onclick = () => go(-1); $('d-next').onclick = () => go(1);
  const apply = () => { im.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`; stage.classList.toggle('zoomed', z.s > 1); stage.style.cursor = z.s > 1 ? 'grab' : 'zoom-in'; };
  const reset = () => { z = { s: 1, x: 0, y: 0 }; apply(); };
  resetZoom = reset;
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const ns = Math.max(1, Math.min(6, z.s * Math.exp(-e.deltaY * 0.0015)));
    if (ns === 1) { z = { s: 1, x: 0, y: 0 }; } else { const k = ns / z.s; z.x *= k; z.y *= k; z.s = ns; }
    apply();
  }, { passive: false });
  let d: { x: number; y: number; moved: number } | null = null;
  stage.addEventListener('pointerdown', (e) => { d = { x: e.clientX, y: e.clientY, moved: 0 }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => { if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; d.moved += Math.abs(dx) + Math.abs(dy); d.x = e.clientX; d.y = e.clientY; if (z.s > 1) { z.x += dx; z.y += dy; apply(); } });
  stage.addEventListener('pointerup', () => { if (d && d.moved < 5) { z = z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }; apply(); } d = null; });
}
function detailKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeDetail();
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'ArrowRight') go(1);
}
function openDetail(pid: string) {
  order = tourPlacements(); cur = order.findIndex((p) => p.id === pid);
  if (cur < 0) return;
  detailOpen = true; keys.clear(); $('detail').hidden = false; show();
}
function show() {
  const p = order[cur], im = G.images.find((i) => i.id === p.imageId)!;
  const el = $('d-img') as HTMLImageElement;
  resetZoom();
  el.src = imgUrl(im.id, 'tex');
  const full = new Image(); const id = im.id;
  full.onload = () => { if (order[cur]?.imageId === id) el.src = full.src; };
  full.src = imgUrl(im.id, 'original');
  $('d-title').textContent = im.title; $('d-cap').textContent = im.caption; $('d-tags').textContent = im.tags.map((t) => '#' + t).join('  ');
}
function go(dir: number) { if (!order.length) return; cur = (cur + dir + order.length) % order.length; show(); }
function closeDetail() { detailOpen = false; $('detail').hidden = true; ($('d-img') as HTMLImageElement).removeAttribute('src'); }
