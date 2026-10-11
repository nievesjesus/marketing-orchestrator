import { UserFacingError } from '../errors.js';
import { PROVIDERS, type ProviderId } from '../models.js';

/**
 * Provider failures as plain-language `UserFacingError`s (DESIGN sections 7 and 10).
 *
 * Every message comes from the table below, so nothing an upstream service says can leak through: not keys,
 * not tokens, not URLs with credentials. The only upstream text ever shown is a short snippet for `validation`
 * errors, and it goes through `sanitizeDetail` first (links and secrets removed, length capped).
 *
 * `kind` drives the routing rule: provider-side failures may fall back to the next provider, while safety
 * refusals and validation problems never do (a second provider would just repeat the problem).
 */

export type ProviderErrorKind =
  | 'not_configured' // no key on this server
  | 'auth' // key rejected, or account/billing problem
  | 'credits' // out of credits / payment required
  | 'rate_limit' // 429
  | 'timeout' // no answer in time
  | 'server' // 5xx or an unusable answer
  | 'network' // could not reach the service
  | 'model_unavailable' // model id unknown to (or not enabled for) this key
  | 'safety' // content policy refusal
  | 'validation' // the request itself is wrong
  | 'bad_reference' // an input image link the provider could not load
  | 'no_image'; // success with no picture and no stated reason

/** Failures of the provider, not of the request: the next provider may well succeed. */
export const FALLBACK_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'not_configured',
  'auth',
  'credits',
  'rate_limit',
  'timeout',
  'server',
  'network',
  'model_unavailable',
]);

/** Worth retrying a status check for (the job itself is not lost). */
export const TRANSIENT_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>(['rate_limit', 'timeout', 'server', 'network']);

/** Short reason shown in `fallback_from`, e.g. "leonardo (out of credits)". */
const FALLBACK_REASON: Record<ProviderErrorKind, string> = {
  not_configured: 'not set up',
  auth: 'key rejected',
  credits: 'out of credits',
  rate_limit: 'rate limited',
  timeout: 'timed out',
  server: 'server error',
  network: 'unreachable',
  model_unavailable: 'model unavailable',
  safety: 'safety refusal',
  validation: 'request rejected',
  bad_reference: 'reference image not loadable',
  no_image: 'no image returned',
};

const SHORT_NAME: Record<ProviderId, string> = { gemini: 'Gemini', fal: 'fal.ai', leonardo: 'Leonardo' };

export const providerShortName = (id: ProviderId): string => SHORT_NAME[id];

export class ProviderError extends UserFacingError {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: ProviderId,
    message: string,
    suggestion?: string,
  ) {
    super(`provider_${kind}`, message, suggestion);
  }

  get fallbackReason(): string {
    return FALLBACK_REASON[this.kind];
  }

  /** The same error with a different next-step hint (used once the router knows the other options). */
  withSuggestion(suggestion: string): ProviderError {
    return new ProviderError(this.kind, this.provider, this.message, suggestion);
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** "try Gemini or fal.ai" for a set of other providers, or null when there is none. */
export function tryInstead(others: readonly ProviderId[]): string | null {
  const names = others.map(providerShortName);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

export interface ErrorContext {
  /** Other providers that are set up on this server (for the "try ..." hint). */
  alternatives?: readonly ProviderId[];
  /** Sanitized upstream detail (validation errors only). */
  detail?: string;
}

/** The mapping table: kind -> message and suggestion. */
export function providerError(kind: ProviderErrorKind, provider: ProviderId, context: ErrorContext = {}): ProviderError {
  const name = providerShortName(provider);
  const env = PROVIDERS[provider].env_key;
  const alt = tryInstead(context.alternatives ?? []);
  const tryAlt = alt ? `Try ${alt} instead.` : undefined;
  const ownerFix = (what: string): string => `Ask the server owner to ${what}.`;

  switch (kind) {
    case 'not_configured':
      return new ProviderError(
        kind,
        provider,
        alt ? `${name} isn't set up on this server, try ${alt} instead.` : `${name} isn't set up on this server.`,
        alt ? 'Use provider "auto" or name one of those providers.' : ownerFix(`add the ${env} setting`),
      );
    case 'auth':
      return new ProviderError(kind, provider, `${name} did not accept this server's access key (or the account has a billing problem).`, tryAlt ?? ownerFix(`check the ${env} setting and the ${name} account`));
    case 'credits':
      return new ProviderError(kind, provider, `${name} has run out of credits.`, tryAlt ?? ownerFix(`top up the ${name} account`));
    case 'rate_limit':
      return new ProviderError(kind, provider, `${name} is receiving too many requests right now.`, tryAlt ? `Wait a minute and retry, or ${tryAlt.charAt(0).toLowerCase()}${tryAlt.slice(1)}` : 'Wait a minute and try again.');
    case 'timeout':
      return new ProviderError(kind, provider, `${name} took too long to answer.`, tryAlt ?? 'Try again in a moment.');
    case 'server':
      return new ProviderError(kind, provider, `${name} is having problems right now.`, tryAlt ?? 'Try again in a few minutes.');
    case 'network':
      return new ProviderError(kind, provider, `${name} could not be reached from this server.`, tryAlt ?? 'Try again in a few minutes.');
    case 'model_unavailable':
      return new ProviderError(kind, provider, `That ${name} model is not available for this server's account.`, tryAlt ?? 'Choose another model, or leave the model empty.');
    case 'safety':
      return new ProviderError(
        kind,
        provider,
        `${name} declined to make this image for safety reasons.`,
        'Describe the picture differently: avoid real people, brands, violence or adult themes. The same request is not retried on another provider.',
      );
    case 'validation':
      return new ProviderError(
        kind,
        provider,
        context.detail ? `${name} could not use that request (${context.detail}).` : `${name} could not use that request.`,
        'Adjust the request (shorter prompt, other size or fewer images) and try again.',
      );
    case 'bad_reference':
      return new ProviderError(
        kind,
        provider,
        `${name} could not load one of the reference image links.`,
        'Use a direct public link to a JPEG, PNG or WebP file (for example a Postiz media link), not a web page.',
      );
    case 'no_image':
      return new ProviderError(kind, provider, `${name} answered without returning an image.`, 'Rephrase the prompt, or try again or another provider.');
  }
}

/**
 * Short, safe text from an upstream error body for validation errors: links and secrets are removed, whitespace
 * is collapsed and the length is capped.
 */
export function sanitizeDetail(text: unknown, secrets: readonly string[] = [], max = 140): string | undefined {
  if (typeof text !== 'string') return undefined;
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/\b(?:key|token|bearer|authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!out) return undefined;
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** Status-based defaults shared by the adapters; each adapter checks its own provider-specific signals first. */
export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credits';
  if (status === 404) return 'model_unavailable';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status === 400 || status === 422) return 'validation';
  return 'server';
}
