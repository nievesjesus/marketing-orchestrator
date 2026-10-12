// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { adaptersFor } from '../providers/index.js';
import { checkJob, defaultDeps } from '../providers/orchestrator.js';
import { outcomeResult, uploadField } from './imageResult.js';
import { runTool } from './run.js';

const inputSchema = z.object({
  job_id: z.string().min(8).max(64).describe('The `job_id` returned by generate_image or edit_image when it said the image was still being made.'),
  upload_to_postiz: uploadField,
});

export function registerGetJob(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'get_job',
    {
      title: 'Check a pending image',
      description:
        'Finishes an image that generate_image or edit_image could not complete in time (status "pending"). ' +
        'It checks once, waits up to about 20 seconds inside the call, and returns either the finished images with previews (same shape as generate_image) ' +
        'or status "pending" again: in that case wait the suggested seconds and call it once more; do not call it in a tight loop. ' +
        'Jobs belong to the person who started them and are kept for 24 hours; after that the allowance is returned and the image must be requested again. ' +
        'Checking is free: the image is only billed when it finishes. ' +
        'Finished images also carry `file_path` (local stdio mode). Like generate_image and edit_image, get_job does not upload to Postiz unless upload_to_postiz=true; then each image has `postiz.path`, which you use directly as the Postiz attachment (skip uploadFromUrlTool).',
      inputSchema,
      annotations: { title: 'Check a pending image', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'get_job', async (meta) => {
        const outcome = await checkJob(ctx, user, args.job_id, defaultDeps(adaptersFor(ctx)));
        return outcomeResult(ctx, user, outcome, meta, args.upload_to_postiz);
      }),
  );
}
