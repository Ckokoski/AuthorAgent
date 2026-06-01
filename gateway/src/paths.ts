/**
 * Shared filesystem paths for BookClaw.
 *
 * Extracted from index.ts so the init/* modules and index.ts can both import
 * ROOT_DIR without a circular value-import (index.ts imports the init functions;
 * the init functions only need ROOT_DIR, not the gateway value).
 *
 * This file must live at gateway/src/ (same depth as index.ts) so the `..` math
 * resolves correctly both in dev (gateway/src/paths.ts) and in the compiled
 * build (dist/gateway/src/paths.js).
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROOT_DIR = __dirname.includes('dist')
  ? join(__dirname, '..', '..', '..')
  : join(__dirname, '..', '..');
