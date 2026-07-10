import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AIRouter, getRecommendedThinking, getOutputBudget } from './router.js';
import { Vault } from '../security/vault.js';
import { CostTracker } from '../services/costs.js';

// ── Pure helper functions ──

describe('getRecommendedThinking', () => {
  it('returns "high" for consistency and final_edit', () => {
    expect(getRecommendedThinking('consistency')).toBe('high');
    expect(getRecommendedThinking('final_edit')).toBe('high');
  });

  it('returns "medium" for revision', () => {
    expect(getRecommendedThinking('revision')).toBe('medium');
  });

  it('returns undefined for task types with no configured reasoning effort', () => {
    expect(getRecommendedThinking('creative_writing')).toBeUndefined();
    expect(getRecommendedThinking('outline')).toBeUndefined();
    expect(getRecommendedThinking('book_bible')).toBeUndefined();
    expect(getRecommendedThinking('unknown_task')).toBeUndefined();
  });
});

describe('getOutputBudget', () => {
  it('returns the configured budget for known task types', () => {
    expect(getOutputBudget('outline')).toBe(16384);
    expect(getOutputBudget('book_bible')).toBe(12288);
    expect(getOutputBudget('creative_writing')).toBe(16384);
    expect(getOutputBudget('revision')).toBe(16384);
    expect(getOutputBudget('consistency')).toBe(8192);
    expect(getOutputBudget('final_edit')).toBe(8192);
    expect(getOutputBudget('research')).toBe(8192);
    expect(getOutputBudget('general')).toBe(4096);
  });

  it('falls back to 4096 for an unrecognized task type', () => {
    expect(getOutputBudget('some_made_up_task')).toBe(4096);
  });
});

// ── AIRouter provider selection / tiering ──
//
// initialize() calls vault.get() for each provider's API key and pings
// Ollama over HTTP. We stub Vault.get and global fetch so no real network
// or filesystem I/O related to a live vault occurs, per file-ownership
// constraints (only touching a tmp vault dir here, never the real one).

describe('AIRouter provider selection and tiering (mocked vault/network)', () => {
  let vaultDir: string;
  let vault: Vault;
  let costs: CostTracker;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'authoragent-router-test-'));
    process.env.AUTHORCLAW_VAULT_KEY = 'test-router-key';
    vault = new Vault(vaultDir);
    await vault.initialize();
    costs = new CostTracker({ dailyLimit: 5, monthlyLimit: 50 });
    // Ollama check does a real fetch — force it to "unavailable" (offline) by
    // default so provider tests are deterministic regardless of the host
    // machine's local Ollama state.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.AUTHORCLAW_VAULT_KEY;
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('throws when no providers are configured/available', async () => {
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(() => router.selectProvider('general')).toThrow('No AI providers available');
  });

  it('registers a provider once its vault key is set, and selects it for a free-tier task', async () => {
    await vault.set('gemini_api_key', 'fake-gemini-key');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const provider = router.selectProvider('general'); // 'general' tier = 'free'; gemini is first in TIER_ROUTING.free
    expect(provider.id).toBe('gemini');
  });

  it('follows tier routing order: free tier prefers gemini over deepseek when both available', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('deepseek_api_key', 'k2');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('general').id).toBe('gemini');
  });

  it('falls through tier routing to the next available provider when the first is missing', async () => {
    await vault.set('deepseek_api_key', 'k2'); // no gemini key
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    // free tier order: gemini, ollama, deepseek, openrouter, openai, claude
    expect(router.selectProvider('general').id).toBe('deepseek');
  });

  it('premium tier prefers claude over other paid providers', async () => {
    await vault.set('claude_api_key', 'unused'); // wrong key name, sanity check it's ignored
    await vault.set('anthropic_api_key', 'k-claude');
    await vault.set('openai_api_key', 'k-openai');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('final_edit').id).toBe('claude'); // final_edit tier = 'premium'
  });

  it('mid tier falls through to claude when gemini/deepseek are unavailable', async () => {
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('creative_writing').id).toBe('claude'); // mid tier, only claude available
  });

  it('mid tier prefers gemini over deepseek and claude when all three are available', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('deepseek_api_key', 'k2');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('creative_writing').id).toBe('gemini');
  });

  it('an explicit preferred provider overrides tier routing when available', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    // 'general' would normally route to gemini, but explicit pref forces claude.
    expect(router.selectProvider('general', 'claude').id).toBe('claude');
  });

  it('falls back to tier routing with a warning when the preferred provider is unavailable', async () => {
    await vault.set('gemini_api_key', 'k1');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = router.selectProvider('general', 'claude'); // claude not configured
    expect(provider.id).toBe('gemini');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('global preferred provider is used across tiers once set', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    router.setGlobalPreferredProvider('claude');
    expect(router.getGlobalPreferredProvider()).toBe('claude');
    expect(router.selectProvider('general').id).toBe('claude');
    expect(router.selectProvider('final_edit').id).toBe('claude');
  });

  it('per-project preferred provider takes priority over the global preference', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    router.setGlobalPreferredProvider('claude');
    expect(router.selectProvider('general', 'gemini').id).toBe('gemini');
  });

  it('setGlobalPreferredProvider(null) clears the global preference', async () => {
    await vault.set('gemini_api_key', 'k1');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    router.setGlobalPreferredProvider('gemini');
    router.setGlobalPreferredProvider(null);
    expect(router.getGlobalPreferredProvider()).toBeNull();
  });

  it('skips non-free providers when over budget, keeping free providers usable', async () => {
    await vault.set('anthropic_api_key', 'k-claude'); // paid only
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const overBudgetCosts = new CostTracker({ dailyLimit: 0, monthlyLimit: 0 });
    overBudgetCosts.record('claude', 1000, 1); // push over the $0 daily limit
    (router as any).costs = overBudgetCosts;
    // 'general' tier routing has no free provider available here (only claude, paid) -> absolute fallback path
    // still returns claude since it's the only provider registered at all, ignoring budget in the final fallback.
    expect(router.selectProvider('general').id).toBe('claude');
  });

  it('getActiveProviders only returns providers marked available', async () => {
    await vault.set('gemini_api_key', 'k1');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const active = router.getActiveProviders();
    expect(active.map(p => p.id)).toEqual(['gemini']);
  });

  it('reinitialize() re-scans the vault and picks up newly stored keys', async () => {
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.getActiveProviders()).toHaveLength(0);

    await vault.set('openai_api_key', 'new-key');
    const activeIds = await router.reinitialize();
    expect(activeIds).toContain('openai');
  });

  describe('getFallbackProvider', () => {
    it('prefers a free provider over a paid one, excluding the current provider', async () => {
      await vault.set('gemini_api_key', 'k1'); // free
      await vault.set('anthropic_api_key', 'k-claude'); // paid
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      const fallback = router.getFallbackProvider('claude');
      expect(fallback?.id).toBe('gemini');
    });

    it('returns a paid provider when no free provider is available and not over budget', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      await vault.set('openai_api_key', 'k-openai');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      const fallback = router.getFallbackProvider('claude');
      expect(fallback?.id).toBe('openai');
    });

    it('returns null when over budget and no free provider exists', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      await vault.set('openai_api_key', 'k-openai');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      const overBudgetCosts = new CostTracker({ dailyLimit: 0, monthlyLimit: 0 });
      overBudgetCosts.record('claude', 1000, 1);
      (router as any).costs = overBudgetCosts;
      const fallback = router.getFallbackProvider('claude');
      expect(fallback).toBeNull();
    });

    it('returns null when there is no other provider at all', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      expect(router.getFallbackProvider('claude')).toBeNull();
    });
  });

  describe('model resolution precedence (override > config > default)', () => {
    let workspaceDir: string;

    beforeEach(async () => {
      workspaceDir = await mkdtemp(join(tmpdir(), 'authoragent-modelcfg-test-'));
    });

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true });
    });

    it('uses the hardcoded default when no config and no override are set', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-flash');
    });

    it('uses config.<provider>.model over the hardcoded default', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter(
        { ollama: { enabled: false }, gemini: { model: 'gemini-2.5-pro' } },
        vault, costs, workspaceDir,
      );
      await router.initialize();
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-pro');
    });

    it('override from model-config.json wins over both config and default, without restart', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter(
        { ollama: { enabled: false }, gemini: { model: 'gemini-2.5-pro' } },
        vault, costs, workspaceDir,
      );
      await router.initialize();
      // Override to a custom model; setProviderModel persists + reinitializes.
      await router.setProviderModel('gemini', 'gemini-experimental-x');
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-experimental-x');
    });

    it('persists the override to disk (survives a fresh router load)', async () => {
      await vault.set('gemini_api_key', 'k1');
      const r1 = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await r1.initialize();
      await r1.setProviderModel('gemini', 'gemini-2.5-pro');

      // New router pointed at the same workspace loads the persisted override.
      const r2 = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await r2.initialize();
      expect(r2.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-pro');
    });

    it('clearing the override (empty string) reverts to config/default', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter(
        { ollama: { enabled: false }, gemini: { model: 'gemini-2.5-pro' } },
        vault, costs, workspaceDir,
      );
      await router.initialize();
      await router.setProviderModel('gemini', 'gemini-experimental-x');
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-experimental-x');
      await router.setProviderModel('gemini', '');
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-pro');
    });

    it('setProviderModel throws for an unknown provider', async () => {
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      await expect(router.setProviderModel('not-a-provider', 'x')).rejects.toThrow('Unknown provider');
    });

    it('cost math is UNCHANGED for the default models (model-aware pricing preserves today\'s numbers)', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      await vault.set('openai_api_key', 'k-openai');
      await vault.set('deepseek_api_key', 'k-deepseek');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      const active = router.getActiveProviders();
      const claude = active.find(p => p.id === 'claude')!;
      const openai = active.find(p => p.id === 'openai')!;
      const deepseek = active.find(p => p.id === 'deepseek')!;
      expect(claude.costPer1kInput).toBe(0.003);
      expect(claude.costPer1kOutput).toBe(0.015);
      expect(openai.costPer1kInput).toBe(0.0025);
      expect(openai.costPer1kOutput).toBe(0.01);
      expect(deepseek.costPer1kInput).toBe(0.00014);
      expect(deepseek.costPer1kOutput).toBe(0.00028);
    });

    it('switching a provider model updates its cost math (model-aware pricing)', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      // Default claude = sonnet 4.5 = 0.003/0.015
      expect(router.getActiveProviders().find(p => p.id === 'claude')!.costPer1kInput).toBe(0.003);
      // Switch to Fable 5 = 0.010/0.050 (rough), cost math follows the model.
      await router.setProviderModel('claude', 'claude-fable-5');
      const claude = router.getActiveProviders().find(p => p.id === 'claude')!;
      expect(claude.model).toBe('claude-fable-5');
      expect(claude.costPer1kInput).toBe(0.010);
      expect(claude.costPer1kOutput).toBe(0.050);
    });

    it('getProviderModelInfo reports currentModel, defaultModel, knownModels, and price', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      const info = router.getProviderModelInfo();
      const gemini = info.find(p => p.id === 'gemini')!;
      expect(gemini.available).toBe(true);
      expect(gemini.currentModel).toBe('gemini-2.5-flash');
      expect(gemini.defaultModel).toBe('gemini-2.5-flash');
      expect(gemini.knownModels).toContain('gemini-2.5-pro');
      expect(gemini.price.costPer1kInput).toBe(0);
      // Providers without a key still appear, with available=false and the resolved default model.
      const claude = info.find(p => p.id === 'claude')!;
      expect(claude.available).toBe(false);
      expect(claude.currentModel).toBe('claude-sonnet-4-5-20250929');
      expect(claude.knownModels).toContain('claude-fable-5');
    });
  });

  describe('complete() dispatch (smoke test)', () => {
    // TODO: deeper coverage — complete() has one HTTP-calling method per
    // provider (completeOllama/completeGemini/completeClaude/
    // completeOpenAICompatible) each with its own response parsing, error
    // handling, and reasoning-effort request shaping. Fully exercising those
    // would mean mocking fetch responses per-provider-shape; only the
    // top-level dispatch/error path is smoke-tested here since that's pure
    // routing logic, not network-format detail.
    it('throws for a provider id that was never registered', async () => {
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      await expect(router.complete({
        provider: 'claude',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Provider claude not found');
    });

    it('caches system-prompt hashes across calls to the same provider (cache stats increment)', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      // completeGemini will attempt a real fetch; global fetch is stubbed to
      // reject, so the call itself throws, but cache bookkeeping happens
      // before the provider-specific branch runs.
      await expect(router.complete({
        provider: 'gemini',
        system: 'same system prompt',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow();
      const stats1 = router.getCacheStats();
      expect(stats1.misses).toBe(1);
      expect(stats1.hits).toBe(0);

      await expect(router.complete({
        provider: 'gemini',
        system: 'same system prompt',
        messages: [{ role: 'user', content: 'hi again' }],
      })).rejects.toThrow();
      const stats2 = router.getCacheStats();
      expect(stats2.hits).toBe(1);
      expect(stats2.savedTokens).toBeGreaterThan(0);
    });
  });
});
