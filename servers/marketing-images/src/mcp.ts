import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.js';
import { registerComposePost } from './tools/composePost.js';
import { registerDesignTools } from './tools/designTools.js';
import { registerListProviders } from './tools/listProviders.js';
import { registerListTemplates } from './tools/listTemplates.js';
import { SERVER_NAME, VERSION } from './version.js';

/**
 * One fresh McpServer per HTTP request (the SDK's stateless model): nothing is kept between requests,
 * so tools close over the authenticated user name only.
 * Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md ("Understand the per-request factory")
 */

const INSTRUCTIONS =
  'Marketing Images: creates finished social-media graphics for non-technical users. ' +
  'Use compose_post to put exact text on a photo or brand color (the text is drawn by the server, so spelling is always correct); ' +
  'use list_templates to choose a layout and list_providers to see what image generation is available and today’s allowance. ' +
  'compose_carousel makes multi-slide posts, compose_custom draws a layout you design as HTML, save_template keeps one for reuse, and save_brand / list_brands / get_brand keep the company’s colors, fonts and logo so you can pass `brand` by name. ' +
  'Returned image links are public for about 30 days and are meant to be handed to the scheduling tool (Postiz uploadFromUrlTool).';

export function createMcpServer(ctx: AppContext, user: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  registerListProviders(server, ctx, user);
  registerListTemplates(server, ctx, user);
  registerComposePost(server, ctx, user);
  registerDesignTools(server, ctx, user);
  return server;
}
