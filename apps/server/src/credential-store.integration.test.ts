import bcrypt from 'bcrypt';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSecureJsonFile } from './secure-json-file.js';
import { CredentialStore } from './credential-store.js';

describe.sequential('CredentialStore real filesystem', () => {
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'flanterminal-credentials-'));
    await chmod(dataDir, 0o700);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('enrolls once, persists no plaintext, and verifies after restart', async () => {
    const first = new CredentialStore({
      dataDir,
      secureFile: createSecureJsonFile(),
    });
    await first.initializeLocal('admin', 10);
    expect(first.isInitialized()).toBe(false);

    await expect(first.enroll('integration-password')).resolves.toEqual({
      outcome: 'enrolled',
      persistence: 'committed',
    });
    expect(first.isInitialized()).toBe(true);
    await expect(first.verify('admin', 'integration-password')).resolves.toBe(
      true,
    );

    const authPath = join(dataDir, 'auth.json');
    const persisted = await readFile(authPath, 'utf8');
    expect(persisted).not.toContain('integration-password');
    expect(persisted).toContain('$2b$10$');
    expect((await stat(authPath)).mode & 0o7777).toBe(0o600);

    const restarted = new CredentialStore({
      dataDir,
      secureFile: createSecureJsonFile(),
    });
    await restarted.initializeLocal('admin', 10);
    expect(restarted.isInitialized()).toBe(true);
    await expect(
      restarted.verify('admin', 'integration-password'),
    ).resolves.toBe(true);
    await expect(
      restarted.verify('other', 'integration-password'),
    ).resolves.toBe(false);
    await expect(restarted.enroll('overwrite-password')).resolves.toEqual({
      outcome: 'already_initialized',
    });

    await expect(
      restarted.replacePassword('replacement-password'),
    ).resolves.toEqual({ state: 'committed' });
    const replaced = await readFile(authPath, 'utf8');
    expect(replaced).not.toContain('integration-password');
    expect(replaced).not.toContain('replacement-password');
    expect((await stat(authPath)).mode & 0o7777).toBe(0o600);

    const replacedRestart = new CredentialStore({
      dataDir,
      secureFile: createSecureJsonFile(),
    });
    await replacedRestart.initializeLocal('admin', 10);
    await expect(
      replacedRestart.verify('admin', 'integration-password'),
    ).resolves.toBe(false);
    await expect(
      replacedRestart.verify('admin', 'replacement-password'),
    ).resolves.toBe(true);
  });

  it('loads a compatible existing bcrypt credential record', async () => {
    const authPath = join(dataDir, 'auth.json');
    const passwordHash = await bcrypt.hash('existing-password', 10);
    await writeFile(
      authPath,
      JSON.stringify({
        version: 1,
        username: 'admin',
        passwordHash,
        passwordChangedAt: '2026-07-12T00:00:00.000Z',
      }),
      { mode: 0o600 },
    );

    const store = new CredentialStore({
      dataDir,
      secureFile: createSecureJsonFile(),
    });
    await store.initializeLocal('admin', 10);

    expect(store.isInitialized()).toBe(true);
    await expect(store.verify('admin', 'existing-password')).resolves.toBe(
      true,
    );
    await expect(store.enroll('replacement-password')).resolves.toEqual({
      outcome: 'already_initialized',
    });
    expect(await readFile(authPath, 'utf8')).toContain(passwordHash);
  });
});
