import { describe, expect, it } from 'vitest';
import { blend, contrastRatio, hexToRgb, isValidHex, luma, normalizeHex, readableOn, relativeLuminance, rgbToHex, toHex } from '../src/render/color.js';

describe('hex helpers (port of logo-showcase color.ts)', () => {
  it('normalizes 3 and 6 digit hex, with or without #', () => {
    expect(normalizeHex('#abc')).toBe('AABBCC');
    expect(normalizeHex('1f3a5f')).toBe('1F3A5F');
    expect(normalizeHex('  #1F3A5F ')).toBe('1F3A5F');
    expect(normalizeHex('#12')).toBeNull();
    expect(normalizeHex('#gggggg')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });

  it('validates and converts to rgb', () => {
    expect(isValidHex('#fff')).toBe(true);
    expect(isValidHex('nope')).toBe(false);
    expect(hexToRgb('#1F3A5F')).toEqual({ r: 31, g: 58, b: 95 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('zzz')).toBeNull();
    expect(rgbToHex({ r: 31, g: 58, b: 95 })).toBe('#1f3a5f');
    expect(toHex('ABC', '#000000')).toBe('#aabbcc');
    expect(toHex('nope', '#123456')).toBe('#123456');
  });
});

describe('readableOn', () => {
  it('picks dark text on light backgrounds and light text on dark ones', () => {
    expect(readableOn('#ffffff')).toBe('#0b1020');
    expect(readableOn('#f4efe6')).toBe('#0b1020');
    expect(readableOn('#ffd23f')).toBe('#0b1020');
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#14213d')).toBe('#ffffff');
    expect(readableOn('#1F3A5F')).toBe('#ffffff');
  });

  it('uses the same luminance cut-off (150) as the source', () => {
    // 0.299 R + 0.587 G + 0.114 B: pure gray 150 is NOT > 150 -> light text; 151 is -> dark text.
    expect(readableOn('#969696')).toBe('#ffffff');
    expect(readableOn('#979797')).toBe('#0b1020');
  });

  it('supports custom colors and falls back to dark for invalid input', () => {
    expect(readableOn('#000', '#111111', '#eeeeee')).toBe('#eeeeee');
    expect(readableOn('#fff', '#111111', '#eeeeee')).toBe('#111111');
    expect(readableOn('not-a-color', '#111111', '#eeeeee')).toBe('#111111');
  });
});

describe('WCAG helpers', () => {
  it('black on white is 21:1 and identical colors 1:1', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
    expect(contrastRatio({ r: 90, g: 90, b: 90 }, { r: 90, g: 90, b: 90 })).toBeCloseTo(1, 5);
  });

  it('relative luminance is monotonic and blend mixes in sRGB', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(blend({ r: 200, g: 200, b: 200 }, { r: 0, g: 0, b: 0 }, 0.5)).toEqual({ r: 100, g: 100, b: 100 });
    expect(luma({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
});
