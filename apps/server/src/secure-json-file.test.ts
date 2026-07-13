import { constants } from 'node:fs';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_SECURE_JSON_BYTES,
  SecureJsonFileError,
  createSecureJsonFile,
  type SecureJsonFileHandle,
  type SecureJsonFileSystem,
} from './secure-json-file.js';

const TARGET = '/data/settings.json';
const UID = 1000;

describe('SecureJsonFile read', () => {
  it.each([0, 1.5, MAX_SECURE_JSON_BYTES + 1])(
    'rejects invalid maximumBytes %s before filesystem access',
    async (maximumBytes) => {
      const fs = new MemoryFileSystem();

      await expect(
        makeFile(fs).read(TARGET, maximumBytes),
      ).rejects.toBeInstanceOf(SecureJsonFileError);

      expect(fs.operations).toEqual([]);
    },
  );

  it('accepts a valid JSON document exactly at the fixed maximum', async () => {
    const value = 'a'.repeat(MAX_SECURE_JSON_BYTES - 2);
    const fs = new MemoryFileSystem({ [TARGET]: jsonEntry(value) });

    await expect(
      makeFile(fs).read(TARGET, MAX_SECURE_JSON_BYTES),
    ).resolves.toBe(value);

    expect(fs.maximumReadBufferLength).toBe(MAX_SECURE_JSON_BYTES + 1);
  });

  it('returns undefined only for a missing target and closes the parent', async () => {
    const fs = new MemoryFileSystem();
    const file = makeFile(fs);

    await expect(file.read(TARGET, 1024)).resolves.toBeUndefined();

    expect(fs.operations).toContain('close parent');
  });

  it('reads strict JSON through no-follow handles and returns a deep-frozen copy', async () => {
    const fs = new MemoryFileSystem({
      [TARGET]: jsonEntry({ nested: { enabled: true }, values: [1, 2] }),
    });

    const result = await makeFile(fs).read(TARGET, 1024);

    expect(result).toEqual({ nested: { enabled: true }, values: [1, 2] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen((result as { nested: unknown }).nested)).toBe(true);
    expect(fs.targetOpenFlags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
    expect(fs.operations).toContain('close target');
  });

  it.each([
    ['relative path', 'data/settings.json', new MemoryFileSystem()],
    [
      'missing parent',
      TARGET,
      new MemoryFileSystem({}, { parentMissing: true }),
    ],
    [
      'symlink parent',
      TARGET,
      new MemoryFileSystem({}, { parentSymlink: true }),
    ],
    [
      'wrong-owner parent',
      TARGET,
      new MemoryFileSystem({}, { parentUid: UID + 1 }),
    ],
    [
      'writable parent',
      TARGET,
      new MemoryFileSystem({}, { parentMode: 0o720 }),
    ],
    [
      'symlink target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: symlinkEntry() }),
    ],
    [
      'directory target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: directoryEntry() }),
    ],
    [
      'wrong-owner target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: jsonEntry({}, UID + 1) }),
    ],
    [
      'unsafe-mode target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: jsonEntry({}, UID, 0o640) }),
    ],
    [
      'special-mode target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: jsonEntry({}, UID, 0o4600) }),
    ],
  ])('rejects %s with one bounded error', async (_name, path, fs) => {
    const error = await makeFile(fs)
      .read(path, 1024)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SecureJsonFileError);
    expect((error as Error).message).toBe('Secure JSON file operation failed');
    expect((error as Error).message).not.toContain('/data');
    expect(fs.allOpenedHandlesClosed()).toBe(true);
  });

  it.each([
    ['malformed JSON', Buffer.from('{bad')],
    ['fatal UTF-8', Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])],
    ['oversized', Buffer.from(' '.repeat(1025))],
  ])('rejects %s without exposing content', async (_name, content) => {
    const fs = new MemoryFileSystem({ [TARGET]: fileEntry(content) });

    const error = await makeFile(fs)
      .read(TARGET, 1024)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SecureJsonFileError);
    expect((error as Error).message).not.toContain('{bad');
    expect(fs.bytesRead).toBeLessThanOrEqual(1025);
    expect(fs.allOpenedHandlesClosed()).toBe(true);
  });

  it('bounds allocation when the target grows after stat', async () => {
    const fs = new MemoryFileSystem(
      { [TARGET]: fileEntry(Buffer.from('x'.repeat(10_000))) },
      { targetStatSize: 2 },
    );

    await expect(makeFile(fs).read(TARGET, 64)).rejects.toBeInstanceOf(
      SecureJsonFileError,
    );

    expect(fs.bytesRead).toBeLessThanOrEqual(65);
    expect(fs.allOpenedHandlesClosed()).toBe(true);
  });

  it('never allocates beyond the fixed cap when the target grows after stat', async () => {
    const fs = new MemoryFileSystem(
      {
        [TARGET]: fileEntry(Buffer.alloc(MAX_SECURE_JSON_BYTES + 2, 'x')),
      },
      { targetStatSize: 2 },
    );

    await expect(
      makeFile(fs).read(TARGET, MAX_SECURE_JSON_BYTES),
    ).rejects.toBeInstanceOf(SecureJsonFileError);

    expect(fs.maximumReadBufferLength).toBe(MAX_SECURE_JSON_BYTES + 1);
    expect(fs.bytesRead).toBe(MAX_SECURE_JSON_BYTES + 1);
  });

  it.each(['read', 'target-close', 'parent-close'] as const)(
    'rejects generic errors and closes every possible descriptor after %s failure',
    async (stage) => {
      const fs = new MemoryFileSystem({ [TARGET]: jsonEntry({ safe: true }) });
      fs.failNext = stage;

      const error = await makeFile(fs)
        .read(TARGET, 1024)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SecureJsonFileError);
      expect((error as Error).message).not.toContain(stage);
      expect(fs.wasCloseAttemptedForEveryHandle()).toBe(true);
    },
  );
});

describe('SecureJsonFile replace', () => {
  it('writes a serialized multibyte JSON value exactly at the fixed maximum', async () => {
    const value = 'é'.repeat((MAX_SECURE_JSON_BYTES - 2) / 2);
    const fs = new MemoryFileSystem();

    await expect(makeFile(fs).replace(TARGET, value, 0o600)).resolves.toEqual({
      state: 'committed',
    });

    expect(fs.entry(TARGET)?.content.byteLength).toBe(MAX_SECURE_JSON_BYTES);
    expect(fs.readJson(TARGET)).toBe(value);
  });

  it('rejects a serialized multibyte JSON value one byte over the fixed maximum before filesystem access', async () => {
    const value = `${'é'.repeat((MAX_SECURE_JSON_BYTES - 2) / 2)}a`;
    const fs = new MemoryFileSystem();

    await expect(
      makeFile(fs).replace(TARGET, value, 0o600),
    ).rejects.toBeInstanceOf(SecureJsonFileError);

    expect(new TextEncoder().encode(JSON.stringify(value))).toHaveLength(
      MAX_SECURE_JSON_BYTES + 1,
    );
    expect(fs.operations).toEqual([]);
  });

  it.each([
    ['undefined', undefined],
    ['nonfinite', { value: Number.POSITIVE_INFINITY }],
    ['nested undefined', { value: undefined }],
    ['function', { value: () => undefined }],
    ['bigint', { value: 1n }],
    ['nonplain', new Date('2026-07-12T00:00:00.000Z')],
  ])('rejects non-JSON %s before filesystem access', async (_name, value) => {
    const fs = new MemoryFileSystem();

    await expect(
      makeFile(fs).replace(TARGET, value, 0o600),
    ).rejects.toBeInstanceOf(SecureJsonFileError);

    expect(fs.operations).toEqual([]);
  });

  it('rejects circular JSON before filesystem access without exposing values', async () => {
    const circular: Record<string, unknown> = { secretValue: 'do-not-leak' };
    circular.self = circular;
    const fs = new MemoryFileSystem();

    const error = await makeFile(fs)
      .replace(TARGET, circular, 0o600)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SecureJsonFileError);
    expect((error as Error).message).not.toContain('do-not-leak');
    expect(fs.operations).toEqual([]);
  });

  it.each([
    ['relative path', 'data/settings.json', new MemoryFileSystem()],
    ['unsafe parent', TARGET, new MemoryFileSystem({}, { parentMode: 0o777 })],
    [
      'symlink target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: symlinkEntry() }),
    ],
    [
      'nonregular target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: directoryEntry() }),
    ],
    [
      'wrong owner target',
      TARGET,
      new MemoryFileSystem({ [TARGET]: jsonEntry({}, UID + 1) }),
    ],
    [
      'unsafe target mode',
      TARGET,
      new MemoryFileSystem({ [TARGET]: jsonEntry({}, UID, 0o644) }),
    ],
    [
      'special target mode',
      TARGET,
      new MemoryFileSystem({ [TARGET]: jsonEntry({}, UID, 0o4600) }),
    ],
  ])('rejects %s before opening a temp', async (_name, path, fs) => {
    await expect(
      makeFile(fs).replace(path, { next: true }, 0o600),
    ).rejects.toBeInstanceOf(SecureJsonFileError);

    expect(
      fs.operations.some((operation) => operation.startsWith('open temp')),
    ).toBe(false);
    expect(fs.wasCloseAttemptedForEveryHandle()).toBe(true);
  });

  it('writes all short chunks to a unique mode-0600 same-directory temp and commits', async () => {
    const fs = new MemoryFileSystem({ [TARGET]: jsonEntry({ prior: true }) });
    fs.maximumWrite = 3;

    const result = await makeFile(fs).replace(TARGET, { next: true }, 0o600);

    expect(result).toEqual({ state: 'committed' });
    expect(fs.readJson(TARGET)).toEqual({ next: true });
    expect(fs.tempOpenFlags).toBe(
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
    );
    expect(fs.tempOpenMode).toBe(0o600);
    expect(fs.renamePair?.to).toBe(TARGET);
    expect(posix.dirname(fs.renamePair!.from)).toBe('/data');
    expect(fs.operations).toEqual([
      'open parent',
      'stat parent',
      'open target',
      'stat target',
      'close target',
      'open temp',
      'write temp',
      'write temp',
      'write temp',
      'write temp',
      'write temp',
      'sync temp',
      'close temp',
      'open target',
      'stat target',
      'close target',
      'rename temp',
      'sync parent',
      'close parent',
    ]);
    expect(fs.allOpenedHandlesClosed()).toBe(true);
  });

  it('retries temp name collisions without unlinking files it does not own', async () => {
    const fs = new MemoryFileSystem();
    fs.collisionsRemaining = 1;

    await expect(
      makeFile(fs).replace(TARGET, { next: true }, 0o600),
    ).resolves.toEqual({
      state: 'committed',
    });

    expect(fs.collisionPath).toBeDefined();
    expect(fs.entry(fs.collisionPath!)).toEqual(
      fileEntry(Buffer.from('owned')),
    );
    expect(fs.operations).not.toContain(`unlink ${fs.collisionPath}`);
  });

  it('returns not_committed after collision exhaustion', async () => {
    const fs = new MemoryFileSystem();
    fs.collisionsRemaining = 20;

    await expect(
      makeFile(fs).replace(TARGET, { next: true }, 0o600),
    ).resolves.toEqual({
      state: 'not_committed',
    });

    expect(fs.entry(TARGET)).toBeUndefined();
    expect(fs.wasCloseAttemptedForEveryHandle()).toBe(true);
  });

  it.each(['write', 'file-sync', 'temp-close', 'rename'] as const)(
    'returns not_committed and cleans its temp after transactional %s failure',
    async (stage) => {
      const fs = new MemoryFileSystem({ [TARGET]: jsonEntry({ prior: true }) });
      fs.failNext = stage;

      await expect(
        makeFile(fs).replace(TARGET, { secret: 'never-log-this' }, 0o600),
      ).resolves.toEqual({ state: 'not_committed' });

      expect(fs.readJson(TARGET)).toEqual({ prior: true });
      expect(fs.ownedTemps()).toEqual([]);
      expect(fs.wasCloseAttemptedForEveryHandle()).toBe(true);
    },
  );

  it.each(['target-open', 'target-stat', 'target-close'] as const)(
    'returns not_committed when the pre-rename target recheck has an operational %s failure',
    async (stage) => {
      const fs = new MemoryFileSystem({ [TARGET]: jsonEntry({ prior: true }) });
      fs.recheckFailure = stage;

      await expect(
        makeFile(fs).replace(TARGET, { next: true }, 0o600),
      ).resolves.toEqual({ state: 'not_committed' });

      expect(fs.readJson(TARGET)).toEqual({ prior: true });
      expect(fs.ownedTemps()).toEqual([]);
      expect(fs.wasCloseAttemptedForEveryHandle()).toBe(true);
    },
  );

  it('treats a zero-byte short write as not_committed', async () => {
    const fs = new MemoryFileSystem();
    fs.maximumWrite = 0;

    await expect(
      makeFile(fs).replace(TARGET, { next: true }, 0o600),
    ).resolves.toEqual({
      state: 'not_committed',
    });
    expect(fs.ownedTemps()).toEqual([]);
  });

  it.each(['dir-sync', 'parent-close'] as const)(
    'keeps committed authority but reports durability uncertainty after %s failure',
    async (stage) => {
      const fs = new MemoryFileSystem({ [TARGET]: jsonEntry({ prior: true }) });
      fs.failNext = stage;

      await expect(
        makeFile(fs).replace(TARGET, { next: true }, 0o600),
      ).resolves.toEqual({
        state: 'committed_durability_uncertain',
      });

      expect(fs.readJson(TARGET)).toEqual({ next: true });
      expect(fs.wasCloseAttemptedForEveryHandle()).toBe(true);
    },
  );

  it('refuses a symlink introduced before rename instead of replacing it', async () => {
    const fs = new MemoryFileSystem();
    fs.replaceTargetWithSymlinkBeforeRecheck = true;

    await expect(
      makeFile(fs).replace(TARGET, { next: true }, 0o600),
    ).rejects.toBeInstanceOf(SecureJsonFileError);

    expect(fs.entry(TARGET)?.kind).toBe('symlink');
    expect(fs.ownedTemps()).toEqual([]);
  });
});

describe('SecureJsonFile syncParent', () => {
  it('returns true only after validated directory sync and close', async () => {
    const fs = new MemoryFileSystem();

    await expect(makeFile(fs).syncParent(TARGET)).resolves.toBe(true);

    expect(fs.operations).toEqual([
      'open parent',
      'stat parent',
      'sync parent',
      'close parent',
    ]);
  });

  it.each(['parent-open', 'parent-stat', 'dir-sync', 'parent-close'] as const)(
    'returns false without throwing after %s failure and permits retry',
    async (stage) => {
      const fs = new MemoryFileSystem();
      fs.failNext = stage;
      const file = makeFile(fs);

      await expect(file.syncParent(TARGET)).resolves.toBe(false);
      await expect(file.syncParent(TARGET)).resolves.toBe(true);
      expect(fs.wasCloseAttemptedForEveryHandle()).toBe(true);
    },
  );
});

function makeFile(fileSystem: MemoryFileSystem) {
  let nonce = 0;
  return createSecureJsonFile({
    fileSystem,
    runtimeUid: UID,
    randomName: () => `nonce-${nonce++}`,
  });
}

type Entry = {
  kind: 'file' | 'directory' | 'symlink';
  content: Buffer;
  uid: number;
  mode: number;
};

function fileEntry(content: Uint8Array, uid = UID, mode = 0o600): Entry {
  return { kind: 'file', content: Buffer.from(content), uid, mode };
}

function jsonEntry(value: unknown, uid = UID, mode = 0o600): Entry {
  return fileEntry(Buffer.from(JSON.stringify(value)), uid, mode);
}

function directoryEntry(uid = UID, mode = 0o700): Entry {
  return { kind: 'directory', content: Buffer.alloc(0), uid, mode };
}

function symlinkEntry(): Entry {
  return {
    kind: 'symlink',
    content: Buffer.from('/private'),
    uid: UID,
    mode: 0o777,
  };
}

type FailureStage =
  | 'parent-open'
  | 'parent-stat'
  | 'parent-close'
  | 'target-open'
  | 'target-stat'
  | 'target-close'
  | 'read'
  | 'write'
  | 'file-sync'
  | 'temp-close'
  | 'rename'
  | 'dir-sync';

class MemoryFileSystem implements SecureJsonFileSystem {
  readonly operations: string[] = [];
  failNext: FailureStage | undefined;
  maximumWrite = Number.POSITIVE_INFINITY;
  collisionsRemaining = 0;
  collisionPath: string | undefined;
  replaceTargetWithSymlinkBeforeRecheck = false;
  recheckFailure: 'target-open' | 'target-stat' | 'target-close' | undefined;
  bytesRead = 0;
  maximumReadBufferLength = 0;
  targetOpenFlags: number | undefined;
  tempOpenFlags: number | undefined;
  tempOpenMode: number | undefined;
  renamePair: { from: string; to: string } | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly handles: MemoryHandle[] = [];
  private targetOpenCount = 0;

  constructor(
    initial: Record<string, Entry> = {},
    options: {
      parentMissing?: boolean;
      parentSymlink?: boolean;
      parentUid?: number;
      parentMode?: number;
      targetStatSize?: number;
    } = {},
  ) {
    if (!options.parentMissing) {
      this.entries.set(
        '/data',
        options.parentSymlink
          ? symlinkEntry()
          : directoryEntry(
              options.parentUid ?? UID,
              options.parentMode ?? 0o700,
            ),
      );
    }
    for (const [path, entry] of Object.entries(initial)) {
      this.entries.set(path, cloneEntry(entry));
    }
    this.targetStatSize = options.targetStatSize;
  }

  private readonly targetStatSize: number | undefined;

  entry(path: string): Entry | undefined {
    const entry = this.entries.get(path);
    return entry ? cloneEntry(entry) : undefined;
  }

  readJson(path: string): unknown {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    return JSON.parse(entry.content.toString());
  }

  ownedTemps(): string[] {
    return [...this.entries.keys()].filter((path) =>
      path.includes('.secure-json-'),
    );
  }

  allOpenedHandlesClosed(): boolean {
    return this.handles.every((handle) => handle.closed);
  }

  wasCloseAttemptedForEveryHandle(): boolean {
    return this.handles.every((handle) => handle.closeAttempted);
  }

  async open(
    path: string,
    flags: number,
    mode?: number,
  ): Promise<SecureJsonFileHandle> {
    const role =
      path === '/data' ? 'parent' : path === TARGET ? 'target' : 'temp';
    this.operations.push(`open ${role}`);
    if (this.consumeFailure(`${role}-open` as FailureStage))
      throw rawError(role);

    const noFollow = (flags & constants.O_NOFOLLOW) !== 0;
    const entry = this.entries.get(path);
    if (entry?.kind === 'symlink' && noFollow) throw errno('ELOOP');

    if (role === 'target') {
      this.targetOpenFlags = flags;
      this.targetOpenCount += 1;
      if (
        this.replaceTargetWithSymlinkBeforeRecheck &&
        this.targetOpenCount === 1 &&
        !entry
      ) {
        this.entries.set(TARGET, symlinkEntry());
        throw errno('ENOENT');
      }
    }

    if (role === 'temp') {
      this.tempOpenFlags = flags;
      this.tempOpenMode = mode;
      if (this.collisionsRemaining > 0) {
        this.collisionsRemaining -= 1;
        this.collisionPath = path;
        this.entries.set(path, fileEntry(Buffer.from('owned')));
        throw errno('EEXIST');
      }
      if (entry) throw errno('EEXIST');
      this.entries.set(path, fileEntry(Buffer.alloc(0), UID, mode));
    } else if (!entry) {
      throw errno('ENOENT');
    }

    const handle = new MemoryHandle(this, path, role, this.targetStatSize);
    this.handles.push(handle);
    return handle;
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push('rename temp');
    if (this.consumeFailure('rename')) throw rawError('rename');
    const entry = this.entries.get(from);
    if (!entry) throw errno('ENOENT');
    this.renamePair = { from, to };
    this.entries.set(to, entry);
    this.entries.delete(from);
  }

  async unlink(path: string): Promise<void> {
    this.operations.push(`unlink ${path}`);
    this.entries.delete(path);
  }

  consumeFailure(stage: FailureStage): boolean {
    if (this.failNext !== stage) return false;
    this.failNext = undefined;
    return true;
  }

  getMutableEntry(path: string): Entry {
    const entry = this.entries.get(path);
    if (!entry) throw errno('ENOENT');
    return entry;
  }
}

class MemoryHandle implements SecureJsonFileHandle {
  closed = false;
  closeAttempted = false;
  private cursor = 0;

  constructor(
    private readonly fs: MemoryFileSystem,
    private readonly path: string,
    private readonly role: 'parent' | 'target' | 'temp',
    private readonly targetStatSize: number | undefined,
  ) {}

  async stat() {
    this.fs.operations.push(`stat ${this.role}`);
    if (this.fs.consumeFailure(`${this.role}-stat` as FailureStage)) {
      throw rawError(`${this.role}-stat`);
    }
    const entry = this.fs.getMutableEntry(this.path);
    return {
      uid: entry.uid,
      mode: entry.mode,
      size:
        this.role === 'target' && this.targetStatSize !== undefined
          ? this.targetStatSize
          : entry.content.byteLength,
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'directory',
    };
  }

  async read(buffer: Uint8Array, offset: number, length: number) {
    this.fs.operations.push(`read ${this.role}`);
    this.fs.maximumReadBufferLength = Math.max(
      this.fs.maximumReadBufferLength,
      buffer.byteLength,
    );
    if (this.fs.consumeFailure('read')) throw rawError('read');
    const entry = this.fs.getMutableEntry(this.path);
    const bytesRead = Math.min(length, entry.content.byteLength - this.cursor);
    buffer.set(
      entry.content.subarray(this.cursor, this.cursor + bytesRead),
      offset,
    );
    this.cursor += bytesRead;
    this.fs.bytesRead += bytesRead;
    return { bytesRead };
  }

  async write(buffer: Uint8Array, offset: number, length: number) {
    this.fs.operations.push('write temp');
    if (this.fs.consumeFailure('write')) throw rawError('write');
    const bytesWritten = Math.min(length, this.fs.maximumWrite);
    const entry = this.fs.getMutableEntry(this.path);
    entry.content = Buffer.concat([
      entry.content,
      Buffer.from(buffer.subarray(offset, offset + bytesWritten)),
    ]);
    return { bytesWritten };
  }

  async sync(): Promise<void> {
    this.fs.operations.push(`sync ${this.role}`);
    if (
      this.fs.consumeFailure(this.role === 'parent' ? 'dir-sync' : 'file-sync')
    ) {
      throw rawError(`${this.role}-sync`);
    }
  }

  async close(): Promise<void> {
    this.closeAttempted = true;
    this.fs.operations.push(`close ${this.role}`);
    const stage = `${this.role}-close` as FailureStage;
    if (this.fs.consumeFailure(stage)) throw rawError(stage);
    this.closed = true;
    if (this.role === 'temp' && this.fs.recheckFailure) {
      this.fs.failNext = this.fs.recheckFailure;
      this.fs.recheckFailure = undefined;
    }
  }
}

function cloneEntry(entry: Entry): Entry {
  return { ...entry, content: Buffer.from(entry.content) };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function rawError(value: string): Error {
  return new Error(`raw ${value} /data secret-json-value`);
}
