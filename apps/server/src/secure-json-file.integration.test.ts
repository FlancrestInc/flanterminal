import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SecureJsonFileError,
  createSecureJsonFile,
} from './secure-json-file.js';

describe.sequential('SecureJsonFile real filesystem', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flanterminal-secure-json-'));
    await chmod(root, 0o700);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits exact mode 0600 under a restrictive umask and roundtrips JSON', async () => {
    const target = join(root, 'settings.json');
    const file = createSecureJsonFile();
    const priorUmask = process.umask(0o777);
    try {
      await expect(
        file.replace(target, { nested: { enabled: true } }, 0o600),
      ).resolves.toEqual({ state: 'committed' });
    } finally {
      process.umask(priorUmask);
    }

    const targetStat = await lstat(target);
    expect(targetStat.isFile()).toBe(true);
    expect(targetStat.mode & 0o7777).toBe(0o600);
    await expect(file.read(target, 1024)).resolves.toEqual({
      nested: { enabled: true },
    });
    expect(await readdir(root)).toEqual(['settings.json']);
  });

  it('refuses a no-follow target symlink without leaving a temp', async () => {
    const target = join(root, 'settings.json');
    await symlink(join(root, 'elsewhere.json'), target);

    await expect(
      createSecureJsonFile().replace(target, { next: true }, 0o600),
    ).rejects.toBeInstanceOf(SecureJsonFileError);

    const targetStat = await lstat(target);
    expect(targetStat.isSymbolicLink()).toBe(true);
    expect(await readdir(root)).toEqual(['settings.json']);
  });

  it('refuses a no-follow parent symlink without opening a target', async () => {
    const realParent = join(root, 'real');
    const linkedParent = join(root, 'linked');
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, linkedParent);

    await expect(
      createSecureJsonFile().replace(
        join(linkedParent, 'settings.json'),
        { next: true },
        0o600,
      ),
    ).rejects.toBeInstanceOf(SecureJsonFileError);

    expect(await readdir(realParent)).toEqual([]);
  });
});
