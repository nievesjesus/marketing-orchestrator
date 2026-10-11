import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { PROVIDER_IDS, type ProviderId } from '../src/models.js';
import { planRoute, type RouteRequest } from '../src/router.js';

const ALL: readonly ProviderId[] = PROVIDER_IDS;

function route(over: Partial<RouteRequest> = {}) {
  return planRoute({ task: 'generate', provider: 'auto', prompt: 'a calm lake at sunrise', textOnImage: false, extraReferences: 0, numImages: 1, available: ALL, ...over });
}

const summary = (plan: ReturnType<typeof route>): string[] => plan.candidates.map((c) => `${c.provider}:${c.model.id}`);

function refusal(fn: () => unknown): UserFacingError {
  try {
    fn();
  } catch (err) {
    if (err instanceof UserFacingError) return err;
    throw err;
  }
  throw new Error('expected a UserFacingError');
}

describe('routing rules for provider=auto (DESIGN section 7)', () => {
  it('rule 6: default is Gemini, then fal, then Leonardo, each with its default generate model', () => {
    const plan = route();
    expect(plan.rule).toBe('default');
    expect(plan.fallback).toBe(true);
    expect(summary(plan)).toEqual(['gemini:gemini-3.1-flash-image', 'fal:fal-ai/nano-banana-2', 'leonardo:lucid-origin']);
  });

  it('rule 2: text_on_image goes to Gemini first; only models that can draw text are candidates', () => {
    const plan = route({ textOnImage: true });
    expect(plan.rule).toBe('text_or_references');
    expect(summary(plan)).toEqual(['gemini:gemini-3.1-flash-image', 'fal:fal-ai/nano-banana-2']); // Leonardo cannot draw text
  });

  it('rule 2: reference images go to Gemini; fal uses its edit model (the only fal model that takes references for generation)', () => {
    const plan = route({ extraReferences: 2 });
    expect(plan.rule).toBe('text_or_references');
    expect(summary(plan)).toEqual(['gemini:gemini-3.1-flash-image', 'fal:fal-ai/nano-banana-2/edit', 'leonardo:flux-kontext-pro']);
  });

  it('rule 3: a plain edit goes Gemini, then fal nano-banana-2/edit, then Leonardo Kontext', () => {
    const plan = route({ task: 'edit' });
    expect(plan.rule).toBe('plain_edit');
    expect(summary(plan)).toEqual(['gemini:gemini-3.1-flash-image', 'fal:fal-ai/nano-banana-2/edit', 'leonardo:flux-kontext-pro']);
  });

  it('rule 2 for edits: extra references or text still lead with Gemini', () => {
    expect(route({ task: 'edit', extraReferences: 1 }).rule).toBe('text_or_references');
    expect(route({ task: 'edit', textOnImage: true }).candidates[0]?.provider).toBe('gemini');
  });

  it('rule 4: asking for Leonardo (prompt or style) goes to Leonardo lucid-origin first', () => {
    const byPrompt = route({ prompt: 'a dragon, Leonardo style' });
    expect(byPrompt.rule).toBe('leonardo_requested');
    expect(summary(byPrompt)).toEqual(['leonardo:lucid-origin', 'gemini:gemini-3.1-flash-image', 'fal:fal-ai/nano-banana-2']);
    expect(route({ style: 'lucid origin cinematic' }).candidates[0]?.provider).toBe('leonardo');
  });

  it('rule 5: "fast", "draft" or "photo-real" prompts with more than one image go to the cheapest fal model first', () => {
    const plan = route({ prompt: 'quick draft of a coffee cup', numImages: 3 });
    expect(plan.rule).toBe('fast_drafts');
    expect(summary(plan)).toEqual(['fal:fal-ai/flux/schnell', 'gemini:gemini-3.1-flash-image', 'leonardo:lucid-origin']);
    expect(route({ prompt: 'photo-realistic product shot', numImages: 2 }).rule).toBe('fast_drafts');
  });

  it('rule 5 needs more than one image; with one image the default applies', () => {
    expect(route({ prompt: 'quick draft of a coffee cup', numImages: 1 }).rule).toBe('default');
  });

  it('rule 2 beats rules 4 and 5 (text and references need Gemini-class models)', () => {
    expect(route({ prompt: 'fast draft leonardo', numImages: 4, textOnImage: true }).rule).toBe('text_or_references');
  });

  it('only providers with a key are candidates', () => {
    expect(summary(route({ available: ['fal', 'leonardo'] }))).toEqual(['fal:fal-ai/nano-banana-2', 'leonardo:lucid-origin']);
    expect(summary(route({ available: ['leonardo'] }))).toEqual(['leonardo:lucid-origin']);
    expect(summary(route({ task: 'edit', available: ['leonardo'] }))).toEqual(['leonardo:flux-kontext-pro']);
  });

  it('opt-in models (gemini-nano-banana-2.1) are never picked automatically', () => {
    for (const over of [{}, { textOnImage: true }, { task: 'edit' as const }]) {
      expect(summary(route(over)).join(',')).not.toContain('nano-banana-2.1');
    }
  });

  it('no keys at all: a plain message that names the settings', () => {
    const err = refusal(() => route({ available: [] }));
    expect(err.code).toBe('no_provider');
    expect(err.message).toMatch(/No image provider is set up/);
    expect(err.suggestion).toMatch(/GEMINI_API_KEY.*FAL_KEY.*LEONARDO_API_KEY/);
  });

  it('nothing set up can do the job: says why', () => {
    const err = refusal(() => route({ textOnImage: true, available: ['leonardo'] }));
    expect(err.code).toBe('no_capable_provider');
    expect(err.message).toMatch(/cannot draw text/);
    expect(err.suggestion).toMatch(/compose_post/);
  });
});

describe('explicit provider or model: no fallback', () => {
  it('an explicit provider uses its default model for the job and disables fallback', () => {
    const plan = route({ provider: 'fal' });
    expect(plan).toMatchObject({ fallback: false, rule: 'named_provider' });
    expect(summary(plan)).toEqual(['fal:fal-ai/nano-banana-2']);
    expect(summary(route({ provider: 'leonardo', task: 'edit' }))).toEqual(['leonardo:flux-kontext-pro']);
    expect(summary(route({ provider: 'gemini', textOnImage: true }))).toEqual(['gemini:gemini-3.1-flash-image']);
  });

  it('a named model decides the provider (even with provider=auto) and disables fallback', () => {
    const plan = route({ model: 'phoenix-v1.0' });
    expect(plan).toMatchObject({ fallback: false, rule: 'named_model' });
    expect(summary(plan)).toEqual(['leonardo:phoenix-v1.0']);
    expect(summary(route({ model: 'gemini-nano-banana-2.1' }))).toEqual(['gemini:gemini-nano-banana-2.1']); // opt-in is allowed when named
  });

  it('missing key: "X isn\'t set up on this server, try Y"', () => {
    const err = refusal(() => route({ provider: 'leonardo', available: ['gemini', 'fal'] }));
    expect(err.code).toBe('provider_not_configured');
    expect(err.message).toBe("Leonardo isn't set up on this server, try Gemini or fal.ai instead.");
    const viaModel = refusal(() => route({ model: 'lucid-origin', available: ['gemini'] }));
    expect(viaModel.message).toBe("Leonardo isn't set up on this server, try Gemini instead.");
    const alone = refusal(() => route({ provider: 'fal', available: [] }));
    expect(alone.message).toBe("fal.ai isn't set up on this server.");
    expect(alone.suggestion).toMatch(/FAL_KEY/);
  });

  it('rejects unknown models, provider/model mismatches and models that cannot do the job', () => {
    expect(refusal(() => route({ model: 'dall-e-9' })).code).toBe('unknown_model');
    expect(refusal(() => route({ provider: 'gemini', model: 'lucid-origin' })).code).toBe('model_provider_mismatch');
    expect(refusal(() => route({ model: 'lucid-origin', textOnImage: true })).message).toMatch(/cannot draw text/);
    expect(refusal(() => route({ model: 'flux-kontext-pro' })).message).toMatch(/only edits photos/);
    expect(refusal(() => route({ task: 'edit', model: 'lucid-origin' })).message).toMatch(/cannot edit photos/);
    expect(refusal(() => route({ task: 'edit', model: 'fal-ai/flux-pro/kontext', extraReferences: 1 })).message).toMatch(/at most 1 input image/);
    expect(refusal(() => route({ provider: 'leonardo', textOnImage: true })).code).toBe('provider_cannot_do_it');
  });
});
