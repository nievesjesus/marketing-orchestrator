// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
// Postiz upload endpoint: https://docs.postiz.com/public-api/openapi.json (POST /upload, multipart field `file`)
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import { postizFor } from './postizHelpers.js';
import { jsonResult, runTool } from './run.js';

const inputSchema = z.object({
  url: z.url().optional().describe('The `url` of an image this server made for the user (from compose_post, compose_custom, compose_carousel, generate_image or edit_image). A `file://` URL works in local mode.'),
  file_path: z.string().min(1).max(4096).optional().describe('Local mode: the absolute `file_path` of an image this server made. Give exactly one of `url` or `file_path`.'),
});

export function registerUploadToPostiz(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'upload_to_postiz',
    {
      title: 'Upload an image to Postiz',
      description:
        'Uploads an image that THIS server made for the user (a `url` or `file_path` from a previous result) to the user’s Postiz account, and returns `postiz.path`: ' +
        'use that path directly as the Postiz attachment when scheduling (skip uploadFromUrlTool). Use it when an earlier call did not upload (generate_image, edit_image and get_job never upload by default, compose_* did not because upload_to_postiz was false or POSTIZ_AUTO_UPLOAD is off, or a `postiz_error` came back), ' +
        'and in local (stdio) mode to turn a local file into something Postiz can attach. Only images made for you can be uploaded, not arbitrary links or files. ' +
        'An image that was already uploaded is returned again without a new upload. Postiz allows only 30 requests per hour. ' +
        'Needs Postiz credentials on the server (POSTIZ_URL and POSTIZ_API_KEY); without them the call explains how to set them up. Nothing is published or scheduled by this tool.',
      inputSchema,
      annotations: { title: 'Upload an image to Postiz', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'upload_to_postiz', async (meta) => {
        if (!ctx.postiz) {
          throw new UserFacingError(
            'postiz_not_configured',
            'Postiz upload is not configured on this server.',
            'The owner must set POSTIZ_URL and POSTIZ_API_KEY (in HTTP mode also POSTIZ_ALLOW_IN_HTTP=true for a single-tenant deployment). Until then, give the image `url` to the scheduling tool (Postiz uploadFromUrlTool).',
          );
        }
        const given = [args.url, args.file_path].filter((v) => v !== undefined).length;
        if (given !== 1) throw new UserFacingError('give_one_image', 'Give exactly one of `url` or `file_path`.', 'Pass the `url` or `file_path` from the result that made the image.');

        const key = args.url !== undefined ? ctx.storage.keyForUrl(args.url) : ctx.storage.keyForPath(args.file_path as string);
        // Unknown, expired, outside the store and somebody else's all answer the same: nothing reveals other users' images.
        if (!key || !ctx.owners.isOwnedBy(key, user)) {
          throw new UserFacingError(
            'image_not_found',
            'No image made for you by this server matches that link or path.',
            'Pass the `url` or `file_path` returned by compose_post, compose_custom, compose_carousel, generate_image or edit_image (images are deleted after the retention period).',
          );
        }
        if (!(await ctx.storage.open(key))) {
          throw new UserFacingError('image_expired', 'That image is no longer stored (images are deleted after the retention period).', 'Make the image again.');
        }
        const cached = ctx.owners.getPostiz(key) !== null;
        const result = await postizFor(ctx, key, true, { autoDefault: true, meta });
        if (!result.postiz) {
          throw new UserFacingError('postiz_failed', result.postiz_error ?? 'The Postiz upload failed.', 'The image itself is fine and is still available; try again later.');
        }
        return jsonResult({
          id: result.postiz.id,
          path: result.postiz.path,
          postiz: result.postiz,
          already_uploaded: cached,
          next_step: 'Use `postiz.path` directly as the Postiz attachment when scheduling the post (skip uploadFromUrlTool: the image is already in Postiz).',
        });
      }),
  );
}
