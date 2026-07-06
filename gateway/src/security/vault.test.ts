import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from './vault.js';

// IMPORTANT: These tests point Vault at a fresh directory under the OS tmp
// dir on every run and set AUTHORCLAW_VAULT_KEY explicitly, so they NEVER
// touch the real project vault at config/.vault or the out-of-repo key file
// under %LOCALAPPDATA%/AuthorClaw. Each test also uses a vault dir that is
// NOT under a path containing "onedrive"/"dropbox"/etc, so the cloud-sync
// warning path in resolveVaultKey() isn't exercised (that's log-only anyway).

describe('Vault (AES-256-GCM) — tmpdir roundtrip', () => {
  let vaultDir: string;
  let originalKey: string | undefined;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'authorclaw-vault-test-'));
    originalKey = process.env.AUTHORCLAW_VAULT_KEY;
    process.env.AUTHORCLAW_VAULT_KEY = 'test-key-for-vitest-do-not-use-in-prod';
  });

  afterEach(async () => {
    if (originalKey === undefined) delete process.env.AUTHORCLAW_VAULT_KEY;
    else process.env.AUTHORCLAW_VAULT_KEY = originalKey;
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('initializes and creates a vault.enc file in the tmp dir', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    const list = await vault.list();
    expect(list).toEqual([]);
  });

  it('set() then get() roundtrips a value', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    await vault.set('anthropic_api_key', 'sk-ant-test-12345');
    const value = await vault.get('anthropic_api_key');
    expect(value).toBe('sk-ant-test-12345');
  });

  it('roundtrips values containing unicode and special characters', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    const tricky = 'val with spaces, "quotes", \n newlines, and emoji 🔐 — em dash';
    await vault.set('tricky_key', tricky);
    expect(await vault.get('tricky_key')).toBe(tricky);
  });

  it('get() returns null for a key that was never set', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    expect(await vault.get('nonexistent_key')).toBeNull();
  });

  it('list() reflects all stored keys', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    await vault.set('key_a', 'value_a');
    await vault.set('key_b', 'value_b');
    const keys = await vault.list();
    expect(keys.sort()).toEqual(['key_a', 'key_b']);
  });

  it('delete() removes a key and returns true', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    await vault.set('to_delete', 'gone-soon');
    const deleted = await vault.delete('to_delete');
    expect(deleted).toBe(true);
    expect(await vault.get('to_delete')).toBeNull();
    expect(await vault.list()).toEqual([]);
  });

  it('delete() returns false for a key that does not exist', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    expect(await vault.delete('never_existed')).toBe(false);
  });

  it('set() overwrites an existing key with a new value', async () => {
    const vault = new Vault(vaultDir);
    await vault.initialize();
    await vault.set('overwrite_me', 'first-value');
    await vault.set('overwrite_me', 'second-value');
    expect(await vault.get('overwrite_me')).toBe('second-value');
  });

  it('persists data across a new Vault instance pointed at the same dir', async () => {
    const vault1 = new Vault(vaultDir);
    await vault1.initialize();
    await vault1.set('persisted_key', 'persisted_value');

    // Re-open with a fresh Vault instance against the same directory + same key.
    const vault2 = new Vault(vaultDir);
    await vault2.initialize();
    expect(await vault2.get('persisted_key')).toBe('persisted_value');
  });

  it('fails to decrypt (returns null) when re-opened with a different master key', async () => {
    const vault1 = new Vault(vaultDir);
    await vault1.initialize();
    await vault1.set('secret', 'top-secret-value');

    process.env.AUTHORCLAW_VAULT_KEY = 'a-completely-different-key';
    const vault2 = new Vault(vaultDir);
    await vault2.initialize();
    // Wrong key -> scrypt derives a different AES key -> GCM auth tag check
    // fails -> get() catches the decipher error and returns null.
    expect(await vault2.get('secret')).toBeNull();
  });

  it('get()/set()/delete() are no-ops-safe before initialize (never throws for get/delete)', async () => {
    const vault = new Vault(vaultDir);
    expect(await vault.get('anything')).toBeNull();
    expect(await vault.delete('anything')).toBe(false);
  });

  it('set() before initialize() throws "Vault not initialized"', async () => {
    const vault = new Vault(vaultDir);
    await expect(vault.set('key', 'value')).rejects.toThrow('Vault not initialized');
  });
});
