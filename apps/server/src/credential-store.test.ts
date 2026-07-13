import { constants } from 'node:fs';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { type ReplaceResult, type SecureJsonFile } from './secure-json-file.js';
import {
  CredentialStore,
  CredentialStoreError,
  type BootstrapSecretFileSystem,
  type BootstrapSecretHandle,
  type PasswordHasher,
} from './credential-store.js';

const DATA_DIR = '/data';
const AUTH_PATH = '/data/auth.json';
const SECRET_PATH = '/run/secrets/password';
const UID = 1000;
const NOW = new Date('2026-07-12T12:34:56.000Z');
const HASH = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
const NEXT_HASH = `${HASH.slice(0, -1)}5`;
const THIRD_HASH = `${HASH.slice(0, -1)}6`;

describe('CredentialStore bootstrap', () => {
  it('bootstraps a root-owned read-only Compose secret and commits strict credentials', async () => {
    const { store, secureFile, hasher, bootstrap } = harness();
    bootstrap.content = Buffer.from('correct horse battery\n');
    bootstrap.uid = 0;
    bootstrap.mode = 0o444;
    secureFile.readResults.push(undefined);
    secureFile.replaceResults.push({ state: 'committed' });
    hasher.hashResults.push(HASH);

    await store.initializeLocal('admin', SECRET_PATH, 12);

    expect(bootstrap.openFlags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
    expect(bootstrap.operations).toEqual([
      'open',
      'stat',
      'read',
      'read',
      'close',
    ]);
    expect(hasher.hashCalls).toEqual([
      { password: 'correct horse battery', cost: 12 },
    ]);
    expect(secureFile.replacedValues).toEqual([
      {
        version: 1,
        username: 'admin',
        passwordHash: HASH,
        passwordChangedAt: NOW.toISOString(),
      },
    ]);
    expect(secureFile.calls).toEqual([
      `read ${AUTH_PATH} 1048576`,
      `replace ${AUTH_PATH} 384`,
    ]);
  });

  it.each([
    ['runtime owner', UID, 0o400],
    ['root Compose secret', 0, 0o444],
  ])('accepts a %s secret', async (_name, uid, mode) => {
    const { store, secureFile, hasher, bootstrap } = harness();
    bootstrap.uid = uid;
    bootstrap.mode = mode;
    secureFile.readResults.push(undefined);
    secureFile.replaceResults.push({ state: 'committed' });
    hasher.hashResults.push(HASH);
    await expect(
      store.initializeLocal('admin', SECRET_PATH, 12),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['symlink', { openError: errno('ELOOP') }],
    ['nonregular', { kind: 'directory' as const }],
    ['writable', { mode: 0o446 }],
    ['wrong owner', { uid: UID + 1 }],
    ['oversized stat', { statSize: 4097 }],
    ['grows after stat', { statSize: 12, content: Buffer.alloc(4097, 0x61) }],
    [
      'fatal UTF-8',
      {
        content: Buffer.from([
          0xc3, 0x28, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61,
          0x61,
        ]),
      },
    ],
    ['close failure', { failStage: 'close' as const }],
  ])('rejects a %s bootstrap secret generically', async (_name, changes) => {
    const { store, secureFile, hasher, bootstrap } = harness();
    Object.assign(bootstrap, changes);
    secureFile.readResults.push(undefined);

    const error = await captureError(
      store.initializeLocal('admin', SECRET_PATH, 12),
    );
    expectGeneric(error);
    expect(hasher.hashCalls).toEqual([]);
    expect(secureFile.replacedValues).toEqual([]);
    expect(bootstrap.operations.at(-1)).toBe(
      'openError' in changes ? 'open' : 'close',
    );
  });

  it.each([
    ['LF', 'password-password\n', 'password-password'],
    ['CRLF', 'password-password\r\n', 'password-password'],
    ['one ending only', 'password-pass\n\n', 'password-pass\n'],
  ])('strips %s exactly', async (_name, input, expected) => {
    const { store, secureFile, hasher, bootstrap } = harness();
    bootstrap.content = Buffer.from(input);
    secureFile.readResults.push(undefined);
    secureFile.replaceResults.push({ state: 'committed' });
    hasher.hashResults.push(HASH);
    await store.initializeLocal('admin', SECRET_PATH, 12);
    expect(hasher.hashCalls[0]?.password).toBe(expected);
  });

  it.each([
    ['NUL', `password\0password`],
    ['11 bytes', 'a'.repeat(11)],
    ['73 bytes', 'a'.repeat(73)],
    ['73 multibyte bytes', `${'é'.repeat(36)}a`],
  ])('rejects %s before bcrypt', async (_name, password) => {
    const { store, secureFile, hasher, bootstrap } = harness();
    bootstrap.content = Buffer.from(password);
    secureFile.readResults.push(undefined);
    await expect(
      store.initializeLocal('admin', SECRET_PATH, 12),
    ).rejects.toBeInstanceOf(CredentialStoreError);
    expect(hasher.hashCalls).toEqual([]);
    expect(secureFile.replacedValues).toEqual([]);
  });

  it.each(['a'.repeat(12), 'a'.repeat(72), 'é'.repeat(6)])(
    'accepts a boundary password of %s UTF-8 bytes',
    async (password) => {
      const { store, secureFile, hasher, bootstrap } = harness();
      bootstrap.content = Buffer.from(password);
      secureFile.readResults.push(undefined);
      secureFile.replaceResults.push({ state: 'committed' });
      hasher.hashResults.push(HASH);
      await store.initializeLocal('admin', SECRET_PATH, 12);
      expect(hasher.hashCalls[0]).toEqual({ password, cost: 12 });
    },
  );

  it.each(['not_committed', 'committed_durability_uncertain'] as const)(
    'fails initialization for %s without becoming usable',
    async (state) => {
      const { store, secureFile, hasher } = harness();
      secureFile.readResults.push(undefined);
      secureFile.replaceResults.push({ state });
      hasher.hashResults.push(HASH);
      await expect(
        store.initializeLocal('admin', SECRET_PATH, 12),
      ).rejects.toBeInstanceOf(CredentialStoreError);
      await expect(
        store.verify('admin', 'password-password'),
      ).rejects.toBeInstanceOf(CredentialStoreError);
    },
  );

  it('contains hasher failures and invalid returned hashes before persistence', async () => {
    for (const result of [new Error('password /secret/path'), 'invalid-hash']) {
      const { store, secureFile, hasher } = harness();
      secureFile.readResults.push(undefined);
      hasher.hashResults.push(result);
      expectGeneric(
        await captureError(store.initializeLocal('admin', SECRET_PATH, 12)),
      );
      expect(secureFile.replacedValues).toEqual([]);
    }
  });

  it('rejects invalid configured cost before filesystem access', async () => {
    const { store, secureFile } = harness();
    await expect(
      store.initializeLocal('admin', SECRET_PATH, 9),
    ).rejects.toBeInstanceOf(CredentialStoreError);
    expect(secureFile.calls).toEqual([]);
  });
});

describe('CredentialStore existing records', () => {
  it('loads strict credentials without accessing the bootstrap file', async () => {
    const { store, secureFile, bootstrap } = harness();
    secureFile.readResults.push(record());
    await store.initializeLocal('admin', '/missing/secret', 12);
    expect(bootstrap.operations).toEqual([]);
    expect(secureFile.replacedValues).toEqual([]);
  });

  it.each([
    ['version', { ...record(), version: 2 }],
    ['unknown field', { ...record(), secret: 'value' }],
    ['username mismatch', { ...record(), username: 'other' }],
    ['malformed hash', { ...record(), passwordHash: 'not-bcrypt' }],
    [
      'low hash cost',
      { ...record(), passwordHash: HASH.replace('$12$', '$09$') },
    ],
    ['bad timestamp', { ...record(), passwordChangedAt: 'yesterday' }],
  ])('rejects %s without overwriting', async (_name, value) => {
    const { store, secureFile, bootstrap } = harness();
    secureFile.readResults.push(value);
    const error = await captureError(
      store.initializeLocal('admin', SECRET_PATH, 12),
    );
    expectGeneric(error);
    expect(bootstrap.operations).toEqual([]);
    expect(secureFile.replacedValues).toEqual([]);
  });

  it('preserves an existing file after an unsafe read failure', async () => {
    const { store, secureFile } = harness();
    secureFile.readResults.push(new Error('/secret/auth.json raw errno'));
    const error = await captureError(
      store.initializeLocal('admin', SECRET_PATH, 12),
    );
    expectGeneric(error);
    expect(secureFile.replacedValues).toEqual([]);
  });
});

describe('CredentialStore verification and replacement', () => {
  it('keeps JSON and Node inspection bounded and secret-free', async () => {
    const { store, secureFile } = harness();
    secureFile.readResults.push(record());
    await store.initializeLocal('admin', SECRET_PATH, 12);
    for (const representation of [JSON.stringify(store), inspect(store)]) {
      expect(representation).not.toContain('admin');
      expect(representation).not.toContain(HASH);
      expect(representation).not.toContain('/data');
    }
  });
  it.each([
    ['correct', 'admin', true, true],
    ['wrong username', 'other', true, false],
    ['wrong password', 'admin', false, false],
  ])(
    'performs exactly one compare for %s',
    async (_name, username, match, expected) => {
      const { store, secureFile, hasher } = harness();
      secureFile.readResults.push(record());
      await store.initializeLocal('admin', SECRET_PATH, 12);
      hasher.compareResults.push(match);
      await expect(store.verify(username, 'password-password')).resolves.toBe(
        expected,
      );
      expect(hasher.compareCalls).toEqual([
        { password: 'password-password', hash: HASH },
      ]);
    },
  );

  it('rejects invalid attempted passwords before compare and contains compare failures', async () => {
    const { store, secureFile, hasher } = harness();
    secureFile.readResults.push(record());
    await store.initializeLocal('admin', SECRET_PATH, 12);
    await expect(store.verify('admin', 'short')).resolves.toBe(false);
    expect(hasher.compareCalls).toEqual([]);
    hasher.compareResults.push(new Error('hash secret path'));
    expectGeneric(
      await captureError(store.verify('admin', 'password-password')),
    );
  });

  it.each([
    ['not_committed', HASH, '2026-07-12T00:00:00.000Z'],
    ['committed', NEXT_HASH, NOW.toISOString()],
    ['committed_durability_uncertain', NEXT_HASH, NOW.toISOString()],
  ] as const)(
    'handles %s replacement authority',
    async (state, expectedHash, expectedTime) => {
      const { store, secureFile, hasher } = harness();
      secureFile.readResults.push(record());
      await store.initializeLocal('admin', SECRET_PATH, 12);
      hasher.hashResults.push(NEXT_HASH);
      secureFile.replaceResults.push({ state });
      await expect(
        store.replacePassword('new-password-value'),
      ).resolves.toEqual({ state });
      hasher.compareResults.push(true);
      await store.verify('admin', 'new-password-value');
      expect(hasher.compareCalls.at(-1)?.hash).toBe(expectedHash);
      if (state !== 'not_committed') {
        expect(secureFile.replacedValues.at(-1)).toEqual({
          ...record(),
          passwordHash: expectedHash,
          passwordChangedAt: expectedTime,
        });
      }
    },
  );

  it('serializes concurrent replacements deterministically', async () => {
    const { store, secureFile, hasher } = harness();
    secureFile.readResults.push(record());
    await store.initializeLocal('admin', SECRET_PATH, 12);
    const gate = deferred<ReplaceResult>();
    hasher.hashResults.push(NEXT_HASH, THIRD_HASH);
    secureFile.replaceResults.push(gate.promise, { state: 'committed' });
    const first = store.replacePassword('first-password');
    const second = store.replacePassword('second-password');
    await tick();
    expect(secureFile.replacedValues).toHaveLength(1);
    gate.resolve({ state: 'committed' });
    await expect(first).resolves.toEqual({ state: 'committed' });
    await expect(second).resolves.toEqual({ state: 'committed' });
    expect(hasher.hashCalls.map(({ password }) => password)).toEqual([
      'first-password',
      'second-password',
    ]);
  });

  it('validates and hashes before filesystem access and never persists plaintext', async () => {
    const { store, secureFile, hasher } = harness();
    secureFile.readResults.push(record());
    await store.initializeLocal('admin', SECRET_PATH, 12);
    secureFile.calls.length = 0;
    await expect(store.replacePassword('too-short')).rejects.toBeInstanceOf(
      CredentialStoreError,
    );
    expect(secureFile.calls).toEqual([]);
    hasher.hashResults.push(new Error('new-password-value /path'));
    expectGeneric(
      await captureError(store.replacePassword('new-password-value')),
    );
    expect(secureFile.calls).toEqual([]);
    expect(JSON.stringify(secureFile.replacedValues)).not.toContain(
      'new-password-value',
    );
  });
});

function harness() {
  const secureFile = new ScriptedSecureJsonFile();
  const hasher = new ScriptedHasher();
  const bootstrap = new MemoryBootstrapFileSystem();
  const store = new CredentialStore({
    dataDir: DATA_DIR,
    secureFile,
    hasher,
    bootstrapFileSystem: bootstrap,
    runtimeUid: UID,
    clock: () => new Date(NOW),
  });
  return { store, secureFile, hasher, bootstrap };
}

class ScriptedSecureJsonFile implements SecureJsonFile {
  readonly calls: string[] = [];
  readonly replacedValues: unknown[] = [];
  readonly readResults: Array<unknown | Error | undefined> = [];
  readonly replaceResults: Array<ReplaceResult | Promise<ReplaceResult>> = [];

  async read(path: string, maximumBytes: number): Promise<unknown | undefined> {
    this.calls.push(`read ${path} ${maximumBytes}`);
    const result = this.readResults.shift();
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }

  async replace(
    path: string,
    value: unknown,
    mode: 0o600,
  ): Promise<ReplaceResult> {
    this.calls.push(`replace ${path} ${mode}`);
    this.replacedValues.push(structuredClone(value));
    const result = this.replaceResults.shift();
    if (!result) throw new Error('missing replace result');
    return result;
  }

  async syncParent(): Promise<boolean> {
    return true;
  }
}

class ScriptedHasher implements PasswordHasher {
  readonly hashCalls: Array<{ password: string; cost: number }> = [];
  readonly compareCalls: Array<{ password: string; hash: string }> = [];
  readonly hashResults: Array<string | Error | Promise<string>> = [];
  readonly compareResults: Array<boolean | Error | Promise<boolean>> = [];

  async hash(password: string, cost: number): Promise<string> {
    this.hashCalls.push({ password, cost });
    const result = this.hashResults.shift();
    if (result instanceof Error) throw result;
    if (!result) throw new Error('missing hash result');
    return result;
  }

  async compare(password: string, hash: string): Promise<boolean> {
    this.compareCalls.push({ password, hash });
    const result = this.compareResults.shift();
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error('missing compare result');
    return result;
  }
}

class MemoryBootstrapFileSystem implements BootstrapSecretFileSystem {
  content = Buffer.from('password-password');
  uid = UID;
  mode = 0o400;
  kind: 'file' | 'directory' = 'file';
  statSize: number | undefined;
  openError: Error | undefined;
  failStage: 'stat' | 'read' | 'close' | undefined;
  maximumRead = Number.POSITIVE_INFINITY;
  openFlags: number | undefined;
  readonly operations: string[] = [];

  async open(_path: string, flags: number): Promise<BootstrapSecretHandle> {
    this.operations.push('open');
    this.openFlags = flags;
    if (this.openError) throw this.openError;
    return new MemoryBootstrapHandle(this);
  }
}

class MemoryBootstrapHandle implements BootstrapSecretHandle {
  private offset = 0;

  constructor(private readonly fileSystem: MemoryBootstrapFileSystem) {}

  async stat() {
    this.fileSystem.operations.push('stat');
    if (this.fileSystem.failStage === 'stat') throw new Error('secret stat');
    return {
      uid: this.fileSystem.uid,
      mode: this.fileSystem.mode,
      size: this.fileSystem.statSize ?? this.fileSystem.content.byteLength,
      isFile: () => this.fileSystem.kind === 'file',
    };
  }

  async read(buffer: Uint8Array, offset: number, length: number) {
    this.fileSystem.operations.push('read');
    if (this.fileSystem.failStage === 'read') throw new Error('secret read');
    const bytesRead = Math.min(
      length,
      this.fileSystem.maximumRead,
      this.fileSystem.content.byteLength - this.offset,
    );
    buffer.set(
      this.fileSystem.content.subarray(this.offset, this.offset + bytesRead),
      offset,
    );
    this.offset += bytesRead;
    return { bytesRead };
  }

  async close(): Promise<void> {
    this.fileSystem.operations.push('close');
    if (this.fileSystem.failStage === 'close') throw new Error('secret close');
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function record() {
  return {
    version: 1,
    username: 'admin',
    passwordHash: HASH,
    passwordChangedAt: '2026-07-12T00:00:00.000Z',
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return new Error('expected error');
  } catch (error) {
    return error;
  }
}

function expectGeneric(error: unknown): void {
  expect(error).toBeInstanceOf(CredentialStoreError);
  expect(error).toMatchObject({ message: 'Credential store operation failed' });
  expect(String(error)).not.toContain('/');
  expect(error).not.toHaveProperty('cause');
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
