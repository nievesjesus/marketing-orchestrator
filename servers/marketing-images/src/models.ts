/**
 * The ONLY model catalog (DESIGN section 6). No other file may contain a model
 * id or a price: hard-coded catalogs rot silently, so everything that needs
 * one reads it from here and `test/models.test.ts` checks its integrity.
 *
 * Providers are NOT implemented yet (plan step 4); this file only describes them.
 *
 * Sources (verified 2026-10-10):
 *  - Gemini: https://ai.google.dev/gemini-api/docs/image-generation ·
 *            https://ai.google.dev/api/generate-content · https://ai.google.dev/gemini-api/docs/pricing
 *  - fal:    https://fal.ai/docs/model-apis/model-endpoints/queue ·
 *            per-model schema https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
 *  - Leonardo: https://docs.leonardo.ai/reference/creategeneration.md ·
 *            https://docs.leonardo.ai/docs/lucid-origin.md · /docs/phoenix.md · /docs/flux-1-kontext-pro.md
 */

export const RATIOS = ['1:1', '4:5', '9:16', '16:9', '3:2', '2:3'] as const;
export type Ratio = (typeof RATIOS)[number];

export const PROVIDER_IDS = ['gemini', 'fal', 'leonardo'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type Task = 'generate' | 'edit' | 'text';

export interface Capabilities {
  /** Text to image. */
  t2i: boolean;
  /** Edit/restyle an input image. */
  edit: boolean;
  /** Accepts reference images. */
  refs: boolean;
  /** Renders legible text inside the image. */
  text: boolean;
  mask: boolean;
  negative_prompt: boolean;
  seed: boolean;
}

/** Provider-specific request fragment for one aspect ratio (merged into the request by the provider adapter). */
export type ProviderParams = Record<string, string | number | { width: number; height: number }>;

export type RefField = 'image_url' | 'image_urls' | 'guidances.image_reference';

export type Price =
  | { usd_per_image: Record<string, number>; estimate?: boolean }
  | { usd_per_mp: number; estimate?: boolean };

export interface ModelEntry {
  id: string;
  provider: ProviderId;
  label: string;
  /** Tasks for which this model is the DEFAULT within its provider. */
  default_for?: Task[];
  /** Not selected automatically; only used when the caller names it. */
  opt_in?: boolean;
  capabilities: Capabilities;
  max_refs: number;
  aspect: Record<Ratio, ProviderParams>;
  /** Ratios the provider cannot produce exactly; `aspect` holds the nearest one. */
  approx_ratios?: Ratio[];
  /** Size tokens accepted by `price.usd_per_image` (e.g. 1K, 2K). */
  sizes: string[];
  ref_field?: RefField;
  /** When `aspect` carries explicit pixel sizes: every side must be a multiple of this. */
  dimension_multiple?: number;
  /** When `aspect` carries explicit pixel sizes: allowed side length [min, max]. */
  dimension_range?: [number, number];
  price: Price;
  /** ISO date the id/price/params were checked against the docs. */
  verified_on: string;
  doc_url: string;
  notes?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Environment variable that holds the key (missing key = provider unavailable). */
  env_key: string;
  notes: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (Nano Banana)',
    env_key: 'GEMINI_API_KEY',
    notes: 'Best at following detailed prompts and at text inside images. Every output carries an invisible SynthID watermark.',
  },
  fal: {
    id: 'fal',
    label: 'fal.ai',
    env_key: 'FAL_KEY',
    notes: 'Fast and cheap drafts (FLUX schnell) plus a second route to Nano Banana 2 and FLUX Kontext edits.',
  },
  leonardo: {
    id: 'leonardo',
    label: 'Leonardo.Ai',
    env_key: 'LEONARDO_API_KEY',
    notes: 'Distinct "Leonardo look" and style presets. Prices are estimates until the response reports the real cost.',
  },
};

const VERIFIED_ON = '2026-10-10';

// ---- Aspect mappings --------------------------------------------------------

/** Gemini `imageConfig.aspectRatio` accepts our ratios unchanged. */
const geminiAspect: Record<Ratio, ProviderParams> = {
  '1:1': { aspectRatio: '1:1' },
  '4:5': { aspectRatio: '4:5' },
  '9:16': { aspectRatio: '9:16' },
  '16:9': { aspectRatio: '16:9' },
  '3:2': { aspectRatio: '3:2' },
  '2:3': { aspectRatio: '2:3' },
};

/** fal nano-banana-2 `aspect_ratio` enum includes all six (checked against the OpenAPI schema 2026-10-11). */
const falNanoAspect: Record<Ratio, ProviderParams> = {
  '1:1': { aspect_ratio: '1:1' },
  '4:5': { aspect_ratio: '4:5' },
  '9:16': { aspect_ratio: '9:16' },
  '16:9': { aspect_ratio: '16:9' },
  '3:2': { aspect_ratio: '3:2' },
  '2:3': { aspect_ratio: '2:3' },
};

/** FLUX Kontext enum (21:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16, 9:21) has no 4:5: nearest is 3:4. */
const falKontextAspect: Record<Ratio, ProviderParams> = {
  '1:1': { aspect_ratio: '1:1' },
  '4:5': { aspect_ratio: '3:4' },
  '9:16': { aspect_ratio: '9:16' },
  '16:9': { aspect_ratio: '16:9' },
  '3:2': { aspect_ratio: '3:2' },
  '2:3': { aspect_ratio: '2:3' },
};

/** ~1 MP explicit sizes, every side a multiple of 16 (FLUX) and therefore also of 8 (Leonardo). */
const PIXELS_1MP: Record<Ratio, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 912, height: 1136 },
  '9:16': { width: 768, height: 1360 },
  '16:9': { width: 1360, height: 768 },
  '3:2': { width: 1248, height: 832 },
  '2:3': { width: 832, height: 1248 },
};

function byRatio(fn: (ratio: Ratio) => ProviderParams): Record<Ratio, ProviderParams> {
  return { '1:1': fn('1:1'), '4:5': fn('4:5'), '9:16': fn('9:16'), '16:9': fn('16:9'), '3:2': fn('3:2'), '2:3': fn('2:3') };
}

const falFluxAspect = byRatio((r) => ({ image_size: PIXELS_1MP[r] }));

const leonardoAspect = byRatio((r) => ({ width: PIXELS_1MP[r].width, height: PIXELS_1MP[r].height }));

// ---- Catalog ------------------------------------------------------------------

const geminiCaps: Capabilities = {
  t2i: true,
  edit: true,
  refs: true,
  text: true,
  mask: false,
  negative_prompt: false,
  seed: false,
};

export const MODELS: readonly ModelEntry[] = [
  // Gemini — x-goog-api-key, POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
  {
    id: 'gemini-3.1-flash-image',
    provider: 'gemini',
    label: 'Nano Banana 2',
    default_for: ['generate', 'edit', 'text'],
    capabilities: geminiCaps,
    max_refs: 14,
    aspect: geminiAspect,
    sizes: ['1K', '2K'],
    price: { usd_per_image: { '1K': 0.067, '2K': 0.101 } },
    verified_on: VERIFIED_ON,
    doc_url: 'https://ai.google.dev/gemini-api/docs/image-generation',
    notes: 'Stable default; generateContent confirmed.',
  },
  {
    id: 'gemini-nano-banana-2.1',
    provider: 'gemini',
    label: 'Nano Banana 2.1',
    opt_in: true,
    capabilities: geminiCaps,
    max_refs: 14,
    aspect: geminiAspect,
    sizes: ['1K', '2K'],
    price: { usd_per_image: { '1K': 0.0336, '2K': 0.0504 } },
    verified_on: VERIFIED_ON,
    doc_url: 'https://ai.google.dev/gemini-api/docs/image-generation',
    notes: 'Released 2026-10-06 and cheaper. UNCONFIRMED on generateContent (docs show the Interactions API): opt-in until verified.',
  },
  {
    id: 'gemini-3-pro-image',
    provider: 'gemini',
    label: 'Nano Banana Pro',
    capabilities: geminiCaps,
    max_refs: 14,
    aspect: geminiAspect,
    sizes: ['1K', '2K'],
    price: { usd_per_image: { '1K': 0.134, '2K': 0.134 } },
    verified_on: VERIFIED_ON,
    doc_url: 'https://ai.google.dev/gemini-api/docs/image-generation',
    notes: 'High-end quality. GA id (the -preview ids shut down 2026-06-25).',
  },

  // fal — Authorization: Key $FAL_KEY, queue API https://queue.fal.run/{model_id}
  {
    id: 'fal-ai/flux/schnell',
    provider: 'fal',
    label: 'FLUX schnell',
    capabilities: { t2i: true, edit: false, refs: false, text: false, mask: false, negative_prompt: false, seed: true },
    max_refs: 0,
    aspect: falFluxAspect,
    sizes: ['~1MP'],
    dimension_multiple: 16,
    price: { usd_per_mp: 0.003 },
    verified_on: VERIFIED_ON,
    doc_url: 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/schnell',
    notes: 'Cheap, fast drafts; photoreal. num_images 1-4; keep enable_safety_checker on.',
  },
  {
    id: 'fal-ai/nano-banana-2',
    provider: 'fal',
    label: 'Nano Banana 2 (fal)',
    default_for: ['generate'],
    capabilities: { t2i: true, edit: false, refs: false, text: true, mask: false, negative_prompt: false, seed: true },
    max_refs: 0,
    aspect: falNanoAspect,
    sizes: ['1K', '2K'],
    price: { usd_per_image: { '1K': 0.08, '2K': 0.12 } },
    verified_on: VERIFIED_ON,
    doc_url: 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-2',
    notes: 'Quality text-to-image. 2K costs 1.5x the 1K price. resolution enum 0.5K/1K/2K/4K, num_images 1-4.',
  },
  {
    id: 'fal-ai/nano-banana-2/edit',
    provider: 'fal',
    label: 'Nano Banana 2 edit (fal)',
    default_for: ['edit'],
    capabilities: { t2i: false, edit: true, refs: true, text: true, mask: false, negative_prompt: false, seed: true },
    max_refs: 14,
    aspect: falNanoAspect,
    sizes: ['1K', '2K'],
    ref_field: 'image_urls',
    price: { usd_per_image: { '1K': 0.08, '2K': 0.12 } },
    verified_on: VERIFIED_ON,
    doc_url: 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-2/edit',
    notes: 'max_refs follows the underlying Gemini limit; the fal schema declares no maxItems.',
  },
  {
    id: 'fal-ai/flux-pro/kontext',
    provider: 'fal',
    label: 'FLUX Kontext (fal)',
    capabilities: { t2i: false, edit: true, refs: true, text: false, mask: false, negative_prompt: false, seed: true },
    max_refs: 1,
    aspect: falKontextAspect,
    approx_ratios: ['4:5'],
    sizes: ['default'],
    ref_field: 'image_url',
    price: { usd_per_image: { default: 0.04 } },
    verified_on: VERIFIED_ON,
    doc_url: 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux-pro/kontext',
    notes: 'Single-image edit. No 4:5 output: 3:4 is used, so crop to 4:5 when composing.',
  },

  // Leonardo — API v2, Authorization: Bearer <key>, POST https://cloud.leonardo.ai/api/rest/v2/generations
  {
    id: 'lucid-origin',
    provider: 'leonardo',
    label: 'Lucid Origin',
    default_for: ['generate'],
    capabilities: { t2i: true, edit: false, refs: false, text: false, mask: false, negative_prompt: false, seed: true },
    max_refs: 0,
    aspect: leonardoAspect,
    sizes: ['default'],
    dimension_multiple: 8,
    dimension_range: [16, 3616],
    price: { usd_per_image: { default: 0.02 }, estimate: true },
    verified_on: VERIFIED_ON,
    doc_url: 'https://docs.leonardo.ai/docs/lucid-origin.md',
    notes: 'quantity 1-8, mode FAST|ULTRA, style_ids. Real cost comes from the generation response.',
  },
  {
    id: 'phoenix-v1.0',
    provider: 'leonardo',
    label: 'Phoenix 1.0',
    capabilities: { t2i: true, edit: false, refs: false, text: false, mask: false, negative_prompt: true, seed: true },
    max_refs: 0,
    aspect: leonardoAspect,
    sizes: ['default'],
    dimension_multiple: 8,
    dimension_range: [32, 2048],
    price: { usd_per_image: { default: 0.02 }, estimate: true },
    verified_on: VERIFIED_ON,
    doc_url: 'https://docs.leonardo.ai/docs/phoenix.md',
    notes: 'Styles and negative prompt; contrast and mode parameters.',
  },
  {
    id: 'flux-kontext-pro',
    provider: 'leonardo',
    label: 'FLUX Kontext Pro (Leonardo)',
    default_for: ['edit'],
    capabilities: { t2i: false, edit: true, refs: true, text: false, mask: false, negative_prompt: false, seed: true },
    max_refs: 4,
    aspect: leonardoAspect,
    sizes: ['default'],
    ref_field: 'guidances.image_reference',
    dimension_multiple: 8,
    dimension_range: [32, 2048],
    price: { usd_per_image: { default: 0.04 }, estimate: true },
    verified_on: VERIFIED_ON,
    doc_url: 'https://docs.leonardo.ai/docs/flux-1-kontext-pro.md',
    notes: 'Edit through guidances.image_reference (UNCONFIRMED end-to-end).',
  },
];

// ---- Helpers ------------------------------------------------------------------

export function modelsFor(provider: ProviderId): ModelEntry[] {
  return MODELS.filter((m) => m.provider === provider);
}

export function getModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

/** The provider's default model for a task, or undefined when it has none. */
export function defaultModel(provider: ProviderId, task: Task): ModelEntry | undefined {
  return MODELS.find((m) => m.provider === provider && m.default_for?.includes(task));
}

/** Does this model have the capability needed by the task? */
export function supportsTask(model: ModelEntry, task: Task): boolean {
  switch (task) {
    case 'generate':
      return model.capabilities.t2i;
    case 'edit':
      return model.capabilities.edit;
    case 'text':
      return model.capabilities.text && (model.capabilities.t2i || model.capabilities.edit);
  }
}

/** Approximate USD per image (about 1 MP for per-megapixel prices). */
export function estimateImageUsd(model: ModelEntry, size?: string): number {
  if ('usd_per_mp' in model.price) return model.price.usd_per_mp;
  const table = model.price.usd_per_image;
  const key = size && size in table ? size : (model.sizes[0] as string);
  return table[key] as number;
}
