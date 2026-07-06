/**
 * AuthorClaw Encrypted Vault
 * AES-256-GCM encrypted credential storage
 * Inherited from MoatBot security architecture
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { readFile, writeFile, mkdir, rename, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

interface VaultData {
  version: number;
  salt: string;
  entries: Record<string, {
    iv: string;
    tag: string;
    ciphertext: string;
  }>;
}

export class Vault {
  private vaultPath: string;
  private data: VaultData | null = null;
  private masterKey: Buffer | null = null;
  private initialized = false;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async initialize(): Promise<void> {
    await mkdir(this.vaultPath, { recursive: true });
    const filePath = join(this.vaultPath, 'vault.enc');

    if (existsSync(filePath)) {
      const raw = await readFile(filePath, 'utf-8');
      this.data = JSON.parse(raw);
    } else {
      // Create new vault
      this.data = {
        version: 1,
        salt: randomBytes(SALT_LENGTH).toString('hex'),
        entries: {},
      };
    }

    // Resolve the vault key. Precedence:
    //   1. env var AUTHORCLAW_VAULT_KEY (if set)
    //   2. key file outside the repo (LOCALAPPDATA on Windows, ~/.authorclaw elsewhere)
    //   3. migrate a legacy key from the repo .env (then comment it out there)
    //   4. generate a new key and persist it to the key file
    // The key is NEVER written to .env anymore — .env lives under OneDrive and would
    // sync the key to the cloud beside the very vault it protects.
    const passphrase = await this.resolveVaultKey();

    const effectivePassphrase = passphrase || randomBytes(32).toString('hex');
    this.masterKey = scryptSync(
      effectivePassphrase,
      Buffer.from(this.data!.salt, 'hex'),
      KEY_LENGTH
    );

    this.initialized = true;
  }

  /** Directory holding the out-of-repo key file. */
  private keyDir(): string {
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA
        || join(homedir(), 'AppData', 'Local');
      return join(base, 'AuthorClaw');
    }
    return join(homedir(), '.authorclaw');
  }

  /** Absolute path to the out-of-repo key file. */
  private keyFilePath(): string {
    return join(this.keyDir(), 'vault.key');
  }

  /** Repo .env path (two levels up from config/.vault). */
  private envPath(): string {
    return join(this.vaultPath, '..', '..', '.env');
  }

  /**
   * Returns true if the given path appears to live inside a cloud-sync folder
   * (OneDrive / Dropbox / Google Drive). Used to warn loudly when the key is
   * sourced from a location that syncs to the cloud.
   */
  private isCloudSyncedPath(p: string): boolean {
    return /(onedrive|dropbox|google\s*drive|googledrive|gdrive)/i.test(p);
  }

  /** Persist the key to the out-of-repo key file with restrictive perms. */
  private async writeKeyFile(key: string): Promise<void> {
    const dir = this.keyDir();
    await mkdir(dir, { recursive: true });
    const filePath = this.keyFilePath();
    await writeFile(filePath, key, { encoding: 'utf-8', mode: 0o600 });
    try {
      // Best-effort tighten perms (mode on writeFile is a no-op on Windows).
      await chmod(filePath, 0o600);
    } catch {
      // Non-fatal on filesystems that don't support chmod (e.g. Windows).
    }
  }

  /**
   * If the repo .env contains AUTHORCLAW_VAULT_KEY matching the given key,
   * migrate it to the out-of-repo key file and comment out the .env line.
   * Returns true if a migration (or an already-migrated key file) covers it.
   */
  private async migrateEnvKeyIfPresent(key: string): Promise<boolean> {
    const envPath = this.envPath();
    if (!existsSync(envPath)) return false;
    try {
      const envContent = await readFile(envPath, 'utf-8');
      const match = envContent.match(/^AUTHORCLAW_VAULT_KEY=(.+)$/m);
      if (!match || match[1].trim() !== key) return false;

      const keyFile = this.keyFilePath();
      await this.writeKeyFile(key);
      const date = new Date().toISOString().slice(0, 10);
      const commented = envContent.replace(
        /^AUTHORCLAW_VAULT_KEY=.+$/m,
        `# AUTHORCLAW_VAULT_KEY migrated to ${keyFile} on ${date}`
      );
      await writeFile(envPath, commented);
      console.log('  🔐 MIGRATED vault key out of the repo .env to a secure out-of-repo location.');
      console.log(`     New location: ${keyFile}`);
      console.log('     The line in .env has been commented out (not deleted). Existing');
      console.log('     vault data still decrypts — same key, new home.');
      return true;
    } catch (err) {
      console.warn('  ⚠️  WARNING: Found vault key in .env but could NOT migrate it:',
        (err as Error).message);
      return false;
    }
  }

  private async resolveVaultKey(): Promise<string> {
    const keyFile = this.keyFilePath();

    // 1. Explicit environment variable wins — but dotenv loads the repo .env
    // into process.env before we run, so an env-var key that also appears in
    // .env is really a legacy .env key and must still be migrated out.
    const envKey = (process.env.AUTHORCLAW_VAULT_KEY || '').trim();
    if (envKey) {
      const migrated = await this.migrateEnvKeyIfPresent(envKey);
      if (migrated) return envKey;
      if (this.isCloudSyncedPath(this.envPath()) || this.isCloudSyncedPath(process.cwd())) {
        console.warn('  ⚠️  WARNING: Vault key sourced from environment variable while the');
        console.warn('     repository lives under a cloud-synced folder (OneDrive/Dropbox/Google Drive).');
        console.warn('     If AUTHORCLAW_VAULT_KEY is set in a synced .env, your key is syncing to the cloud');
        console.warn(`     beside the vault it protects. Move it to: ${keyFile}`);
      }
      console.log('  🔑 Loaded vault key from AUTHORCLAW_VAULT_KEY environment variable.');
      return envKey;
    }

    // 2. Out-of-repo key file.
    if (existsSync(keyFile)) {
      try {
        const key = (await readFile(keyFile, 'utf-8')).trim();
        if (key) {
          console.log(`  🔑 Loaded vault key from ${keyFile}`);
          return key;
        }
        console.warn(`  ⚠️  WARNING: Key file ${keyFile} exists but is empty.`);
      } catch {
        console.warn(`  ⚠️  WARNING: Could not read key file ${keyFile}.`);
      }
    }

    // 3. Migrate a legacy key out of the repo .env, if present.
    const envPath = this.envPath();
    if (existsSync(envPath)) {
      try {
        const envContent = await readFile(envPath, 'utf-8');
        const match = envContent.match(/^AUTHORCLAW_VAULT_KEY=(.+)$/m);
        if (match && match[1].trim()) {
          const legacyKey = match[1].trim();
          try {
            await this.writeKeyFile(legacyKey);
            const date = new Date().toISOString().slice(0, 10);
            const commented = envContent.replace(
              /^AUTHORCLAW_VAULT_KEY=.+$/m,
              `# AUTHORCLAW_VAULT_KEY migrated to ${keyFile} on ${date}`
            );
            await writeFile(envPath, commented);
            console.log('  🔐 MIGRATED vault key out of the repo .env to a secure out-of-repo location.');
            console.log(`     New location: ${keyFile}`);
            console.log('     The line in .env has been commented out (not deleted). Existing');
            console.log('     vault data still decrypts — same key, new home.');
            return legacyKey;
          } catch (err) {
            // Migration write failed — still use the key so data decrypts, but warn.
            console.warn('  ⚠️  WARNING: Found vault key in .env but could NOT migrate it to');
            console.warn(`     ${keyFile}: ${(err as Error).message}`);
            if (this.isCloudSyncedPath(envPath)) {
              console.warn('     Your vault key remains in a cloud-synced .env. Move it manually.');
            }
            return legacyKey;
          }
        }
      } catch {
        console.warn('  ⚠️  WARNING: Could not read .env file for key migration.');
      }
    }

    // 4. First run (or no key found anywhere) — generate and persist out of repo.
    const generated = randomBytes(32).toString('hex');
    try {
      await this.writeKeyFile(generated);
      console.log('  🔑 Generated a new vault key and saved it securely (outside the repo).');
      console.log(`     Location: ${keyFile}`);
      console.log('     Your API keys will persist across restarts.');
      return generated;
    } catch {
      console.warn('  ⚠️  WARNING: Could not write key file to', keyFile);
      console.warn('     Using a random session key. Vault data will NOT persist across restarts.');
      console.warn('     Set AUTHORCLAW_VAULT_KEY environment variable for production use.');
      return generated;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.initialized || !this.data || !this.masterKey) return null;

    const entry = this.data.entries[key];
    if (!entry) return null;

    try {
      const iv = Buffer.from(entry.iv, 'hex');
      const tag = Buffer.from(entry.tag, 'hex');
      const ciphertext = Buffer.from(entry.ciphertext, 'hex');

      const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf-8');
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.initialized || !this.data || !this.masterKey) {
      throw new Error('Vault not initialized');
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);

    let encrypted = cipher.update(value, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    this.data.entries[key] = {
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ciphertext: encrypted.toString('hex'),
    };

    await this.save();
  }

  async delete(key: string): Promise<boolean> {
    if (!this.initialized || !this.data) return false;

    if (this.data.entries[key]) {
      delete this.data.entries[key];
      await this.save();
      return true;
    }
    return false;
  }

  async list(): Promise<string[]> {
    if (!this.data) return [];
    return Object.keys(this.data.entries);
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    const filePath = join(this.vaultPath, 'vault.enc');
    const tmpPath = filePath + '.tmp';
    // Atomic write: write to tmp, then rename. Prevents corruption if the
    // process crashes mid-write (the old vault file stays intact).
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2));
    try {
      // Tighten permissions on POSIX systems (0600 = owner read/write only).
      if (process.platform !== 'win32') {
        await chmod(tmpPath, 0o600);
      }
    } catch {
      // chmod failures are non-fatal on filesystems that don't support it.
    }
    await rename(tmpPath, filePath);
  }
}
