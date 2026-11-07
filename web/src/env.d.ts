/// <reference types="vite/client" />
declare module 'page-flip' {
  export class PageFlip {
    constructor(el: HTMLElement, settings: Record<string, unknown>);
    loadFromHTML(items: NodeListOf<HTMLElement> | HTMLElement[]): void;
    flipNext(): void;
    flipPrev(): void;
    destroy(): void;
    on(ev: string, cb: (e: { data: number }) => void): this;
  }
}
