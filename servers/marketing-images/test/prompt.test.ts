import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/providers/prompt.js';
import { model } from './providerMocks.js';

const GEMINI = model('gemini-3.1-flash-image');
const PHOENIX = model('phoenix-v1.0');

describe('buildPrompt (DESIGN section 5)', () => {
  it('generation defaults to "no text, letters, logos or watermarks"', () => {
    const { prompt } = buildPrompt({ task: 'generate', text: '  a calm lake  ', extraReferences: 0 }, GEMINI);
    expect(prompt.startsWith('a calm lake')).toBe(true);
    expect(prompt).toContain('No text, letters, logos or watermarks.');
  });

  it('text_on_image replaces that default with the exact text to draw', () => {
    const { prompt } = buildPrompt({ task: 'generate', text: 'a shop sign', textOnImage: 'Café "Luna"', extraReferences: 0 }, GEMINI);
    expect(prompt).toContain(`Render this exact text, spelled exactly as written and clearly legible: "Café 'Luna'". No other text.`);
    expect(prompt).not.toContain('No text, letters, logos or watermarks.');
  });

  it('leave_space adds the calm-area hint for that side', () => {
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      expect(buildPrompt({ task: 'generate', text: 'x', leaveSpace: side, extraReferences: 0 }, GEMINI).prompt).toContain(`Keep the ${side} area calm, no text.`);
    }
  });

  it('style is added as a visual-style line', () => {
    expect(buildPrompt({ task: 'generate', text: 'x', style: 'warm tones, minimalist', extraReferences: 0 }, GEMINI).prompt).toContain('Visual style: warm tones, minimalist.');
  });

  it('brand photo style and palette come after the style, as plain sentences; an explicit style is kept and wins', () => {
    const base = { task: 'generate' as const, text: 'a bowl of soup', extraReferences: 0, brandPhotoStyle: 'warm natural light, minimal', brandPalette: 'dark blue (#1F3A5F), amber (#F2A541)' };
    const plain = buildPrompt(base, GEMINI).prompt;
    expect(plain).toContain('Brand photo style: warm natural light, minimal.');
    expect(plain).toContain('Brand palette: dark blue (#1F3A5F), amber (#F2A541).');
    expect(plain).not.toContain('Visual style:');
    expect(plain).toContain('No text, letters, logos or watermarks.');

    const styled = buildPrompt({ ...base, style: 'dark and moody' }, GEMINI).prompt;
    expect(styled).toContain('Visual style: dark and moody.');
    expect(styled).toContain('Brand photo style (the visual style above wins if they differ): warm natural light, minimal.');
    expect(styled.indexOf('Visual style:')).toBeLessThan(styled.indexOf('Brand photo style'));
    expect(styled.indexOf('Brand photo style')).toBeLessThan(styled.indexOf('Brand palette:'));
  });

  it('brand hints do not change the text rules: text_on_image still replaces the "no text" default, edits keep "unchanged"', () => {
    const withText = buildPrompt({ task: 'generate', text: 'a shop sign', textOnImage: 'Abierto', extraReferences: 0, brandPalette: 'amber (#F2A541)' }, GEMINI).prompt;
    expect(withText).toContain('Brand palette: amber (#F2A541).');
    expect(withText).toContain('Render this exact text');
    expect(withText).not.toContain('No text, letters, logos or watermarks.');
    const edit = buildPrompt({ task: 'edit', text: 'make it warmer', extraReferences: 0, brandPhotoStyle: 'beige tones' }, GEMINI).prompt;
    expect(edit.indexOf('Keep everything the instruction does not mention unchanged')).toBeLessThan(edit.indexOf('Brand photo style: beige tones.'));
    expect(edit).not.toContain('No text, letters');
  });

  it('empty brand hints add nothing', () => {
    const plain = buildPrompt({ task: 'generate', text: 'x', extraReferences: 0 }, GEMINI).prompt;
    expect(buildPrompt({ task: 'generate', text: 'x', extraReferences: 0, brandPhotoStyle: '  ', brandPalette: '' }, GEMINI).prompt).toBe(plain);
  });

  it('a negative prompt is passed natively only to models that support it; otherwise it is merged as "Avoid"', () => {
    const merged = buildPrompt({ task: 'generate', text: 'x', negativePrompt: 'blurry', extraReferences: 0 }, GEMINI);
    expect(merged.negativePrompt).toBeUndefined();
    expect(merged.prompt).toContain('Avoid: blurry.');
    const native = buildPrompt({ task: 'generate', text: 'x', negativePrompt: 'blurry', extraReferences: 0 }, PHOENIX);
    expect(native.negativePrompt).toBe('blurry');
    expect(native.prompt).not.toContain('Avoid');
  });

  it('edits keep the photo\'s own text and logos (no "no text" default) and say what the other images are', () => {
    const { prompt } = buildPrompt({ task: 'edit', text: 'make the sky sunset orange', extraReferences: 1 }, GEMINI);
    expect(prompt).toContain('Edit the attached image: make the sky sunset orange');
    expect(prompt).toContain('Keep everything the instruction does not mention unchanged');
    expect(prompt).toContain('references for the edit');
    expect(prompt).not.toContain('No text, letters');
  });

  it('generation with references says to use them as guidance, not to copy them', () => {
    expect(buildPrompt({ task: 'generate', text: 'x', extraReferences: 2 }, GEMINI).prompt).toMatch(/references: use them for subject, palette and look/);
  });
});
