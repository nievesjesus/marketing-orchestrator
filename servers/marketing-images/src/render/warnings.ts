/** A non-fatal note returned with the rendered image (the model decides whether to act on it). */
export interface RenderWarning {
  code: string;
  message: string;
  /** What to do next, written for the assistant. */
  suggestion?: string;
}

export function warn(list: RenderWarning[], code: string, message: string, suggestion?: string): void {
  if (list.some((w) => w.code === code && w.message === message)) return;
  list.push(suggestion ? { code, message, suggestion } : { code, message });
}
