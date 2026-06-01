import { join } from 'path';
import { ConfigService } from '../services/config.js';
import { ROOT_DIR } from '../paths.js';
import type { BookClawGateway } from '../index.js';

/** Phase 1: Configuration. */
export async function initConfig(gw: BookClawGateway): Promise<void> {
  gw.config = new ConfigService(join(ROOT_DIR, 'config'));
  await gw.config.load();
  console.log('  ✓ Configuration loaded');
}
