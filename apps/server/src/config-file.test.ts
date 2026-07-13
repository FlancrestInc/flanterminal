import { constants } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  loadOptionalConfigFile,
  type ConfigFileSystem,
} from './config-file.js';

describe('loadOptionalConfigFile', () => {
  it('returns an empty frozen object without touching the filesystem when unset', async () => {
    const fileSystem = fakeFileSystem('{}');

    const result = await loadOptionalConfigFile(undefined, fileSystem);

    expect(result).toEqual({});
    expect(Object.isFrozen(result)).toBe(true);
    expect(fileSystem.open).not.toHaveBeenCalled();
  });

  it('opens an absolute regular file without following symlinks and parses strict values', async () => {
    const fileSystem = fakeFileSystem(
      JSON.stringify({
        authMode: 'none',
        port: 4000,
        allowedShells: ['/bin/bash', '/bin/zsh'],
      }),
    );

    const result = await loadOptionalConfigFile(
      '/etc/flanterminal.json',
      fileSystem,
    );

    expect(result).toEqual({
      authMode: 'none',
      port: 4000,
      allowedShells: ['/bin/bash', '/bin/zsh'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.allowedShells)).toBe(true);
    expect(fileSystem.open).toHaveBeenCalledWith(
      '/etc/flanterminal.json',
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  });

  it.each([
    ['relative path', 'etc/flanterminal.json', fakeFileSystem('{}')],
    [
      'symlink',
      '/etc/flanterminal.json',
      fakeFileSystem('{}', { symlink: true }),
    ],
    [
      'non-regular file',
      '/etc/flanterminal.json',
      fakeFileSystem('{}', { regular: false }),
    ],
    [
      'oversized file',
      '/etc/flanterminal.json',
      fakeFileSystem('x'.repeat(65_537)),
    ],
    ['malformed JSON', '/etc/flanterminal.json', fakeFileSystem('{bad')],
    ['array JSON', '/etc/flanterminal.json', fakeFileSystem('[]')],
    ['scalar JSON', '/etc/flanterminal.json', fakeFileSystem('true')],
    [
      'unknown key',
      '/etc/flanterminal.json',
      fakeFileSystem('{"unknown":true}'),
    ],
    [
      'env-only config path',
      '/etc/flanterminal.json',
      fakeFileSystem('{"appConfigFile":"/tmp/x"}'),
    ],
    [
      'env-only password file',
      '/etc/flanterminal.json',
      fakeFileSystem('{"localAuthPasswordFile":"/tmp/x"}'),
    ],
    [
      'secret-like key',
      '/etc/flanterminal.json',
      fakeFileSystem('{"apiToken":"value"}'),
    ],
    [
      'private-key-like key',
      '/etc/flanterminal.json',
      fakeFileSystem('{"privateKeyPath":"value"}'),
    ],
  ])('rejects %s with one bounded error', async (_name, path, fileSystem) => {
    const error = await loadOptionalConfigFile(path, fileSystem).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Invalid server configuration');
    expect((error as Error).message).not.toContain(path);
    expect((error as Error).message).not.toContain('value');
  });

  it('closes the handle when validation or reading fails', async () => {
    const fileSystem = fakeFileSystem('{bad');

    await expect(
      loadOptionalConfigFile('/etc/flanterminal.json', fileSystem),
    ).rejects.toThrow('Invalid server configuration');

    expect(fileSystem.handle.close).toHaveBeenCalledOnce();
  });
});

function fakeFileSystem(
  content: string,
  options: { regular?: boolean; symlink?: boolean } = {},
) {
  const bytes = Buffer.from(content);
  const handle = {
    stat: vi.fn(async () => ({
      size: bytes.byteLength,
      isFile: () => options.regular ?? true,
    })),
    readFile: vi.fn(async () => bytes),
    close: vi.fn(async () => undefined),
  };
  const open = vi.fn(async () => {
    if (options.symlink) {
      throw Object.assign(new Error('symlink target'), { code: 'ELOOP' });
    }
    return handle;
  });
  return { open, handle } satisfies ConfigFileSystem & {
    handle: typeof handle;
  };
}
