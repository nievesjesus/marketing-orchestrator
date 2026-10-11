import { describe, expect, it } from 'vitest';
import { describeColor, paletteList } from '../src/brand-prompt.js';

describe('describeColor', () => {
  it('names typical brand colors in words an image model understands', () => {
    expect(describeColor('#1F3A5F')).toBe('dark blue');
    expect(describeColor('#f2a541')).toBe('amber');
    expect(describeColor('#F4EFE6')).toBe('cream');
    expect(describeColor('#0f766e')).toBe('dark teal');
    expect(describeColor('#14b8a6')).toBe('teal');
    expect(describeColor('#ecfdf5')).toBe('off-white');
    expect(describeColor('#d62828')).toBe('red');
    expect(describeColor('#6b4226')).toBe('brown');
    expect(describeColor('#7b2cbf')).toBe('purple');
    expect(describeColor('#2d6a4f')).toBe('dark green');
    expect(describeColor('#40c057')).toBe('green');
    expect(describeColor('#ffc8dd')).toBe('pink');
  });

  it('handles black, white and grays, 3-digit hex and rubbish', () => {
    expect(describeColor('#000')).toBe('black');
    expect(describeColor('#ffffff')).toBe('white');
    expect(describeColor('#888888')).toBe('gray');
    expect(describeColor('#222222')).toBe('charcoal');
    expect(describeColor('#dddddd')).toBe('light gray');
    expect(describeColor('not-a-color')).toBe('neutral');
  });
});

describe('paletteList', () => {
  it('lists primary, accent and secondary with names and uppercase hex; ink and paper are text colors and stay out', () => {
    expect(paletteList({ primary: '#1f3a5f', accent: '#f2a541', secondary: '#f4efe6' })).toBe('dark blue (#1F3A5F), amber (#F2A541), cream (#F4EFE6)');
  });

  it('skips missing, invalid and repeated colors', () => {
    expect(paletteList({ primary: '#1f3a5f', accent: '1F3A5F', secondary: 'nope' })).toBe('dark blue (#1F3A5F)');
    expect(paletteList({})).toBeUndefined();
    expect(paletteList(undefined)).toBeUndefined();
  });
});
