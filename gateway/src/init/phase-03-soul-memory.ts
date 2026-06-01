import { join } from 'path';
import { SoulService } from '../services/soul.js';
import { MemoryService } from '../services/memory.js';
import { MemorySearchService } from '../services/memory-search.js';
import { ROOT_DIR } from '../paths.js';
import type { BookClawGateway } from '../index.js';

/** Phase 3 (+3b memory search): soul & memory. */
export async function initSoulMemory(gw: BookClawGateway): Promise<void> {
  gw.soul = new SoulService(join(ROOT_DIR, 'workspace', 'soul'));
  await gw.soul.load();
  console.log(`  ✓ Soul loaded: "${gw.soul.getName()}"`);

  gw.memory = new MemoryService(join(ROOT_DIR, 'workspace', 'memory'), gw.config.get('memory'));
  await gw.memory.initialize();
  console.log('  ✓ Memory system initialized');

  // ── Phase 3b: Memory Search (FTS5 over conversations + project outputs) ──
  // Hermes-inspired persistent cross-session search. Falls back gracefully
  // if better-sqlite3 isn't available on this platform.
  gw.memorySearch = new MemorySearchService(join(ROOT_DIR, 'workspace'));
  await gw.memorySearch.initialize();
  if (gw.memorySearch.isAvailable()) {
    // Wire memory.process() → live FTS indexing
    gw.memory.setLiveIndexHook((entry) => gw.memorySearch.indexConversationTurn(entry));
    // Index any pre-existing data on first boot — incremental on subsequent.
    try {
      const result = await gw.memorySearch.reindexAll();
      const stats = gw.memorySearch.getStats();
      console.log(`  ✓ Memory search ready: ${stats.totalEntries} entries indexed (added ${result.indexed}, skipped ${result.skipped})`);
    } catch (err) {
      console.warn(`  ⚠ Memory search reindex failed: ${(err as Error)?.message || err}`);
    }
  } else {
    console.log('  ⚠ Memory search unavailable (search will be disabled, rest of BookClaw works)');
  }
}
