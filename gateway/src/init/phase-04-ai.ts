import { join } from 'path';
import { CostTracker } from '../services/costs.js';
import { AIRouter } from '../ai/router.js';
import { ROOT_DIR } from '../paths.js';
import type { BookClawGateway } from '../index.js';

/** Phase 4: AI providers (cost tracker + router + active-provider logging). */
export async function initAI(gw: BookClawGateway): Promise<void> {
  const costsConfig = gw.config.get('costs') || {};
  costsConfig.persistPath = join(ROOT_DIR, 'workspace', 'costs.json');
  gw.costs = new CostTracker(costsConfig);
  await gw.costs.initialize();
  console.log(`  ✓ Budget: $${gw.costs.dailyLimit}/day, $${gw.costs.monthlyLimit}/month (persisted)`);

  gw.aiRouter = new AIRouter(gw.config.get('ai'), gw.vault, gw.costs);
  await gw.aiRouter.initialize();
  // Load global preferred provider from config
  const globalPref = gw.config.get('ai.preferredProvider');
  if (globalPref) {
    gw.aiRouter.setGlobalPreferredProvider(globalPref);
    console.log(`  ✓ Global preferred provider: ${globalPref}`);
  }
  const providers = gw.aiRouter.getActiveProviders();
  for (const p of providers) {
    const tier = p.tier === 'free' ? '🆓 FREE' : p.tier === 'cheap' ? '💰 CHEAP' : '💎 PAID';
    console.log(`  ✓ AI: ${p.name} (${p.model}) — ${tier}`);
  }
}
