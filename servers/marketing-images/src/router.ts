import { UserFacingError } from './errors.js';
import { MODELS, PROVIDER_IDS, PROVIDERS, getModel, modelsFor, type ModelEntry, type ProviderId } from './models.js';
import { providerError, providerShortName, tryInstead } from './providers/errors.js';
import { perImageUsd } from './providers/cost.js';
import type { ImageTask } from './providers/types.js';

/**
 * Provider routing for `provider = "auto"` (DESIGN section 7). Rules, in order:
 *
 *  1. The user named a model                           -> that model's provider, no fallback.
 *  2. `text_on_image`, or reference images             -> Gemini (default model), then fal, then Leonardo.
 *  3. A plain `edit_image`                             -> Gemini, then fal (nano-banana edit), then Leonardo (Kontext).
 *  4. The prompt/style asks for Leonardo               -> Leonardo (lucid-origin), then Gemini, then fal.
 *  5. "fast" / "draft" / "photo-real" with images > 1  -> fal (cheapest text-to-image model), then Gemini, then Leonardo.
 *  6. Anything else                                    -> Gemini default, then fal, then Leonardo.
 *
 * Only providers whose key is configured are candidates, and each candidate must have a model that can do the job
 * (a text request never lands on a model that cannot draw text). Fallback to the next candidate happens in the
 * orchestrator, only for provider failures (never safety refusals or validation errors), and only when the
 * provider was `auto`: an explicit provider or model gets a plain error instead.
 *
 * Rule 3 adds Leonardo as a last resort (the design lists Gemini then fal only): without it, a server that only
 * has a Leonardo key could not edit at all.
 */

export interface RouteRequest {
  task: ImageTask;
  provider: 'auto' | ProviderId;
  model?: string | undefined;
  /** Prompt (or instruction) and style, scanned for routing keywords. */
  prompt: string;
  style?: string | undefined;
  textOnImage: boolean;
  /** Reference images besides the photo being edited (style or subject references). */
  extraReferences: number;
  /** Images wanted. */
  numImages: number;
  /** Providers whose key is configured on this server. */
  available: readonly ProviderId[];
}

export interface Candidate {
  provider: ProviderId;
  model: ModelEntry;
}

export interface RoutePlan {
  candidates: Candidate[];
  /** May the orchestrator try the next candidate after a provider failure? */
  fallback: boolean;
  /** Which rule above decided (for logs and the response). */
  rule: string;
}

interface Needs {
  task: ImageTask;
  text: boolean;
  images: number;
}

const FAST_RE = /\b(fast|quick|draft|drafts|rough|sketch|photo[\s-]?real(?:istic)?|boceto|borrador|rapido|rascunho)\b/i;
const LEONARDO_RE = /\b(leonardo|lucid[\s-]?origin|phoenix)\b/i;

/** Why `model` cannot do the job, or null when it can. */
export function whyNot(model: ModelEntry, needs: Needs): string | null {
  const c = model.capabilities;
  const name = model.label;
  if (needs.task === 'edit' && !c.edit) return `${name} cannot edit photos`;
  if (needs.task === 'generate' && !c.t2i && !(needs.images > 0 && c.edit)) return `${name} only edits photos: give it reference images or choose another model`;
  if (needs.text && !c.text) return `${name} cannot draw text inside the picture`;
  if (needs.images > 0 && !c.refs) return `${name} does not take reference images`;
  if (needs.images > model.max_refs) return `${name} accepts at most ${model.max_refs} input image${model.max_refs === 1 ? '' : 's'}`;
  return null;
}

const fits = (model: ModelEntry, needs: Needs): boolean => whyNot(model, needs) === null;

/** The provider's default model for the job: text default, then task default, then the first model that fits. */
function pick(provider: ProviderId, needs: Needs): ModelEntry | undefined {
  const pool = modelsFor(provider).filter((m) => !m.opt_in && fits(m, needs));
  const byDefault = (task: 'text' | 'generate' | 'edit'): ModelEntry | undefined => pool.find((m) => m.default_for?.includes(task));
  return (needs.text ? byDefault('text') : undefined) ?? byDefault(needs.task) ?? pool[0];
}

/** The cheapest model of a provider that can do the job (for "fast / draft" requests). */
function cheapest(provider: ProviderId, needs: Needs): ModelEntry | undefined {
  return modelsFor(provider)
    .filter((m) => !m.opt_in && fits(m, needs))
    .sort((a, b) => perImageUsd(a) - perImageUsd(b))[0];
}

const others = (available: readonly ProviderId[], except: ProviderId): ProviderId[] => available.filter((p) => p !== except);

export function planRoute(req: RouteRequest): RoutePlan {
  const needs: Needs = { task: req.task, text: req.textOnImage, images: (req.task === 'edit' ? 1 : 0) + req.extraReferences };

  // Rule 1: a named model decides everything.
  if (req.model) {
    const model = getModel(req.model);
    if (!model) {
      throw new UserFacingError('unknown_model', `"${req.model}" is not a model this server knows.`, `Leave "model" empty, or use one of: ${MODELS.map((m) => m.id).join(', ')}.`);
    }
    if (req.provider !== 'auto' && req.provider !== model.provider) {
      throw new UserFacingError(
        'model_provider_mismatch',
        `${model.id} belongs to ${providerShortName(model.provider)}, not ${providerShortName(req.provider)}.`,
        `Use provider "${model.provider}" or "auto" with that model, or pick another model.`,
      );
    }
    const problem = whyNot(model, needs);
    if (problem) throw new UserFacingError('model_cannot_do_it', `${problem}.`, 'Choose another model, or leave "model" empty and let the server pick one.');
    if (!req.available.includes(model.provider)) throw providerError('not_configured', model.provider, { alternatives: others(req.available, model.provider) });
    return { candidates: [{ provider: model.provider, model }], fallback: false, rule: 'named_model' };
  }

  // An explicit provider: its default model for the job, no fallback.
  if (req.provider !== 'auto') {
    if (!req.available.includes(req.provider)) throw providerError('not_configured', req.provider, { alternatives: others(req.available, req.provider) });
    const model = pick(req.provider, needs);
    if (!model) {
      const alt = tryInstead(others(req.available, req.provider));
      throw new UserFacingError(
        'provider_cannot_do_it',
        `${providerShortName(req.provider)} has no model that can ${describeJob(needs)}.`,
        alt ? `Try ${alt}, or use provider "auto".` : 'Use provider "auto" or ask the owner to set up another provider.',
      );
    }
    return { candidates: [{ provider: req.provider, model }], fallback: false, rule: 'named_provider' };
  }

  if (req.available.length === 0) {
    const names = PROVIDER_IDS.map((p) => PROVIDERS[p].env_key).join(', ');
    throw new UserFacingError('no_provider', 'No image provider is set up on this server.', `Ask the server owner to add at least one key (${names}).`);
  }

  const hint = `${req.prompt} ${req.style ?? ''}`;
  let order: ProviderId[];
  let rule: string;
  let draftModelFirst = false;
  if (req.textOnImage || req.extraReferences > 0) {
    order = ['gemini', 'fal', 'leonardo'];
    rule = 'text_or_references';
  } else if (req.task === 'edit') {
    order = ['gemini', 'fal', 'leonardo'];
    rule = 'plain_edit';
  } else if (LEONARDO_RE.test(hint)) {
    order = ['leonardo', 'gemini', 'fal'];
    rule = 'leonardo_requested';
  } else if (req.numImages > 1 && FAST_RE.test(hint)) {
    order = ['fal', 'gemini', 'leonardo'];
    rule = 'fast_drafts';
    draftModelFirst = true;
  } else {
    order = ['gemini', 'fal', 'leonardo'];
    rule = 'default';
  }

  const candidates: Candidate[] = [];
  for (const provider of order) {
    if (!req.available.includes(provider)) continue;
    const model = draftModelFirst && provider === 'fal' ? cheapest(provider, needs) : pick(provider, needs);
    if (model) candidates.push({ provider, model });
  }
  if (candidates.length === 0) {
    const reasons = req.available
      .map((p) => modelsFor(p).filter((m) => !m.opt_in).map((m) => whyNot(m, needs)).find((r) => r !== null))
      .filter((r): r is string => Boolean(r));
    throw new UserFacingError(
      'no_capable_provider',
      `None of the providers set up on this server can ${describeJob(needs)}${reasons[0] ? ` (${reasons[0]})` : ''}.`,
      needs.text ? 'Make the picture without text and add the words with compose_post, or ask the owner to set up Gemini.' : 'Ask the server owner to set up another provider.',
    );
  }
  return { candidates, fallback: true, rule };
}

function describeJob(needs: Needs): string {
  const what = needs.task === 'edit' ? 'edit photos' : needs.images > 0 ? 'make images from reference images' : 'make images';
  return needs.text ? `${what} with text inside them` : what;
}
