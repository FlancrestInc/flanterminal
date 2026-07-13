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

  it('bounds reads when a file grows after stat', async () => {
    const fileSystem = fakeFileSystem('x'.repeat(100_000), { statSize: 2 });

    await expect(
      loadOptionalConfigFile('/etc/flanterminal.json', fileSystem),
    ).rejects.toThrow('Invalid server configuration');

    expect(fileSystem.bytesReturned()).toBeLessThanOrEqual(65_537);
  });

  it('rejects malformed UTF-8 instead of decoding replacement characters', async () => {
    const prefix = Buffer.from('{"authMode":"none');
    const suffix = Buffer.from('"}');
    const malformed = Buffer.concat([
      prefix,
      Buffer.from([0xc3, 0x28]),
      suffix,
    ]);

    await expect(
      loadOptionalConfigFile(
        '/etc/flanterminal.json',
        fakeFileSystem(malformed),
      ),
    ).rejects.toThrow('Invalid server configuration');
  });
});

function fakeFileSystem(
  content: string | Uint8Array,
  options: { regular?: boolean; symlink?: boolean; statSize?: number } = {},
) {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  let cursor = 0;
  let returned = 0;
  const handle = {
    stat: vi.fn(async () => ({
      size: options.statSize ?? bytes.byteLength,
      isFile: () => options.regular ?? true,
    })),
    read: vi.fn(async (buffer: Uint8Array, offset: number, length: number) => {
      const bytesRead = Math.min(length, bytes.byteLength - cursor);
      buffer.set(bytes.subarray(cursor, cursor + bytesRead), offset);
      cursor += bytesRead;
      returned += bytesRead;
      return { bytesRead };
    }),
    close: vi.fn(async () => undefined),
  };
  const open = vi.fn(async () => {
    if (options.symlink) {
      throw Object.assign(new Error('symlink target'), { code: 'ELOOP' });
    }
    return handle;
  });
  return {
    open,
    handle,
    bytesReturned: () => returned,
  } satisfies ConfigFileSystem & {
    handle: typeof handle;
    bytesReturned(): number;
  };
}
