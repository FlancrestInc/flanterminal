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
  let secretPath = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'flanterminal-credentials-'));
    await chmod(dataDir, 0o700);
    secretPath = join(dataDir, 'bootstrap-password');
    await writeFile(secretPath, 'integration-password\n', { mode: 0o400 });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists only a mode-0600 bcrypt record and verifies after restart without the secret', async () => {
    const first = new CredentialStore({
      dataDir,
      secureFile: createSecureJsonFile(),
    });
    await first.initializeLocal('admin', secretPath, 10);
    await expect(first.verify('admin', 'integration-password')).resolves.toBe(
      true,
    );

    const authPath = join(dataDir, 'auth.json');
    const persisted = await readFile(authPath, 'utf8');
    expect(persisted).not.toContain('integration-password');
    expect(persisted).toContain('$2b$10$');
    expect((await stat(authPath)).mode & 0o7777).toBe(0o600);

    await rm(secretPath);
    const restarted = new CredentialStore({
      dataDir,
      secureFile: createSecureJsonFile(),
    });
    await restarted.initializeLocal('admin', secretPath, 10);
    await expect(
      restarted.verify('admin', 'integration-password'),
    ).resolves.toBe(true);
    await expect(
      restarted.verify('other', 'integration-password'),
    ).resolves.toBe(false);
  });
});
