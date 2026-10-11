// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveBrandArg } from '../brands.js';
import type { AppContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import { scanTokens } from '../render/custom/tokens.js';
import { FORMAT_NAMES, FORMATS } from '../render/formats.js';
import { makePreview, PreviewBudget } from '../render/preview.js';
import { BUILTIN_INFO, builtinVariables, starterHtml } from '../render/templates/catalog.js';
import { getTemplate, TEMPLATES } from '../render/templates/index.js';
import { warn, type RenderWarning } from '../render/warnings.js';
import type { VariableSpec } from '../templates-store.js';
import { jsonResult, runTool } from './run.js';
import { CUSTOM_BLOCKING_WARNINGS, brandArgSchema, exampleInputs, renderSavedTemplate, templatePreviewUrl, thumbnail } from './shared.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const variableSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letters, digits, "-" and "_"').describe('Name used in the HTML as {{var.<name>}} (text) or {{asset.<name>}} (image).'),
  kind: z.enum(['text', 'image']).describe('text = a string drawn as text; image = a public https image link, used as {{asset.<name>}}.'),
  required: z.boolean().optional().describe('Default true. Optional text variables become empty; optional images become transparent.'),
  max_chars: z.number().int().min(1).max(2000).optional().describe('Text only: the longest text the layout was designed for (longer ones get a warning).'),
  example: z.string().max(2000).optional().describe('Example value used for the preview: a text, or a public https image link. Required for required variables.'),
  description: z.string().max(120).optional().describe('One line telling a future user what to put here.'),
});

const saveSchema = z.object({
  name: z.string().regex(NAME_RE, 'Use lower-case letters, digits and "-" (2-40), e.g. "summer-sale"').describe('Template name, unique per owner. Saving an existing name creates a new version (older versions are kept).'),
  description: z.string().min(5).max(300).describe('What this layout is for, in a sentence, so it can be picked later.'),
  html: z.string().min(1).max(50 * 1024).describe('The layout: HTML with inline styles using {{var.<name>}} / {{asset.<name>}} placeholders and the brand/format/safe tokens (same rules as compose_custom).'),
  variables: z.array(variableSchema).max(40).describe('The placeholders the layout uses, with examples. Every {{var.*}} / {{asset.*}} in the HTML should be listed here.'),
  formats: z.array(z.enum(FORMAT_NAMES)).max(5).optional().describe('The formats this layout was designed for. Other formats still work, with a warning. Default: any.'),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/)).max(8).optional().describe('Lower-case tags for finding it later (list_templates filters by tag).'),
  shared: z.boolean().optional().describe('true = every user of this server can use it (not edit or delete it). Default false (private).'),
  brand: brandArgSchema.optional().describe('Brand used to draw the preview (slug or inline). Templates use brand tokens, so the preview shows how they look with it.'),
  preview_format: z.enum(FORMAT_NAMES).optional().describe('Format of the preview (default: the first designed format, else square).'),
});

const variableLine = (v: VariableSpec): Record<string, unknown> => ({
  name: v.name,
  kind: v.kind,
  required: v.required,
  ...(v.max_chars !== undefined ? { max_chars: v.max_chars } : {}),
  ...(v.example !== undefined ? { example: v.example } : {}),
  ...(v.description !== undefined ? { description: v.description } : {}),
});

export { variableLine };

export function registerTemplateTools(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'save_template',
    {
      title: 'Save a reusable layout',
      description:
        'Saves a layout (HTML with inline styles and placeholders, as for compose_custom) as a reusable template under the user’s name, so later posts and carousels can use it with compose_post / compose_carousel by name. ' +
        'The server first draws it with the examples you give for each variable; if that fails nothing is saved, and the preview picture and any warnings are returned so you can fix the layout. ' +
        'Saving the same name again creates version + 1 (older versions are kept). `shared: true` lets every user of this server use it; otherwise only the user can. ' +
        'Only save a layout the user liked or asked to keep.',
      inputSchema: saveSchema,
      annotations: { title: 'Save a reusable layout', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'save_template', async (meta) => {
        meta.template = args.name;
        if (getTemplate(args.name)) {
          throw new UserFacingError('name_reserved', `"${args.name}" is the name of a built-in template.`, 'Pick another name, e.g. add the brand or campaign: "summer-sale".');
        }
        const variables: VariableSpec[] = args.variables.map((v) => ({ name: v.name, kind: v.kind, required: v.required !== false, max_chars: v.max_chars, example: v.example, description: v.description }));
        const seen = new Set<string>();
        for (const v of variables) {
          if (seen.has(v.name)) throw new UserFacingError('variable_duplicate', `The variable "${v.name}" is listed twice.`, 'Each variable name must be unique.');
          seen.add(v.name);
          if (v.required && v.example === undefined) {
            throw new UserFacingError('example_required', `The required variable "${v.name}" needs an example (${v.kind === 'image' ? 'a public https image link' : 'a sample text'}) to draw the preview.`, 'Add `example`, or set required: false.');
          }
        }

        const warnings: RenderWarning[] = [];
        const tokens = scanTokens(args.html);
        for (const t of tokens) {
          const m = /^(var|asset)\.([A-Za-z0-9_-]+)/.exec(t);
          if (m && !seen.has(m[2] as string)) warn(warnings, 'variable_undeclared', `The HTML uses {{${t}}} but "${m[2]}" is not in \`variables\`.`, 'Add it to `variables` so users know to provide it.');
        }
        for (const v of variables) {
          const used = [...tokens].some((t) => t === `${v.kind === 'image' ? 'asset' : 'var'}.${v.name}` || t.startsWith(`asset.${v.name}.`));
          if (!used) warn(warnings, 'variable_unused', `The variable "${v.name}" is declared but the HTML never uses it.`, 'Use it as {{var.<name>}} (text) or {{asset.<name>}} (image), or remove it.');
        }

        const brandWarnings: RenderWarning[] = [];
        const brand = await resolveBrandArg(ctx, user, args.brand, brandWarnings);
        const format = args.preview_format ?? args.formats?.[0] ?? 'square';
        const quota = ctx.ledger.countRender(user);
        const examples = exampleInputs(variables);
        const draft = { name: args.name, html: args.html, variables, formats: args.formats ?? [] };
        const out = await renderSavedTemplate({ ctx, record: draft, format, brand, variables: examples.variables, assets: examples.assets, output: 'jpg' });

        const record = ctx.templates.save(user, {
          name: args.name,
          description: args.description,
          html: args.html,
          variables,
          formats: args.formats ?? [],
          tags: args.tags ?? [],
          shared: args.shared === true,
        });
        const stored = await ctx.storage.put(await thumbnail(out.data), 'jpg');
        ctx.templates.setPreviewUrl(record.id, stored.url);
        const preview = await makePreview(out.data, new PreviewBudget().remaining);
        const all = [...brandWarnings, ...warnings, ...out.warnings];
        meta.version = record.version;
        meta.warnings = all.map((w) => w.code);
        return jsonResult(
          {
            saved: true,
            name: record.name,
            version: record.version,
            owner: user,
            shared: record.shared,
            formats: record.formats,
            tags: record.tags,
            variables: record.variables.map(variableLine),
            preview_url: stored.url,
            preview_format: format,
            warnings: all,
            needs_attention: all.some((w) => CUSTOM_BLOCKING_WARNINGS.has(w.code)),
            graphics_left_today: quota.left,
            use_it: `compose_post with template "${record.name}" and the variables/assets listed above (or compose_carousel slides).`,
          },
          preview ? [{ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType }] : [],
        );
      }),
  );

  server.registerTool(
    'get_template',
    {
      title: 'Get a layout’s HTML',
      description:
        'Returns the HTML of a template so you can reuse or remix it with compose_custom: the exact HTML for a saved template (own or shared), or a hand-written starter equivalent for a built-in one ' +
        '(photo-headline, cta-card, quote-card, split, minimal-badge, carousel-cover, carousel-point, carousel-end; the starter looks similar, not pixel-identical). ' +
        'Also returns the variables it expects, the formats it was designed for and its tags. Read-only and free.',
      inputSchema: z.object({
        name: z.string().min(1).max(81).describe('Built-in id, or a saved template name ("name", or "owner/name" for a shared one from someone else).'),
        version: z.number().int().min(1).optional().describe('Saved templates you own: a specific older version (default: the latest).'),
      }),
      annotations: { title: 'Get a layout’s HTML', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, version }) =>
      runTool(ctx, user, 'get_template', async (meta) => {
        meta.template = name;
        const spec = getTemplate(name);
        if (spec) {
          return jsonResult({
            name: spec.id,
            kind: 'built-in',
            description: spec.description,
            best_for: spec.best_for,
            tags: BUILTIN_INFO[spec.id]?.tags ?? [],
            formats: Object.keys(FORMATS),
            variables: builtinVariables(spec).map(variableLine),
            html: starterHtml(spec.id),
            notes: [
              'This is a starter equivalent of the built-in layout, written as compose_custom HTML: it looks similar but is not pixel-identical, and it shows the tokens to use.',
              'To use the built-in as is, call compose_post with template "' + spec.id + '".',
              'Fill the variables with variables / assets in compose_custom; the photo goes in assets as "background".',
            ],
          });
        }
        const record = version !== undefined ? ctx.templates.getOwn(user, name, version) : ctx.templates.find(user, name);
        if (!record || (version !== undefined && record.owner !== user)) {
          throw new UserFacingError('template_not_found', `There is no template called "${name}"${version !== undefined ? ` (version ${version})` : ''} that you can use.`, 'Call list_templates to see the available ones.');
        }
        return jsonResult({
          name: record.name,
          kind: 'saved',
          owner: record.owner,
          own: record.owner === user,
          shared: record.shared,
          version: record.version,
          description: record.description,
          tags: record.tags,
          formats: record.formats.length > 0 ? record.formats : Object.keys(FORMATS),
          variables: record.variables.map(variableLine),
          html: record.html,
          preview_url: await templatePreviewUrl(ctx, record),
        });
      }),
  );

  server.registerTool(
    'delete_template',
    {
      title: 'Delete a saved layout',
      description:
        'Deletes one of the USER’S OWN saved templates (every version). It cannot be undone through this server and posts can no longer use it by name. ' +
        'ALWAYS ask the user to confirm first ("Delete the template summer-sale?") and only call this after they say yes. Built-in and other people’s templates cannot be deleted.',
      inputSchema: z.object({ name: z.string().regex(NAME_RE).describe('Name of one of the user’s own saved templates.') }),
      annotations: { title: 'Delete a saved layout', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) =>
      runTool(ctx, user, 'delete_template', async (meta) => {
        meta.template = name;
        if (getTemplate(name) || TEMPLATES.some((t) => t.id === name)) {
          throw new UserFacingError('template_builtin', 'Built-in templates cannot be deleted.', 'Only your own saved templates can be deleted.');
        }
        const removed = ctx.templates.delete(user, name);
        if (removed === 0) {
          const visible = ctx.templates.find(user, name); // only returns what the caller may see (own or shared)
          if (visible) throw new UserFacingError('template_not_yours', `The template "${name}" is shared by ${visible.owner} and can only be deleted by them.`, 'You can still use it, or save your own template under another name.');
          throw new UserFacingError('template_not_found', `You have no saved template called "${name}".`, 'Call list_templates to see your templates.');
        }
        return jsonResult({ deleted: true, name, versions_removed: removed });
      }),
  );
}
