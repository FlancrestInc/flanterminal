import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { type ReplaceResult, type SecureJsonFile } from './secure-json-file.js';
import {
  CredentialStore,
  CredentialStoreError,
  type EnrollmentResult,
  type PasswordHasher,
} from './credential-store.js';

const DATA_DIR = '/data';
const AUTH_PATH = '/data/auth.json';
const NOW = new Date('2026-07-12T12:34:56.000Z');
const HASH = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
const NEXT_HASH = `${HASH.slice(0, -1)}5`;
const THIRD_HASH = `${HASH.slice(0, -1)}6`;

describe('CredentialStore initialization', () => {
  it('fails closed before initialization has completed', async () => {
    const { store, hasher } = harness();

    expectGeneric(captureSyncError(() => store.isInitialized()));
    expectGeneric(await captureError(store.enroll('password-password')));
    expectGeneric(
      await captureError(store.verify('admin', 'password-password')),
    );
    expectGeneric(
      await captureError(store.replacePassword('password-password')),
    );
    expect(hasher.hashCalls).toEqual([]);
  });

  it('accepts a missing auth record as an uninitialized state', async () => {
    const { store, secureFile, hasher } = harness();
    secureFile.readResults.push(undefined);

    await expect(store.initializeLocal('admin', 12)).resolves.toBeUndefined();

    expect(store.isInitialized()).toBe(false);
    expect(secureFile.calls).toEqual([`read ${AUTH_PATH} 1048576`]);
    expect(secureFile.replacedValues).toEqual([]);
    expect(hasher.hashCalls).toEqual([]);
  });

  it('loads a valid existing auth record as initialized', async () => {
    const { store, secureFile } = harness();
    secureFile.readResults.push(record());

    await store.initializeLocal('admin', 12);

    expect(store.isInitialized()).toBe(true);
    expect(secureFile.replacedValues).toEqual([]);
  });

  it.each([
    ['version', { ...record(), version: 2 }],
    ['unknown field', { ...record(), secret: 'value' }],
    ['username mismatch', { ...record(), username: 'other' }],
    ['malformed hash', { ...record(), passwordHash: 'not-bcrypt' }],
    [
      'unsupported 2y hash',
      { ...record(), passwordHash: HASH.replace('$2b$', '$2y$') },
    ],
    [
      'low hash cost',
      { ...record(), passwordHash: HASH.replace('$12$', '$09$') },
    ],
    [
      'high hash cost',
      { ...record(), passwordHash: HASH.replace('$12$', '$16$') },
    ],
    ['bad timestamp', { ...record(), passwordChangedAt: 'yesterday' }],
  ])('rejects a %s record without reopening setup', async (_name, value) => {
    const { store, secureFile, hasher } = harness();
    secureFile.readResults.push(value);

    expectGeneric(await captureError(store.initializeLocal('admin', 12)));
    expectGeneric(captureSyncError(() => store.isInitialized()));
    expectGeneric(await captureError(store.enroll('password-password')));
    expect(secureFile.replacedValues).toEqual([]);
    expect(hasher.hashCalls).toEqual([]);
  });

  it('keeps an unreadable or unsafe auth record fatal', async () => {
    const { store, secureFile, hasher } = harness();
    secureFile.readResults.push(new Error('/data/auth.json raw errno'));

    expectGeneric(await captureError(store.initializeLocal('admin', 12)));
    expectGeneric(captureSyncError(() => store.isInitialized()));
    expectGeneric(await captureError(store.enroll('password-password')));
    expect(secureFile.replacedValues).toEqual([]);
    expect(hasher.hashCalls).toEqual([]);
  });

  it('validates configured username and cost before filesystem access', async () => {
    for (const [username, cost] of [
      ['', 12],
      ['Cafe\u0301', 12],
      ['line\nfeed', 12],
      ['admin', 9],
      ['admin', 16],
      ['admin', 12.5],
    ] as const) {
      const { store, secureFile } = harness();
      expectGeneric(await captureError(store.initializeLocal(username, cost)));
      expect(secureFile.calls).toEqual([]);
      expectGeneric(captureSyncError(() => store.isInitialized()));
    }
  });

  it('permits initialization exactly once', async () => {
    const { store, secureFile } = harness();
    secureFile.readResults.push(undefined);
    await store.initializeLocal('admin', 12);

    expectGeneric(await captureError(store.initializeLocal('admin', 12)));
    expect(secureFile.calls).toEqual([`read ${AUTH_PATH} 1048576`]);
    expect(store.isInitialized()).toBe(false);
  });
});

describe('CredentialStore enrollment', () => {
  it('persists the configured identity with mode 0600 and becomes initialized', async () => {
    const { store, secureFile, hasher } = await uninitializedHarness();
    hasher.hashResults.push(HASH);
    secureFile.replaceResults.push({ state: 'committed' });

    const result: EnrollmentResult = await store.enroll(
      'correct horse battery',
    );

    expect(result).toEqual({
      outcome: 'enrolled',
      persistence: 'committed',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(store.isInitialized()).toBe(true);
    expect(hasher.hashCalls).toEqual([
      { password: 'correct horse battery', cost: 12 },
    ]);
    expect(secureFile.calls).toEqual([
      `read ${AUTH_PATH} 1048576`,
      `replace ${AUTH_PATH} 384`,
    ]);
    expect(secureFile.replacedValues).toEqual([
      {
        version: 1,
        username: 'admin',
        passwordHash: HASH,
        passwordChangedAt: NOW.toISOString(),
      },
    ]);
    expect(JSON.stringify(secureFile.replacedValues)).not.toContain(
      'correct horse battery',
    );
  });

  it.each([
    ['non-string', 12],
    ['NUL', `password\0password`],
    ['11 bytes', 'a'.repeat(11)],
    ['73 bytes', 'a'.repeat(73)],
    ['11 multibyte bytes', `${'é'.repeat(5)}a`],
    ['73 multibyte bytes', `${'é'.repeat(36)}a`],
  ])('rejects a %s password before bcrypt', async (_name, password) => {
    const { store, secureFile, hasher } = await uninitializedHarness();

    expectGeneric(await captureError(store.enroll(password as string)));
    expect(store.isInitialized()).toBe(false);
    expect(hasher.hashCalls).toEqual([]);
    expect(secureFile.replacedValues).toEqual([]);
  });

  it.each([
    ['12 ASCII bytes', 'a'.repeat(12)],
    ['72 ASCII bytes', 'a'.repeat(72)],
    ['12 multibyte bytes', 'é'.repeat(6)],
    ['72 multibyte bytes', '🚀'.repeat(18)],
    ['non-normalized input', `${'e\u0301'.repeat(4)}`],
  ])('accepts %s without normalization', async (_name, password) => {
    const { store, secureFile, hasher } = await uninitializedHarness();
    hasher.hashResults.push(HASH);
    secureFile.replaceResults.push({ state: 'committed' });

    await store.enroll(password);

    expect(hasher.hashCalls).toEqual([{ password, cost: 12 }]);
  });

  it.each([
    new Error('password /secret/path'),
    'invalid-hash',
    HASH.replace('$2b$', '$2y$'),
    HASH.replace('$12$', '$13$'),
  ])('contains bcrypt failure %# and remains retryable', async (hashResult) => {
    const { store, secureFile, hasher } = await uninitializedHarness();
    hasher.hashResults.push(hashResult);

    expectGeneric(await captureError(store.enroll('password-password')));
    expect(store.isInitialized()).toBe(false);
    expect(secureFile.replacedValues).toEqual([]);

    hasher.hashResults.push(HASH);
    secureFile.replaceResults.push({ state: 'committed' });
    await expect(store.enroll('retry-password')).resolves.toEqual({
      outcome: 'enrolled',
      persistence: 'committed',
    });
  });

  it.each(['committed', 'committed_durability_uncertain'] as const)(
    'treats %s as an irreversible initialized claim',
    async (persistence) => {
      const { store, secureFile, hasher } = await uninitializedHarness();
      hasher.hashResults.push(HASH);
      secureFile.replaceResults.push({ state: persistence });

      const first = await store.enroll('first-password');
      const second = await store.enroll('second-password');

      expect(first).toEqual({ outcome: 'enrolled', persistence });
      expect(Object.isFrozen(first)).toBe(true);
      expect(second).toEqual({ outcome: 'already_initialized' });
      expect(Object.isFrozen(second)).toBe(true);
      expect(store.isInitialized()).toBe(true);
      expect(hasher.hashCalls.map(({ password }) => password)).toEqual([
        'first-password',
      ]);
      expect(secureFile.replacedValues).toHaveLength(1);
    },
  );

  it('returns already_initialized for a loaded record without hashing', async () => {
    const { store, secureFile, hasher } = harness();
    secureFile.readResults.push(record());
    await store.initializeLocal('admin', 12);

    const result = await store.enroll('replacement-password');

    expect(result).toEqual({ outcome: 'already_initialized' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(hasher.hashCalls).toEqual([]);
    expect(secureFile.replacedValues).toEqual([]);
  });

  it('serializes concurrent enrollment and rechecks state before bcrypt', async () => {
    const { store, secureFile, hasher } = await uninitializedHarness();
    const hashGate = deferred<string>();
    hasher.hashResults.push(hashGate.promise);
    secureFile.replaceResults.push({ state: 'committed' });

    const first = store.enroll('first-password');
    const second = store.enroll('second-password');
    const third = store.enroll('third-password');
    await tick();
    expect(hasher.hashCalls.map(({ password }) => password)).toEqual([
      'first-password',
    ]);
    expect(secureFile.replacedValues).toEqual([]);

    hashGate.resolve(HASH);

    await expect(first).resolves.toEqual({
      outcome: 'enrolled',
      persistence: 'committed',
    });
    await expect(second).resolves.toEqual({ outcome: 'already_initialized' });
    await expect(third).resolves.toEqual({ outcome: 'already_initialized' });
    expect(hasher.hashCalls.map(({ password }) => password)).toEqual([
      'first-password',
    ]);
    expect(secureFile.replacedValues).toHaveLength(1);
  });

  it('allows a queued attempt to retry after not_committed', async () => {
    const { store, secureFile, hasher } = await uninitializedHarness();
    const replaceGate = deferred<ReplaceResult>();
    const secondHashGate = deferred<string>();
    hasher.hashResults.push(HASH, secondHashGate.promise);
    secureFile.replaceResults.push(replaceGate.promise, { state: 'committed' });

    const first = store.enroll('first-password');
    const second = store.enroll('second-password');
    await tick();
    expect(hasher.hashCalls.map(({ password }) => password)).toEqual([
      'first-password',
    ]);

    replaceGate.resolve({ state: 'not_committed' });

    const firstResult = await first;
    expect(firstResult).toEqual({ outcome: 'not_committed' });
    expect(Object.isFrozen(firstResult)).toBe(true);
    expect(store.isInitialized()).toBe(false);
    await tick();
    expect(hasher.hashCalls.map(({ password }) => password)).toEqual([
      'first-password',
      'second-password',
    ]);

    secondHashGate.resolve(NEXT_HASH);

    await expect(second).resolves.toEqual({
      outcome: 'enrolled',
      persistence: 'committed',
    });
    expect(hasher.hashCalls.map(({ password }) => password)).toEqual([
      'first-password',
      'second-password',
    ]);
    expect(secureFile.replacedValues).toHaveLength(2);
    expect(store.isInitialized()).toBe(true);
  });
});

describe('CredentialStore verification and replacement', () => {
  it('keeps all reflection and string representations bounded and secret-free', async () => {
    const { store, secureFile } = harness();
    secureFile.readResults.push(record());
    await store.initializeLocal('admin', 12);
    expect(Reflect.ownKeys(store)).toEqual([]);
    expect({ ...store }).toEqual({});
    for (const representation of [
      JSON.stringify(store),
      inspect(store),
      String(store),
      JSON.stringify(Reflect.ownKeys(store)),
      JSON.stringify({ ...store }),
    ]) {
      expect(representation).not.toContain('admin');
      expect(representation).not.toContain(HASH);
      expect(representation).not.toContain('/data');
      expect(representation).not.toContain('password-password');
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
      await store.initializeLocal('admin', 12);
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
    await store.initializeLocal('admin', 12);
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
      await store.initializeLocal('admin', 12);
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
    await store.initializeLocal('admin', 12);
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
    await store.initializeLocal('admin', 12);
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
  const store = new CredentialStore({
    dataDir: DATA_DIR,
    secureFile,
    hasher,
    clock: () => new Date(NOW),
  });
  return { store, secureFile, hasher };
}

async function uninitializedHarness() {
  const result = harness();
  result.secureFile.readResults.push(undefined);
  await result.store.initializeLocal('admin', 12);
  return result;
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

function captureSyncError(operation: () => unknown): unknown {
  try {
    operation();
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
