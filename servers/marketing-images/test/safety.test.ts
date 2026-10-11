import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { assertPromptAllowed, findSafetyIssue, normalize } from '../src/safety.js';

const issue = (text: string, task: 'generate' | 'edit' = 'generate') => findSafetyIssue(task, [text]);

describe('prompt guard: real people', () => {
  it.each([
    'a portrait of Taylor Swift on stage',
    'Elon Musk holding our product',
    'Messi celebrating a goal with our logo',
    'foto de Shakira en un concierto',
    'el presidente Barack Obama sonriendo',
    'LEONARDO DICAPRIO drinking coffee',
    'Cristiano Ronaldo wearing our jersey',
  ])('refuses naming a public figure: %s', (text) => {
    expect(issue(text)?.category).toBe('real_person');
  });

  it.each(['make a deepfake of my boss', 'face swap me onto a model', 'a lookalike of a movie star', 'celebrity endorsing our shop', 'una celebridad bebiendo nuestro café'])('refuses likeness requests: %s', (text) => {
    expect(issue(text)?.category).toBe('real_person');
  });

  it('is accent- and case-insensitive', () => {
    expect(issue('MBAPPÉ en la cancha')?.category).toBe('real_person');
    expect(issue('beyoncé')?.category).toBe('real_person');
  });

  it('allows generic people and common words that look like names', () => {
    for (const text of ['a smiling woman in her 30s working on a laptop', 'a drake swimming on a pond', 'the rock formation at sunset', 'madonna and child, renaissance style', 'skin care: pele macia', 'our president of the club at the desk']) {
      expect(issue(text), text).toBeNull();
    }
  });

  it('editing the user\'s own photo is allowed: faces and "me" are never a reason to refuse an edit', () => {
    for (const instruction of ['make me look professional, soft light', 'replace the background with a sunny beach', 'remove the person behind me', 'put my team in front of our new office', 'make it look like a magazine photoshoot']) {
      expect(issue(instruction, 'edit'), instruction).toBeNull();
    }
    // generic "famous person" requests are a generation-only rule...
    expect(issue('a famous actor', 'generate')?.category).toBe('real_person');
    expect(issue('make the lighting like a famous actor portrait', 'edit')).toBeNull();
    // ...but naming a public figure or asking for a deepfake is refused in edits too.
    expect(issue('put Taylor Swift next to me', 'edit')?.category).toBe('real_person');
    expect(issue('face swap with my friend', 'edit')?.category).toBe('real_person');
  });
});

describe('prompt guard: minors in sensitive contexts', () => {
  it.each([
    'a teenage girl in a bikini on the beach',
    'kids holding a beer at a party',
    'a child with a gun',
    'niño fumando un cigarrillo',
    'menina de biquíni nua',
    'a little boy next to blood and gore',
    'schoolgirl in lingerie',
  ])('refuses: %s', (text) => {
    expect(issue(text)?.category).toBe('minor');
  });

  it.each(['loli art', 'shota', 'CSAM'])('refuses absolute terms: %s', (text) => {
    expect(issue(text)?.category).toBe('minor');
  });

  it('allows ordinary scenes with children, and sensitive words in other sentences', () => {
    for (const text of ['kids birthday party with balloons and cake', 'a child learning to ride a bicycle', 'niños jugando en el parque', 'a baby sleeping in a crib. A glass of wine on the table', 'bebé con su mamá, kínder']) {
      expect(issue(text), text).toBeNull();
    }
  });

  it('applies to edits too', () => {
    expect(issue('make the girl topless', 'edit')?.category).toBe('minor');
  });
});

describe('prompt guard: third-party brands, logos and characters', () => {
  it.each([
    'running shoes with the Nike swoosh',
    'a bottle of Coca-Cola on a table',
    'Mickey Mouse waving hello',
    'un pikachu gigante',
    'a McDonald\'s burger',
    'Spider-Man in the city',
    'a laptop with the apple logo',
    'Harry Potter style wizard school',
    'camiseta de Adidas',
  ])('refuses: %s', (text) => {
    expect(issue(text)?.category).toBe('brand');
  });

  it('allows generic objects and words that merely contain a brand string', () => {
    for (const text of ['running shoes on a track', 'a red apple on a wooden table', 'a mouse next to a keyboard', 'a spider web with dew', 'minimal sneakers, white background', 'a nickel coin on a table']) {
      expect(issue(text), text).toBeNull();
    }
  });

  it('checks every text the user supplied (prompt, style and text to draw)', () => {
    expect(findSafetyIssue('generate', ['a calm lake', 'in the style of Disney', undefined])?.category).toBe('brand');
    expect(findSafetyIssue('generate', ['a calm lake', undefined, 'Just do it, Nike'])?.category).toBe('brand');
    expect(findSafetyIssue('generate', ['a calm lake', 'warm tones', 'Open daily'])).toBeNull();
    expect(findSafetyIssue('generate', [undefined, '   '])).toBeNull();
  });
});

describe('assertPromptAllowed', () => {
  it('throws a plain-language UserFacingError with a suggestion and the matched term', () => {
    try {
      assertPromptAllowed('generate', ['a photo of Elon Musk']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      const e = err as UserFacingError;
      expect(e.code).toBe('safety_real_person');
      expect(e.message).toMatch(/real, identifiable person/);
      expect(e.message).toMatch(/elon musk/);
      expect(e.suggestion).toMatch(/fictional or generic/);
    }
    expect(() => assertPromptAllowed('generate', ['a child with a gun'])).toThrow(/children or teenagers/);
    expect(() => assertPromptAllowed('generate', ['a Nike shoe'])).toThrow(/logos, brands or characters/);
  });

  it('does nothing for a normal prompt', () => {
    expect(() => assertPromptAllowed('generate', ['a calm lake at sunrise, soft light'])).not.toThrow();
    expect(() => assertPromptAllowed('edit', ['brighten the image'])).not.toThrow();
  });
});

describe('normalize', () => {
  it('lower-cases, strips accents and apostrophes and collapses whitespace', () => {
    expect(normalize("  McDonald’s   NIÑO \n bebé ")).toBe('mcdonalds nino bebe');
  });
});
