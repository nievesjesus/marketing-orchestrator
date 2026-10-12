import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.js';
import type { ImageOwners } from './image-owners.js';
import type { Storage } from './storage.js';
import { registerComposePost } from './tools/composePost.js';
import { registerDesignTools } from './tools/designTools.js';
import { registerEditImage } from './tools/editImage.js';
import { registerEstimateCost } from './tools/estimateCost.js';
import { registerGenerateImage } from './tools/generateImage.js';
import { registerGetJob } from './tools/getJob.js';
import { registerListProviders } from './tools/listProviders.js';
import { registerListTemplates } from './tools/listTemplates.js';
import { registerUploadToPostiz } from './tools/uploadToPostiz.js';
import { SERVER_NAME, VERSION } from './version.js';

/**
 * One fresh McpServer per HTTP request (the SDK's stateless model): nothing is kept between requests,
 * so tools close over the authenticated user name only.
 * Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md ("Understand the per-request factory")
 */

const INTRO =
  'Marketing Images: creates finished social-media graphics for non-technical users. Intended flow: ' +
  '(1) Brand: save_brand once (colors, fonts, logo, photo style, default templates) and use list_brands / get_brand to find it; then pass `brand` (its slug) to the image and compose tools so everything matches the company. ' +
  '(2) Background: generate_image makes a text-free AI picture (use leave_space to keep room for the headline; edit_image restyles a photo the user already has), or use a photo URL the user supplies. ' +
  'AI images cost money: call estimate_cost first and get the user’s OK before spending; list_providers shows the available models and today’s allowance; get_job finishes an image that took longer than the wait. ' +
  '(3) Compose: compose_post puts exact text on a photo or brand color (the text is drawn by the server, so spelling is always correct; never ask an AI model to draw headlines), ' +
  'compose_carousel makes multi-slide posts, compose_custom draws a layout you design as HTML, and list_templates / get_template / save_template / delete_template manage built-in and saved layouts. ';

const CLOSING =
  'This server only makes images: it never publishes or schedules anything, so never tell the user a post is published or scheduled until the scheduling tool confirms it.';

/** The server instructions for this deployment: public links, or local files (stdio), with or without the Postiz upload. */
export function buildInstructions(ctx: AppContext): string {
  const localOnly = ctx.config.mode === 'stdio' && ctx.config.publicBaseUrl === null;
  const handoff = localOnly
    ? '(4) Hand-off: this server runs on the user’s own computer, so every image is a LOCAL file: results carry `file_path` and a `file://` `url`. Remote services such as the Postiz uploadFromUrlTool cannot reach local files, so attach the file from `file_path` yourself or use upload_to_postiz. ' +
      'A local `url` can be passed back to this server (as a background, an asset or the image to edit). Images are kept for about 30 days. '
    : '(4) Hand-off: returned image links are public for about 30 days and are meant to be given to the scheduling tool (Postiz uploadFromUrlTool). ';
  const postiz = ctx.postiz
    ? 'Postiz upload is on: compose_post, compose_custom and compose_carousel upload the final graphic automatically, and generate_image, edit_image and get_job do NOT upload unless upload_to_postiz=true (their pictures are usually backgrounds that get a headline later). ' +
      'When a result has `postiz.path` (also `images[].postiz.path`, `slides[].postiz.path`; a carousel lists them in order in `postiz_paths`), the image is already in Postiz, so use that path directly as the Postiz attachment and skip uploadFromUrlTool. ' +
      'Pass upload_to_postiz=false to skip an upload, or call upload_to_postiz for an earlier image; a `postiz_error` is only a warning and the image itself is fine (call upload_to_postiz once, or attach the file yourself). Postiz allows 30 uploads per hour. '
    : '';
  return `${INTRO}${handoff}${postiz}${CLOSING}`;
}

/** Records who made each stored image, so tools that take an image back can check ownership (upload_to_postiz). */
class OwnedStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    private readonly owners: ImageOwners,
    private readonly user: string,
  ) {}

  async put(data: Buffer, ext: 'png' | 'jpg') {
    const stored = await this.inner.put(data, ext);
    this.owners.record(stored.key, this.user);
    return stored;
  }

  open(relativePath: string) {
    return this.inner.open(relativePath);
  }

  sweep() {
    return this.inner.sweep();
  }

  localPath(key: string) {
    return this.inner.localPath(key);
  }

  keyForUrl(url: string) {
    return this.inner.keyForUrl(url);
  }

  keyForPath(absPath: string) {
    return this.inner.keyForPath(absPath);
  }
}

export function createMcpServer(baseCtx: AppContext, user: string): McpServer {
  const ctx: AppContext = { ...baseCtx, storage: new OwnedStorage(baseCtx.storage, baseCtx.owners, user) };
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: buildInstructions(ctx) });
  registerListProviders(server, ctx, user);
  registerListTemplates(server, ctx, user);
  registerComposePost(server, ctx, user);
  registerDesignTools(server, ctx, user);
  registerEstimateCost(server, ctx, user);
  registerGenerateImage(server, ctx, user);
  registerEditImage(server, ctx, user);
  registerGetJob(server, ctx, user);
  registerUploadToPostiz(server, ctx, user);
  return server;
}
