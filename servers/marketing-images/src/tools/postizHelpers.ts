import * as z from 'zod/v4';
import type { PostizCopy } from '../image-owners.js';
import type { AppContext } from '../context.js';
import { IMAGE_CONTENT_TYPES, PostizError } from '../postiz.js';
import { serializeError } from '../logger.js';
import { readStoredImage } from '../providers/orchestrator.js';
import type { LogMeta } from './run.js';

/**
 * Shared pieces of the Postiz hand-off and of the local (stdio) file references, used by every tool that
 * produces an image.
 */

/** `upload_to_postiz` of the compose tools: the final graphic is uploaded automatically when Postiz is configured. */
export const uploadToPostizField = z
  .boolean()
  .optional()
  .describe(
    'Upload the finished graphic to Postiz. Leave empty (recommended): it is uploaded automatically when the server has Postiz credentials (unless the owner set POSTIZ_AUTO_UPLOAD=false); false skips it, true forces it. ' +
      'On success the result has `postiz.path`: use it directly as the Postiz attachment (skip uploadFromUrlTool). A failed upload only adds a `postiz_error` warning.',
  );

/**
 * `upload_to_postiz` of generate_image, edit_image and get_job: these pictures are usually backgrounds that get a
 * headline later, so they are NOT uploaded unless the call says true (Postiz allows only 30 uploads per hour).
 */
export const uploadImageToPostizField = z
  .boolean()
  .optional()
  .describe(
    'Upload this picture to Postiz. Leave empty (recommended): pictures from this tool are NOT uploaded, because they are normally backgrounds that get a headline later and compose_post uploads the final graphic by itself. ' +
      'Pass true only when the picture itself is the finished image (no headline will be added) and the server has Postiz credentials. Then the result has `postiz.path`: use it directly as the Postiz attachment (skip uploadFromUrlTool). A failed upload only adds a `postiz_error` warning.',
  );

export interface PostizOutcome {
  postiz?: PostizCopy;
  postiz_error?: string;
}

/** True in local stdio mode without PUBLIC_BASE_URL: image links are `file://` and unreachable for remote services. */
export function isLocalOnly(ctx: AppContext): boolean {
  return ctx.config.mode === 'stdio' && ctx.config.publicBaseUrl === null;
}

/** `file_path` (absolute local path) of a stored image; only in stdio mode, where the client shares the disk. */
export function fileRef(ctx: AppContext, key: string): { file_path?: string } {
  if (ctx.config.mode !== 'stdio') return {};
  const filePath = ctx.storage.localPath(key);
  return filePath ? { file_path: filePath } : {};
}

const NOT_CONFIGURED =
  'Postiz upload is not configured on this server (set POSTIZ_URL and POSTIZ_API_KEY; in HTTP mode also POSTIZ_ALLOW_IN_HTTP=true for a single-tenant deployment).';

/**
 * Uploads a stored image to Postiz when the call (or the tool's default) asks for it. Never throws: a failure
 * becomes `postiz_error`. `requested` is the call's `upload_to_postiz`: false skips, true forces (even if
 * `POSTIZ_AUTO_UPLOAD=false`), undefined follows the default: only when `autoDefault` is true (the compose tools,
 * which make the final graphic) AND the server setting `POSTIZ_AUTO_UPLOAD` is on. generate_image, edit_image and
 * get_job pass `autoDefault: false`: their pictures are usually backgrounds, and Postiz allows only 30 uploads per
 * hour. Drafts that still need fixing are not uploaded automatically. An image already uploaded is returned from the
 * cache instead of using another of Postiz's 30 requests per hour.
 */
export async function postizFor(
  ctx: AppContext,
  key: string,
  requested: boolean | undefined,
  options: {
    /** Whether an unspecified `upload_to_postiz` means "upload" for this tool (compose_*: true; generate/edit/get_job: false). */
    autoDefault: boolean;
    /** The bytes just produced (otherwise read back from storage). */
    data?: Buffer | undefined;
    meta?: LogMeta | undefined;
    /** The image has warnings that must be fixed first: it is not uploaded automatically (only if the call says `true`). */
    draft?: boolean | undefined;
  },
): Promise<PostizOutcome> {
  const { data, meta } = options;
  if (requested === false) return {};
  if (options.draft && requested !== true) return {};
  const client = ctx.postiz;
  if (!client) return requested === true ? { postiz_error: NOT_CONFIGURED } : {};
  if (requested === undefined && !(options.autoDefault && client.autoUpload)) return {};

  try {
    const cached = ctx.owners.getPostiz(key);
    if (cached) {
      if (meta) meta.postiz = 'cached';
      return { postiz: cached };
    }
    const bytes = data ?? (await readStoredImage(ctx, key));
    if (!bytes) {
      if (meta) meta.postiz = 'error';
      return { postiz_error: 'The image file could not be read back for the Postiz upload.' };
    }
    const ext = key.endsWith('.jpg') ? 'jpg' : 'png';
    const started = Date.now();
    const uploaded = await client.upload({ data: bytes, filename: key.split('/').pop() ?? `image.${ext}`, contentType: IMAGE_CONTENT_TYPES[ext] });
    ctx.owners.setPostiz(key, uploaded);
    ctx.logger.info('postiz_upload', { ok: true, bytes: bytes.length, ms: Date.now() - started });
    if (meta) meta.postiz = 'uploaded';
    return { postiz: uploaded };
  } catch (err) {
    if (meta) meta.postiz = 'error';
    if (err instanceof PostizError) {
      ctx.logger.warn('postiz_upload', { ok: false, code: err.code });
      return { postiz_error: err.message };
    }
    ctx.logger.warn('postiz_upload', { ok: false, ...serializeError(err) });
    return { postiz_error: 'The Postiz upload failed unexpectedly.' };
  }
}

export type HandoffKind = 'one' | 'many' | 'pick';

/**
 * The "what to do with the link" clause of `next_step`. Without Postiz and with public links it is the text the
 * tools always had; with a Postiz copy it points at `postiz.path`; for local files it says remote services cannot
 * reach them.
 */
export function handoffClause(ctx: AppContext, kind: HandoffKind, uploaded: boolean): string {
  if (uploaded) {
    if (kind === 'many') {
      return 'use each slide’s `postiz.path` (also listed in order in `postiz_paths`) directly as the Postiz attachments: the images are already in Postiz, so skip uploadFromUrlTool.';
    }
    return `use ${kind === 'pick' ? 'the chosen image’s' : 'the'} \`postiz.path\` directly as the Postiz attachment: the image is already in Postiz, so skip uploadFromUrlTool.`;
  }
  if (isLocalOnly(ctx)) {
    return kind === 'one'
      ? 'use the local file (`file_path`): remote services such as Postiz uploadFromUrlTool cannot reach a file on this computer, so call upload_to_postiz (when Postiz is configured) or attach the file yourself.'
      : 'use the local files (`file_path` of each image): remote services such as Postiz uploadFromUrlTool cannot reach files on this computer, so call upload_to_postiz for each (when Postiz is configured) or attach the files yourself.';
  }
  if (kind === 'many') return 'give the `urls` (in this order) to the scheduling tool (e.g. Postiz uploadFromUrlTool); the links are kept for about 30 days.';
  if (kind === 'pick') return 'give the final `url` to the scheduling tool (e.g. Postiz uploadFromUrlTool); the links stay available for about 30 days.';
  return 'give `url` to the scheduling tool (e.g. Postiz uploadFromUrlTool); the link is kept for about 30 days.';
}
