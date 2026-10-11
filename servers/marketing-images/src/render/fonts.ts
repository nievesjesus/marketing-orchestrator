import { readFileSync } from 'node:fs';
import path from 'node:path';
// opentype.js parses TTF/OTF for measuring: https://opentype.js.org/ · Satori fonts: https://github.com/vercel/satori#fonts
import opentype, { type Font } from 'opentype.js';

/**
 * Font registry: family name -> bundled OFL TTF files (fonts/). No fonts are downloaded at runtime.
 * Satori and opentype.js both need TTF/OTF (no WOFF2): https://github.com/vercel/satori#fonts
 */

export const DEFAULT_HEADING_FAMILY = 'Outfit';
export const DEFAULT_BODY_FAMILY = 'Work Sans';

export interface FontFace {
  family: string;
  file: string;
  weight: number;
  italic: boolean;
  data: Buffer;
  font: Font;
}

interface FamilyDef {
  display: string;
  faces: { file: string; weight: number; italic: boolean }[];
}

const FAMILIES: FamilyDef[] = [
  {
    display: 'Outfit',
    faces: [
      { file: 'Outfit-Regular.ttf', weight: 400, italic: false },
      { file: 'Outfit-Bold.ttf', weight: 700, italic: false },
    ],
  },
  {
    display: 'Work Sans',
    faces: [
      { file: 'WorkSans-Regular.ttf', weight: 400, italic: false },
      { file: 'WorkSans-Bold.ttf', weight: 700, italic: false },
      { file: 'WorkSans-Italic.ttf', weight: 400, italic: true },
    ],
  },
  {
    display: 'Bricolage Grotesque',
    faces: [
      { file: 'BricolageGrotesque-Regular.ttf', weight: 400, italic: false },
      { file: 'BricolageGrotesque-Bold.ttf', weight: 700, italic: false },
    ],
  },
  {
    display: 'Lora',
    faces: [
      { file: 'Lora-Regular.ttf', weight: 400, italic: false },
      { file: 'Lora-Bold.ttf', weight: 700, italic: false },
      { file: 'Lora-Italic.ttf', weight: 400, italic: true },
    ],
  },
  {
    display: 'Instrument Serif',
    faces: [
      { file: 'InstrumentSerif-Regular.ttf', weight: 400, italic: false },
      { file: 'InstrumentSerif-Italic.ttf', weight: 400, italic: true },
    ],
  },
  {
    display: 'Young Serif',
    faces: [{ file: 'YoungSerif-Regular.ttf', weight: 400, italic: false }],
  },
];

/** Parses a TTF/OTF buffer into a face (used for fonts a saved brand uploaded). Throws if opentype.js cannot read it. */
export function parseFontFace(family: string, file: string, weight: number, italic: boolean, data: Buffer): FontFace {
  // Copy into a standalone ArrayBuffer: opentype.parse must not see Node's shared Buffer pool.
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return { family, file, weight, italic, data, font: opentype.parse(ab) };
}

/** "Work Sans", "work-sans" and "WorkSans" all map to the same key. */
export function familyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class FontRegistry {
  private readonly families = new Map<string, { display: string; faces: FontFace[] }>();

  /**
   * Loads and parses every bundled font once; throws if a file is missing (fail fast at startup).
   * Passing an existing registry instead of a directory makes a cheap copy (used by `withFaces`).
   */
  constructor(fontsDir: string | FontRegistry) {
    if (typeof fontsDir !== 'string') {
      for (const [key, entry] of fontsDir.families) this.families.set(key, { display: entry.display, faces: [...entry.faces] });
      return;
    }
    for (const def of FAMILIES) {
      const faces = def.faces.map((f): FontFace => {
        const data = readFileSync(path.join(fontsDir, f.file));
        // Copy into a standalone ArrayBuffer: opentype.parse must not see Node's shared Buffer pool.
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        return { family: def.display, file: f.file, weight: f.weight, italic: f.italic, data, font: opentype.parse(ab) };
      });
      this.families.set(familyKey(def.display), { display: def.display, faces });
    }
  }

  /**
   * A copy of this registry with extra faces layered on top (a brand's uploaded fonts, scoped to ONE render).
   * A family with the same name as a bundled one replaces it for that render only.
   */
  withFaces(faces: readonly FontFace[]): FontRegistry {
    const copy = new FontRegistry(this);
    const byFamily = new Map<string, FontFace[]>();
    for (const face of faces) byFamily.set(face.family, [...(byFamily.get(face.family) ?? []), face]);
    for (const [display, list] of byFamily) copy.families.set(familyKey(display), { display, faces: list });
    return copy;
  }

  /** The display name of a family ("work-sans" -> "Work Sans"), or undefined when it is not registered. */
  displayName(family: string | undefined): string | undefined {
    return family === undefined ? undefined : this.families.get(familyKey(family))?.display;
  }

  /** Every face of a family (empty when unknown). */
  facesOf(family: string): FontFace[] {
    return this.families.get(familyKey(family))?.faces ?? [];
  }

  listFamilies(): string[] {
    return [...this.families.values()].map((f) => f.display);
  }

  has(family: string | undefined): boolean {
    return family !== undefined && this.families.has(familyKey(family));
  }

  /**
   * Closest bundled face for the request. An unknown family falls back to `fallbackFamily`
   * (reported through `substituted`). Missing weights map to the nearest one, missing italics to upright.
   */
  resolve(
    family: string | undefined,
    fallbackFamily: string,
    weight: number,
    italic: boolean,
  ): { face: FontFace; substituted: boolean } {
    const requested = family ? this.families.get(familyKey(family)) : undefined;
    const entry = requested ?? this.families.get(familyKey(fallbackFamily));
    if (!entry) throw new Error('font registry has no default family');
    const sameStyle = entry.faces.filter((f) => f.italic === italic);
    const pool = sameStyle.length > 0 ? sameStyle : entry.faces.filter((f) => !f.italic);
    const face = [...pool].sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight) || b.weight - a.weight)[0];
    if (!face) throw new Error('font family has no faces');
    return { face, substituted: family !== undefined && requested === undefined };
  }
}
