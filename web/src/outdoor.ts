import * as THREE from 'three';

const panos = new Map<string, THREE.Texture>();

/** Landschaft rund um das Gebäude: Panorama (Poly Haven „meadow“ bzw. „belfast_sunset“ am Abend, CC0) auf einer großen Kugel. */
export function buildOutdoor(b: { x0: number; y0: number; x1: number; y1: number }, evening = false) {
  const file = evening ? 'evening' : 'meadow';
  let pano = panos.get(file);
  if (!pano) { pano = new THREE.TextureLoader().load(`textures/${file}.jpg`); pano.colorSpace = THREE.SRGBColorSpace; panos.set(file, pano); }
  const geo = new THREE.SphereGeometry(200, 64, 32);
  geo.scale(-1, 1, 1); // Innenseite zeigen, ohne das Bild zu spiegeln
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: pano, color: evening ? 0x8f8582 : 0xffffff }));
  m.position.set((b.x0 + b.x1) / 2, 1.6, (b.y0 + b.y1) / 2);
  return m;
}
