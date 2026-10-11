// opentype.js 2.0.0 ships no type declarations. This declares only the subset used by
// src/render/fit.ts. Docs: https://opentype.js.org/ · https://github.com/opentypejs/opentype.js
declare module 'opentype.js' {
  export interface Glyph {
    index: number;
    advanceWidth?: number;
  }

  export interface Font {
    unitsPerEm: number;
    numGlyphs: number;
    glyphs: { get(index: number): Glyph };
    charToGlyphIndex(char: string): number;
    getKerningValue(left: Glyph | number, right: Glyph | number): number;
  }

  export function parse(buffer: ArrayBuffer, options?: Record<string, unknown>): Font;

  const opentype: { parse: typeof parse };
  export default opentype;
}
