import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.js';
import { registerComposePost } from './tools/composePost.js';
import { registerDesignTools } from './tools/designTools.js';
import { registerEditImage } from './tools/editImage.js';
import { registerEstimateCost } from './tools/estimateCost.js';
import { registerGenerateImage } from './tools/generateImage.js';
import { registerGetJob } from './tools/getJob.js';
import { registerListProviders } from './tools/listProviders.js';
import { registerListTemplates } from './tools/listTemplates.js';
import { SERVER_NAME, VERSION } from './version.js';

/**
 * One fresh McpServer per HTTP request (the SDK's stateless model): nothing is kept between requests,
 * so tools close over the authenticated user name only.
 * Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md ("Understand the per-request factory")
 */

const INSTRUCTIONS =
  'Marketing Images: creates finished social-media graphics for non-technical users. Intended flow: ' +
  '(1) Brand: save_brand once (colors, fonts, logo, photo style, default templates) and use list_brands / get_brand to find it; then pass `brand` (its slug) to the image and compose tools so everything matches the company. ' +
  '(2) Background: generate_image makes a text-free AI picture (use leave_space to keep room for the headline; edit_image restyles a photo the user already has), or use a photo URL the user supplies. ' +
  'AI images cost money: call estimate_cost first and get the user’s OK before spending; list_providers shows the available models and today’s allowance; get_job finishes an image that took longer than the wait. ' +
  '(3) Compose: compose_post puts exact text on a photo or brand color (the text is drawn by the server, so spelling is always correct; never ask an AI model to draw headlines), ' +
  'compose_carousel makes multi-slide posts, compose_custom draws a layout you design as HTML, and list_templates / get_template / save_template / delete_template manage built-in and saved layouts. ' +
  '(4) Hand-off: returned image links are public for about 30 days and are meant to be given to the scheduling tool (Postiz uploadFromUrlTool). ' +
  'This server only makes images: it never publishes or schedules anything, so never tell the user a post is published or scheduled until the scheduling tool confirms it.';

export function createMcpServer(ctx: AppContext, user: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  registerListProviders(server, ctx, user);
  registerListTemplates(server, ctx, user);
  registerComposePost(server, ctx, user);
  registerDesignTools(server, ctx, user);
  registerEstimateCost(server, ctx, user);
  registerGenerateImage(server, ctx, user);
  registerEditImage(server, ctx, user);
  registerGetJob(server, ctx, user);
  return server;
}
