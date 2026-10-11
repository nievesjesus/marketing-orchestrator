/**
 * Errors that are safe to show to the person using the assistant.
 *
 * `message` must be plain language (no stack traces, no secrets, no URLs that
 * carry credentials). `suggestion` tells the model what to do next.
 */
export class UserFacingError extends Error {
  override readonly name = 'UserFacingError';

  constructor(
    readonly code: string,
    message: string,
    readonly suggestion?: string,
  ) {
    super(message);
  }

  /** Text for an MCP tool result with `isError: true`. */
  toToolText(): string {
    return this.suggestion ? `${this.message} ${this.suggestion}` : this.message;
  }
}

export function isUserFacingError(err: unknown): err is UserFacingError {
  return err instanceof UserFacingError;
}
