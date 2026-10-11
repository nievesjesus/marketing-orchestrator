import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODELS } from '../src/models.js';

/** DESIGN section 6: "nothing else in the code contains a model id" (hard-coded catalogs rot silently). */
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('models.ts is the only place with model ids', () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith(`${path.sep}models.ts`));

  it('scans the provider code', () => {
    expect(files.some((f) => f.endsWith(path.join('providers', 'gemini.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith('router.ts'))).toBe(true);
  });

  it.each(MODELS.map((m) => m.id))('no source file other than models.ts quotes the id %s', (id) => {
    const quoted = [`'${id}'`, `"${id}"`, `\`${id}\``];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const q of quoted) expect(text.includes(q), `${path.relative(SRC, file)} hard-codes ${q}`).toBe(false);
    }
  });
});
