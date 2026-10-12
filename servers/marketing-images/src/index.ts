import { reportFatal, runServer } from './app.js';

/**
 * HTTP entry for containers and `npm run dev`: process environment only (Docker, Coolify and `tsx --env-file`
 * already provide the settings). The user-facing entry point is `cli.ts` (the `marketing-images` command).
 */
runServer({ mode: 'http', env: process.env }).catch(reportFatal);
