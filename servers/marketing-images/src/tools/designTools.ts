import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { registerBrandTools } from './brands.js';
import { registerComposeCarousel } from './composeCarousel.js';
import { registerComposeCustom } from './composeCustom.js';
import { registerTemplateTools } from './templates.js';

/** compose_custom, compose_carousel, save/get/delete_template and the brand tools (DESIGN sections 5.2 and the saved-brands addendum). */
export function registerDesignTools(server: McpServer, ctx: AppContext, user: string): void {
  registerComposeCustom(server, ctx, user);
  registerComposeCarousel(server, ctx, user);
  registerTemplateTools(server, ctx, user);
  registerBrandTools(server, ctx, user);
}
