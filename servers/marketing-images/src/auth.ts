import { createHash, timingSafeEqual } from 'node:crypto';
import type { AccessToken } from './config.js';

/**
 * Secret-URL authentication (DESIGN section 3): `/mcp/<token>` maps to a user name.
 *
 * Comparison is constant-time: every configured token is checked on every call
 * (no early exit) and the comparison runs over fixed-length SHA-256 digests, so
 * neither the token length nor the position of a match is observable by timing.
 */

const MAX_CANDIDATE_LENGTH = 256;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class TokenAuth {
  private readonly entries: { name: string; digest: Buffer }[];

  constructor(tokens: readonly AccessToken[]) {
    this.entries = tokens.map((t) => ({ name: t.name, digest: digest(t.token) }));
  }

  /** Returns the user name for a valid token, or null. Never throws, never logs. */
  authenticate(candidate: string | undefined): string | null {
    if (!candidate || candidate.length > MAX_CANDIDATE_LENGTH) return null;
    const candidateDigest = digest(candidate);
    let matched: string | null = null;
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, candidateDigest)) matched = entry.name;
    }
    return matched;
  }
}
