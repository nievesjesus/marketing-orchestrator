import type { ModelEntry } from '../models.js';
import type { ImageTask } from './types.js';

/**
 * Builds the final prompt text from the structured tool input (DESIGN section 5). Ported from the Python
 * `mktlib/gemini.py build_prompt`: images are generated WITHOUT text unless the user explicitly asked for text in
 * the picture, because the post composer draws text deterministically and AI-rendered text is often misspelled.
 */

export type LeaveSpace = 'top' | 'bottom' | 'left' | 'right';

export interface PromptInput {
  task: ImageTask;
  /** `prompt` (generate) or `instruction` (edit). */
  text: string;
  style?: string | undefined;
  textOnImage?: string | undefined;
  leaveSpace?: LeaveSpace | undefined;
  negativePrompt?: string | undefined;
  /** Number of reference images besides the image being edited. */
  extraReferences: number;
}

export interface BuiltPrompt {
  /** Prompt with every hint merged. */
  prompt: string;
  /** Set only when the model takes a negative prompt natively. */
  negativePrompt?: string;
}

export function buildPrompt(input: PromptInput, model: ModelEntry): BuiltPrompt {
  const parts: string[] = [];

  if (input.task === 'edit') {
    parts.push(`Edit the attached image: ${input.text.trim()}\nKeep everything the instruction does not mention unchanged (same subject, composition and lighting).`);
    if (input.extraReferences > 0) {
      parts.push('The other attached images are references for the edit, not images to change.');
    }
  } else {
    parts.push(input.text.trim());
    if (input.extraReferences > 0) {
      parts.push('The attached images are references: use them for subject, palette and look, but do not copy them literally.');
    }
  }

  if (input.style?.trim()) parts.push(`Visual style: ${input.style.trim()}.`);
  if (input.leaveSpace) parts.push(`Keep the ${input.leaveSpace} area calm, no text.`);

  if (input.textOnImage?.trim()) {
    const exact = input.textOnImage.trim().replace(/"/g, "'");
    parts.push(`Render this exact text, spelled exactly as written and clearly legible: "${exact}". No other text.`);
  } else if (input.task === 'generate') {
    // Not for edits: the user's own photo may contain signs or logos that must stay.
    parts.push('No text, letters, logos or watermarks.');
  }

  const negative = input.negativePrompt?.trim();
  if (negative && !model.capabilities.negative_prompt) parts.push(`Avoid: ${negative}.`);

  const prompt = parts.join('\n\n');
  return negative && model.capabilities.negative_prompt ? { prompt, negativePrompt: negative } : { prompt };
}
