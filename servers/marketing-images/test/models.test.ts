import { describe, expect, it } from 'vitest';
import { MODELS, PROVIDERS, PROVIDER_IDS, RATIOS, defaultModel, estimateImageUsd, getModel, modelsFor, supportsTask, type ModelEntry, type Task } from '../src/models.js';

const TASKS: Task[] = ['generate', 'edit', 'text'];

function dims(params: ModelEntry['aspect'][keyof ModelEntry['aspect']]): { width: number; height: number } | null {
  if ('image_size' in params && typeof params.image_size === 'object') return params.image_size;
  if (typeof params.width === 'number' && typeof params.height === 'number') return { width: params.width, height: params.height };
  return null;
}

const ratioValue = (r: string): number => {
  const [a, b] = r.split(':').map(Number) as [number, number];
  return a / b;
};

describe('model catalog integrity (DESIGN section 6)', () => {
  it('has the catalog from the design: 3 Gemini, 4 fal, 3 Leonardo', () => {
    expect(modelsFor('gemini').map((m) => m.id)).toEqual(['gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-3-pro-image']);
    expect(modelsFor('fal').map((m) => m.id)).toEqual(['fal-ai/flux/schnell', 'fal-ai/nano-banana-2', 'fal-ai/nano-banana-2/edit', 'fal-ai/flux-pro/kontext']);
    expect(modelsFor('leonardo').map((m) => m.id)).toEqual(['lucid-origin', 'phoenix-v1.0', 'flux-kontext-pro']);
  });

  it('ids are unique, non-empty and belong to a known provider', () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODELS) {
      expect(m.id.trim()).not.toBe('');
      expect(m.label.trim()).not.toBe('');
      expect(PROVIDER_IDS).toContain(m.provider);
    }
    for (const p of PROVIDER_IDS) expect(PROVIDERS[p].env_key).toMatch(/^[A-Z_]+$/);
  });

  it.each(MODELS.map((m) => [m.id, m] as const))('%s: every public ratio is mapped to non-empty provider params', (_id, m) => {
    for (const ratio of RATIOS) {
      const params = m.aspect[ratio];
      expect(params, `${m.id} is missing ${ratio}`).toBeDefined();
      expect(Object.keys(params).length).toBeGreaterThan(0);
    }
    expect(Object.keys(m.aspect).sort()).toEqual([...RATIOS].sort());
  });

  it.each(MODELS.map((m) => [m.id, m] as const))('%s: carries verified_on, doc_url and a coherent price', (_id, m) => {
    expect(m.verified_on).toBe('2026-10-10');
    expect(Number.isNaN(Date.parse(m.verified_on))).toBe(false);
    expect(m.doc_url).toMatch(/^https:\/\//);
    if ('usd_per_mp' in m.price) {
      expect(m.price.usd_per_mp).toBeGreaterThan(0);
    } else {
      for (const size of m.sizes) expect(m.price.usd_per_image[size], `${m.id} has no price for ${size}`).toBeGreaterThan(0);
    }
    expect(estimateImageUsd(m)).toBeGreaterThan(0);
    expect(m.sizes.length).toBeGreaterThan(0);
  });

  it('every provider has a default model for each task it supports, and defaults have the capability', () => {
    for (const provider of PROVIDER_IDS) {
      for (const task of TASKS) {
        const defaults = modelsFor(provider).filter((m) => m.default_for?.includes(task));
        expect(defaults.length, `${provider}/${task} has ${defaults.length} defaults`).toBeLessThanOrEqual(1);
        for (const m of defaults) expect(supportsTask(m, task), `${m.id} cannot do ${task}`).toBe(true);
      }
    }
    expect(defaultModel('gemini', 'generate')?.id).toBe('gemini-3.1-flash-image');
    expect(defaultModel('gemini', 'edit')?.id).toBe('gemini-3.1-flash-image');
    expect(defaultModel('gemini', 'text')?.id).toBe('gemini-3.1-flash-image');
    expect(defaultModel('fal', 'generate')?.id).toBe('fal-ai/nano-banana-2');
    expect(defaultModel('fal', 'edit')?.id).toBe('fal-ai/nano-banana-2/edit');
    expect(defaultModel('leonardo', 'generate')?.id).toBe('lucid-origin');
    expect(defaultModel('leonardo', 'edit')?.id).toBe('flux-kontext-pro');
  });

  it('opt-in models are never defaults', () => {
    const optIn = MODELS.filter((m) => m.opt_in);
    expect(optIn.map((m) => m.id)).toEqual(['gemini-nano-banana-2.1']);
    for (const m of optIn) expect(m.default_for).toBeUndefined();
  });

  it('reference-image support is declared consistently', () => {
    for (const m of MODELS) {
      if (m.capabilities.refs) {
        expect(m.max_refs, m.id).toBeGreaterThanOrEqual(1);
        if (m.provider !== 'gemini') expect(m.ref_field, `${m.id} needs a ref_field`).toBeDefined();
      } else {
        expect(m.max_refs, m.id).toBe(0);
        expect(m.ref_field).toBeUndefined();
      }
    }
    expect(getModel('fal-ai/nano-banana-2/edit')?.ref_field).toBe('image_urls');
    expect(getModel('fal-ai/flux-pro/kontext')?.ref_field).toBe('image_url');
    expect(getModel('fal-ai/flux-pro/kontext')?.max_refs).toBe(1);
    expect(getModel('flux-kontext-pro')?.ref_field).toBe('guidances.image_reference');
    expect(getModel('flux-kontext-pro')?.max_refs).toBe(4);
  });

  it('explicit pixel sizes follow the multiple-of-8 (Leonardo) and multiple-of-16 (FLUX) rules and match the ratio', () => {
    let checked = 0;
    for (const m of MODELS) {
      if (m.dimension_multiple === undefined) {
        for (const r of RATIOS) expect(dims(m.aspect[r]), `${m.id} ${r}`).toBeNull();
        continue;
      }
      for (const r of RATIOS) {
        const d = dims(m.aspect[r]);
        expect(d, `${m.id} ${r}`).not.toBeNull();
        const { width, height } = d!;
        expect(width % m.dimension_multiple, `${m.id} ${r} width ${width}`).toBe(0);
        expect(height % m.dimension_multiple, `${m.id} ${r} height ${height}`).toBe(0);
        if (m.dimension_range) {
          for (const side of [width, height]) {
            expect(side).toBeGreaterThanOrEqual(m.dimension_range[0]);
            expect(side).toBeLessThanOrEqual(m.dimension_range[1]);
          }
        }
        expect(Math.abs(width / height / ratioValue(r) - 1), `${m.id} ${r} ratio`).toBeLessThan(0.02);
        const mp = (width * height) / 1_000_000;
        expect(mp).toBeGreaterThan(0.9);
        expect(mp).toBeLessThan(1.1);
        checked += 1;
      }
    }
    expect(checked).toBe(4 * RATIOS.length); // FLUX schnell, Lucid Origin, Phoenix, Kontext (Leonardo)
  });

  it('uses the exact pixel table from the design for FLUX and Leonardo', () => {
    const expected = { '1:1': [1024, 1024], '4:5': [912, 1136], '9:16': [768, 1360], '16:9': [1360, 768], '3:2': [1248, 832], '2:3': [832, 1248] } as const;
    for (const id of ['fal-ai/flux/schnell', 'lucid-origin', 'phoenix-v1.0', 'flux-kontext-pro']) {
      const m = getModel(id)!;
      for (const r of RATIOS) expect(dims(m.aspect[r]), `${id} ${r}`).toEqual({ width: expected[r][0], height: expected[r][1] });
    }
    expect(getModel('fal-ai/flux/schnell')?.dimension_multiple).toBe(16);
    for (const id of ['lucid-origin', 'phoenix-v1.0', 'flux-kontext-pro']) expect(getModel(id)?.dimension_multiple).toBe(8);
  });

  it('Gemini and fal Nano Banana pass ratios through unchanged; Kontext maps 4:5 to the nearest supported ratio', () => {
    for (const id of ['gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-3-pro-image']) {
      for (const r of RATIOS) expect(getModel(id)!.aspect[r]).toEqual({ aspectRatio: r });
    }
    for (const id of ['fal-ai/nano-banana-2', 'fal-ai/nano-banana-2/edit']) {
      for (const r of RATIOS) expect(getModel(id)!.aspect[r]).toEqual({ aspect_ratio: r });
    }
    const kontext = getModel('fal-ai/flux-pro/kontext')!;
    expect(kontext.approx_ratios).toEqual(['4:5']);
    expect(kontext.aspect['4:5']).toEqual({ aspect_ratio: '3:4' });
    for (const r of RATIOS.filter((x) => x !== '4:5')) expect(kontext.aspect[r]).toEqual({ aspect_ratio: r });
  });

  it('prices match the design (verified 2026-10-10)', () => {
    const price = (id: string): ModelEntry['price'] => getModel(id)!.price;
    expect(price('gemini-3.1-flash-image')).toEqual({ usd_per_image: { '1K': 0.067, '2K': 0.101 } });
    expect(price('gemini-nano-banana-2.1')).toEqual({ usd_per_image: { '1K': 0.0336, '2K': 0.0504 } });
    expect(price('gemini-3-pro-image')).toEqual({ usd_per_image: { '1K': 0.134, '2K': 0.134 } });
    expect(price('fal-ai/flux/schnell')).toEqual({ usd_per_mp: 0.003 });
    expect(price('fal-ai/nano-banana-2')).toEqual({ usd_per_image: { '1K': 0.08, '2K': 0.12 } });
    expect(price('fal-ai/flux-pro/kontext')).toEqual({ usd_per_image: { default: 0.04 } });
    for (const id of ['lucid-origin', 'phoenix-v1.0', 'flux-kontext-pro']) expect(getModel(id)!.price.estimate, `${id} is an estimate`).toBe(true);
    expect(getModel('gemini-3.1-flash-image')!.price.estimate).toBeUndefined();
  });

  it('estimateImageUsd handles sizes and per-megapixel prices', () => {
    expect(estimateImageUsd(getModel('gemini-3.1-flash-image')!, '2K')).toBe(0.101);
    expect(estimateImageUsd(getModel('gemini-3.1-flash-image')!)).toBe(0.067);
    expect(estimateImageUsd(getModel('gemini-3.1-flash-image')!, 'nonsense')).toBe(0.067);
    expect(estimateImageUsd(getModel('fal-ai/flux/schnell')!)).toBe(0.003);
  });
});
