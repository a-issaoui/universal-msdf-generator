/**
 * Minimal type declarations for harfbuzzjs/hbjs.js
 * The package ships pre-compiled HarfBuzz WASM without TypeScript types.
 */

declare module 'harfbuzzjs/hbjs.js' {
  interface HarfBuzzBlob {
    destroy(): void;
  }

  interface HarfBuzzFace {
    upem: number;
    destroy(): void;
  }

  interface HarfBuzzFont {
    setScale(x: number, y: number): void;
    destroy(): void;
  }

  interface HarfBuzzGlyphInfo {
    /** After hb.shape(): holds the glyph ID (intentional HarfBuzz naming) */
    codepoint: number;
    cluster: number;
  }

  interface HarfBuzzBuffer {
    addText(text: string): void;
    setDirection(direction: string): void;
    setScript(script: string): void;
    setLanguage(language: string): void;
    guessSegmentProperties(): void;
    getGlyphInfos(): HarfBuzzGlyphInfo[];
    destroy(): void;
  }

  interface HarfBuzzInstance {
    createBlob(buffer: Uint8Array | Buffer): HarfBuzzBlob;
    createFace(blob: HarfBuzzBlob, index: number): HarfBuzzFace;
    createFont(face: HarfBuzzFace): HarfBuzzFont;
    createBuffer(): HarfBuzzBuffer;
    /**
     * Shape a buffer of text using the given font.
     *
     * @param features - Comma-separated OpenType feature tag string
     *   (e.g. `'kern,liga,calt'`). The harfbuzzjs runtime calls `.split(",")` on
     *   this value, so passing an array will throw at runtime.
     *   Pass `undefined` or `''` to use the font's default features.
     *
     * @see https://harfbuzz.github.io/harfbuzz-hb-shape.html
     */
    shape(font: HarfBuzzFont, buffer: HarfBuzzBuffer, features?: string): void;
  }

  function hbjs(instance: WebAssembly.Instance): HarfBuzzInstance;
  export = hbjs;
}

declare module 'harfbuzzjs/hb.js' {
  function hb(): Promise<WebAssembly.Instance>;
  export = hb;
}
