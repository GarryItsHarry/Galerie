export interface Img {
  id: string; name: string; title: string; caption: string; tags: string[];
  width: number; height: number; aspect: number;
}
export interface Door { edge: number; t: number; w: number }
export interface Room {
  id: string; name: string; tag: string; height: number;
  pts: [number, number][]; doors: Door[];
  frame?: 'slim' | 'wide' | 'none';
  windows?: Door[];
  wall?: string;
  floor?: 'concrete' | 'oak' | 'dark';
  intro?: string;
}
export interface Placement {
  id: string; imageId: string; roomId: string; edge: number;
  s: number; y: number; w: number; rope?: boolean;
}
export interface Bench { id: string; x: number; y: number; rot: number; len: number; layout?: 'row' | 'parallel' }
export type ObjKind = 'pedestal' | 'vitrine' | 'counter';
export type ObjItem = 'camera' | 'videocam' | 'books' | 'print' | 'none';
export interface Obj { id: string; kind: ObjKind; x: number; y: number; rot: number; item?: ObjItem; imageId?: string }
export interface Gallery { images: Img[]; rooms: Room[]; placements: Placement[]; benches: Bench[]; objects: Obj[] }
