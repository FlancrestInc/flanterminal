import { describe, expect, it, vi } from 'vitest';

import {
  MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  type WorkspaceSettings,
  type WorkspaceSettingsConstraints,
} from '@flanterminal/shared';

import { type ReplaceResult, type SecureJsonFile } from './secure-json-file.js';
import { SettingsStore, SettingsStoreError } from './settings-store.js';

const SETTINGS_PATH = '/data/settings.json';

const defaults: WorkspaceSettings = {
  version: 1,
  fontFamily: 'jetbrains-mono-nerd',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  scrollback: 10_000,
  theme: 'dark',
  cursorStyle: 'block',
  cursorBlink: true,
  bellBehavior: 'visual',
  reconnectBehavior: 'automatic',
  automaticTabCreation: true,
  workspaceShortcuts: 'default',
  defaultShell: '/bin/bash',
  tmuxHistoryLimit: 50_000,
  staleSessionCleanupHours: 24,
  customTerminalPalette: MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
};

const constraints: WorkspaceSettingsConstraints = {
  limits: {
    fontFamilies: ['jetbrains-mono-nerd', 'system-monospace'],
    fontSize: { min: 10, max: 24, step: 1 },
    lineHeight: { min: 1, max: 1.5, step: 0.05 },
    letterSpacing: { min: 0, max: 2, step: 1 },
    scrollback: { min: 1_000, max: 50_000, step: 1_000 },
    themes: ['dark', 'light'],
    cursorStyles: ['block', 'bar'],
    bellBehaviors: ['none', 'visual'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 100_000, step: 1_000 },
    staleSessionCleanupHours: { min: 0, max: 168, step: 1 },
  },
  allowedShells: ['/bin/bash', '/bin/zsh'],
};

describe('SettingsStore initialization', () => {
  it.each([
    ['committed', true],
    ['committed_durability_uncertain', false],
  ] as const)(
    'creates missing settings with a %s result',
    async (state, ready) => {
      const file = new ScriptedSecureJsonFile();
      file.readResults.push(undefined);
      file.replaceResults.push({ state });
      const store = createStore(file);

      await store.initialize();

      expect(file.calls).toEqual([
        `read ${SETTINGS_PATH} 1048576`,
        `replace ${SETTINGS_PATH} 384`,
      ]);
      expect(file.replacedValues).toEqual([defaults]);
      expect(store.snapshot()).toEqual(defaults);
      expect(store.snapshot()).not.toBe(defaults);
      expect(store.durabilityReady()).toBe(ready);
    },
  );

  it('fails missing initialization when replacement is not committed', async () => {
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(undefined);
    file.replaceResults.push({ state: 'not_committed' });
    const store = createStore(file);

    await expect(store.initialize()).rejects.toBeInstanceOf(SettingsStoreError);
    expect(() => store.snapshot()).toThrow(SettingsStoreError);
    expect(() => store.durabilityReady()).toThrow(SettingsStoreError);
  });

  it('loads a valid persisted document without replacing it', async () => {
    const persisted = { ...defaults, theme: 'light' as const };
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(persisted);
    const store = createStore(file);

    await store.initialize();

    expect(store.snapshot()).toEqual(persisted);
    expect(store.snapshot()).not.toBe(persisted);
    expect(store.durabilityReady()).toBe(true);
    expect(file.calls).toEqual([`read ${SETTINGS_PATH} 1048576`]);
  });

  it.each([
    ['committed', true],
    ['committed_durability_uncertain', false],
  ] as const)(
    'migrates a valid legacy document with a %s replacement',
    async (state, ready) => {
      const legacy = structuredClone(defaults) as Record<string, unknown>;
      delete legacy.customTerminalPalette;
      const durability = vi.fn();
      const file = new ScriptedSecureJsonFile();
      file.readResults.push(legacy);
      file.replaceResults.push({ state });
      const store = createStore(file, defaults, durability);

      await store.initialize();

      expect(store.snapshot()).toEqual(defaults);
      expect(store.durabilityReady()).toBe(ready);
      expect(file.calls).toEqual([
        `read ${SETTINGS_PATH} 1048576`,
        `replace ${SETTINGS_PATH} 384`,
      ]);
      expect(file.replacedValues).toEqual([defaults]);
      expect(durability).toHaveBeenCalledTimes(
        state === 'committed_durability_uncertain' ? 1 : 0,
      );
    },
  );

  it('does not publish a legacy migration when replacement is not committed', async () => {
    const legacy = structuredClone(defaults) as Record<string, unknown>;
    delete legacy.customTerminalPalette;
    const durability = vi.fn();
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(legacy);
    file.replaceResults.push({ state: 'not_committed' });
    const store = createStore(file, defaults, durability);

    await expect(store.initialize()).rejects.toBeInstanceOf(SettingsStoreError);

    expect(() => store.snapshot()).toThrow(SettingsStoreError);
    expect(durability).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong version', { ...defaults, version: 2 }],
    ['unknown property', { ...defaults, secret: 'value' }],
    ['invalid schema', { ...defaults, cursorBlink: 'yes' }],
    ['out of deployment limit', { ...defaults, fontSize: 25 }],
    ['disallowed shell', { ...defaults, defaultShell: '/bin/fish' }],
  ])(
    'rejects persisted %s without replacing the file',
    async (_name, value) => {
      const file = new ScriptedSecureJsonFile();
      file.readResults.push(value);
      const store = createStore(file);

      await expect(store.initialize()).rejects.toBeInstanceOf(
        SettingsStoreError,
      );

      expect(file.calls).toEqual([`read ${SETTINGS_PATH} 1048576`]);
      expect(file.replacedValues).toEqual([]);
    },
  );

  it.each(['corrupt JSON', 'unsafe file', 'read failure'])(
    'preserves the file after a generic %s read error',
    async (secret) => {
      const file = new ScriptedSecureJsonFile();
      file.readResults.push(new Error(`${secret}: /private/settings.json`));
      const store = createStore(file);

      const error = await captureError(store.initialize());

      expectGenericError(error);
      expect(file.calls).toEqual([`read ${SETTINGS_PATH} 1048576`]);
      expect(file.replacedValues).toEqual([]);
    },
  );

  it('rejects deployment defaults outside current constraints instead of clamping', async () => {
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(undefined);
    const store = createStore(file, { ...defaults, fontSize: 25 });

    await expect(store.initialize()).rejects.toBeInstanceOf(SettingsStoreError);

    expect(file.calls).toEqual([`read ${SETTINGS_PATH} 1048576`]);
    expect(file.replacedValues).toEqual([]);
  });

  it('isolates immutable snapshots from defaults and caller mutations', async () => {
    const mutableDefaults = structuredClone(defaults);
    const mutableConstraints = structuredClone(constraints);
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(undefined);
    file.replaceResults.push({ state: 'committed' });
    const store = new SettingsStore({
      dataDir: '/data',
      defaults: mutableDefaults,
      constraints: mutableConstraints,
      secureFile: file,
    });
    Reflect.set(mutableDefaults, 'theme', 'light');
    Reflect.set(mutableConstraints.allowedShells, '0', '/bin/zsh');

    await store.initialize();
    const snapshot = store.snapshot();

    expect(snapshot).toEqual(defaults);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot, 'theme', 'light')).toBe(false);
    expect(store.snapshot()).toBe(snapshot);
  });

  it('serializes duplicate initialize calls and rejects the second generically', async () => {
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(defaults);
    const store = createStore(file);

    const first = store.initialize();
    const second = store.initialize();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toBeInstanceOf(SettingsStoreError);
    expect(file.calls).toEqual([`read ${SETTINGS_PATH} 1048576`]);
  });
});

describe('SettingsStore replacement and durability', () => {
  it('rejects a partial or invalid candidate before filesystem mutation', async () => {
    const { store, file } = await initializedStore();
    file.calls.length = 0;

    await expect(store.replace({ theme: 'light' })).rejects.toBeInstanceOf(
      SettingsStoreError,
    );
    await expect(
      store.replace({ ...defaults, defaultShell: '/bin/fish' }),
    ).rejects.toBeInstanceOf(SettingsStoreError);

    expect(file.calls).toEqual([]);
    expect(store.snapshot()).toEqual(defaults);
  });

  it('rolls back memory and readiness when replacement is not committed', async () => {
    const { store, file } = await initializedStore();
    const before = store.snapshot();
    file.replaceResults.push({ state: 'not_committed' });

    await expect(
      store.replace({ ...defaults, theme: 'light' }),
    ).resolves.toEqual({ state: 'not_committed' });

    expect(store.snapshot()).toBe(before);
    expect(store.durabilityReady()).toBe(true);
  });

  it.each([
    ['committed', true],
    ['committed_durability_uncertain', false],
  ] as const)(
    'publishes a %s replacement as authority',
    async (state, ready) => {
      const { store, file } = await initializedStore();
      const candidate = { ...defaults, theme: 'light' as const };
      file.replaceResults.push({ state });

      await expect(store.replace(candidate)).resolves.toEqual({ state });

      const snapshot = store.snapshot();
      expect(snapshot).toEqual(candidate);
      expect(snapshot).not.toBe(candidate);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(store.durabilityReady()).toBe(ready);
      expect(file.replacedValues.at(-1)).toEqual(candidate);
    },
  );

  it('recovers uncertain durability only when parent sync succeeds', async () => {
    const { store, file } = await initializedStore();
    file.replaceResults.push({ state: 'committed_durability_uncertain' });
    await store.replace({ ...defaults, theme: 'light' });
    file.syncResults.push(false, true);

    await expect(store.retryDurability()).resolves.toBe(false);
    expect(store.durabilityReady()).toBe(false);
    await expect(store.retryDurability()).resolves.toBe(true);
    expect(store.durabilityReady()).toBe(true);
    expect(file.calls.filter((call) => call.startsWith('sync '))).toEqual([
      `sync ${SETTINGS_PATH}`,
      `sync ${SETTINGS_PATH}`,
    ]);
  });

  it('does not call the filesystem when durability is already ready', async () => {
    const { store, file } = await initializedStore();
    file.calls.length = 0;

    await expect(store.retryDurability()).resolves.toBe(true);

    expect(file.calls).toEqual([]);
  });

  it('serializes concurrent replacements in invocation order', async () => {
    const { store, file } = await initializedStore();
    const firstGate = deferred<ReplaceResult>();
    file.replaceResults.push(firstGate.promise, { state: 'committed' });
    const firstCandidate = { ...defaults, theme: 'light' as const };
    const secondCandidate = { ...defaults, cursorStyle: 'bar' as const };

    const first = store.replace(firstCandidate);
    const second = store.replace(secondCandidate);
    await tick();
    expect(file.replacedValues.slice(-1)).toEqual([firstCandidate]);

    firstGate.resolve({ state: 'committed' });
    await expect(first).resolves.toEqual({ state: 'committed' });
    await expect(second).resolves.toEqual({ state: 'committed' });
    expect(file.replacedValues.slice(-2)).toEqual([
      firstCandidate,
      secondCandidate,
    ]);
    expect(store.snapshot()).toEqual(secondCandidate);
  });

  it('prevents an earlier retry from marking a later uncertain write ready', async () => {
    const { store, file } = await initializedStore();
    file.replaceResults.push({ state: 'committed_durability_uncertain' });
    await store.replace({ ...defaults, theme: 'light' });
    const syncGate = deferred<boolean>();
    file.syncResults.push(syncGate.promise);

    const retry = store.retryDurability();
    const replacement = store.replace({ ...defaults, cursorStyle: 'bar' });
    file.replaceResults.push({ state: 'committed_durability_uncertain' });
    await tick();
    expect(file.calls.at(-1)).toBe(`sync ${SETTINGS_PATH}`);

    syncGate.resolve(true);
    await expect(retry).resolves.toBe(true);
    await expect(replacement).resolves.toEqual({
      state: 'committed_durability_uncertain',
    });
    expect(store.durabilityReady()).toBe(false);
  });
});

describe('SettingsStore lifecycle and observers', () => {
  it.each(['snapshot', 'replace', 'retryDurability'] as const)(
    'rejects %s before initialization with a generic error',
    async (method) => {
      const store = createStore(new ScriptedSecureJsonFile());
      const error =
        method === 'snapshot'
          ? captureSyncError(() => store.snapshot())
          : await captureError(
              method === 'replace'
                ? store.replace(defaults)
                : store.retryDurability(),
            );
      expectGenericError(error);
    },
  );

  it('notifies one stable listener snapshot once per committed replacement', async () => {
    const { store, file } = await initializedStore();
    const calls: string[] = [];
    let unsubscribeSecond: () => void = () => undefined;
    const first = (settings: WorkspaceSettings) => {
      calls.push(`first:${settings.theme}`);
      unsubscribeSecond();
      store.subscribe(() => {
        calls.push('late');
      });
    };
    store.subscribe(first);
    unsubscribeSecond = store.subscribe((settings) => {
      calls.push(`second:${settings.theme}`);
      throw new Error('listener secret');
    });
    store.subscribe((settings) => {
      calls.push(`third:${settings.theme}`);
    });
    file.replaceResults.push(
      { state: 'not_committed' },
      { state: 'committed' },
    );

    await store.replace({ ...defaults, theme: 'light' });
    await store.replace({ ...defaults, theme: 'light' });

    expect(calls).toEqual(['first:light', 'second:light', 'third:light']);
  });

  it('supports idempotent unsubscribe', async () => {
    const { store, file } = await initializedStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    unsubscribe();
    file.replaceResults.push({ state: 'committed' });

    await store.replace({ ...defaults, theme: 'light' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('treats repeated registration of one function as independent subscriptions', async () => {
    const { store, file } = await initializedStore();
    const listener = vi.fn();
    const unsubscribeFirst = store.subscribe(listener);
    const unsubscribeSecond = store.subscribe(listener);
    unsubscribeFirst();
    unsubscribeFirst();
    file.replaceResults.push({ state: 'committed' }, { state: 'committed' });

    await store.replace({ ...defaults, theme: 'light' });
    unsubscribeSecond();
    await store.replace(defaults);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('counts repeated registration of one function toward the listener cap', async () => {
    const { store } = await initializedStore();
    const listener = () => undefined;
    Array.from({ length: 64 }, () => store.subscribe(listener));

    expect(() => store.subscribe(listener)).toThrow(SettingsStoreError);
  });

  it('handles an asynchronously rejecting listener without affecting observers or state', async () => {
    const { store, file } = await initializedStore();
    const rejection = deferred<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const otherListener = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      store.subscribe(() => rejection.promise);
      store.subscribe(otherListener);
      file.replaceResults.push({ state: 'committed' });

      await store.replace({ ...defaults, theme: 'light' });
      rejection.reject(new Error('async listener secret'));
      await flushAsyncRejections();

      expect(unhandled).toEqual([]);
      expect(otherListener).toHaveBeenCalledOnce();
      expect(store.snapshot().theme).toBe('light');
      expect(store.durabilityReady()).toBe(true);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('caps listeners conservatively and permits a new one after unsubscribe', async () => {
    const { store } = await initializedStore();
    const unsubscribers = Array.from({ length: 64 }, () =>
      store.subscribe(() => undefined),
    );

    expect(() => store.subscribe(() => undefined)).toThrow(SettingsStoreError);
    unsubscribers[0]?.();
    expect(() => store.subscribe(() => undefined)).not.toThrow();
  });

  it('emits a bounded frozen durability event and isolates callback failures', async () => {
    const events: unknown[] = [];
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(undefined);
    file.replaceResults.push(
      { state: 'committed_durability_uncertain' },
      { state: 'committed_durability_uncertain' },
    );
    const store = createStore(file, defaults, (event) => {
      events.push(event);
      throw new Error('callback failed with /secret/path');
    });

    await expect(store.initialize()).resolves.toBeUndefined();
    await expect(
      store.replace({ ...defaults, theme: 'light' }),
    ).resolves.toEqual({ state: 'committed_durability_uncertain' });

    expect(events).toEqual([
      { type: 'settings_store_durability_degraded' },
      { type: 'settings_store_durability_degraded' },
    ]);
    expect(events.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('/data');
    expect(JSON.stringify(events)).not.toContain('theme');
  });

  it('handles an asynchronously rejecting durability callback', async () => {
    const rejection = deferred<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(undefined);
    file.replaceResults.push({ state: 'committed_durability_uncertain' });
    const store = createStore(file, defaults, () => rejection.promise);
    process.on('unhandledRejection', onUnhandled);
    try {
      await store.initialize();
      rejection.reject(new Error('async durability secret'));
      await flushAsyncRejections();

      expect(unhandled).toEqual([]);
      expect(store.snapshot()).toEqual(defaults);
      expect(store.durabilityReady()).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('uses generic errors without paths, values, or raw causes', async () => {
    const file = new ScriptedSecureJsonFile();
    file.readResults.push(new Error('/secret/settings.json contains hunter2'));
    const store = createStore(file);

    const error = await captureError(store.initialize());

    expectGenericError(error);
    expect(error).not.toHaveProperty('cause');
  });

  it('rejects a relative data directory generically without filesystem access', () => {
    const file = new ScriptedSecureJsonFile();

    const error = captureSyncError(
      () =>
        new SettingsStore({
          dataDir: 'relative',
          defaults,
          constraints,
          secureFile: file,
        }),
    );

    expectGenericError(error);
    expect(file.calls).toEqual([]);
  });
});

function createStore(
  file: ScriptedSecureJsonFile,
  storeDefaults: WorkspaceSettings = defaults,
  onDurabilityEvent?: (event: unknown) => void,
): SettingsStore {
  return new SettingsStore({
    dataDir: '/data',
    defaults: storeDefaults,
    constraints,
    secureFile: file,
    ...(onDurabilityEvent ? { onDurabilityEvent } : {}),
  });
}

async function initializedStore(): Promise<{
  store: SettingsStore;
  file: ScriptedSecureJsonFile;
}> {
  const file = new ScriptedSecureJsonFile();
  file.readResults.push(defaults);
  const store = createStore(file);
  await store.initialize();
  return { store, file };
}

class ScriptedSecureJsonFile implements SecureJsonFile {
  readonly calls: string[] = [];
  readonly replacedValues: unknown[] = [];
  readonly readResults: Array<unknown | undefined | Error> = [];
  readonly replaceResults: Array<ReplaceResult | Promise<ReplaceResult>> = [];
  readonly syncResults: Array<boolean | Promise<boolean>> = [];

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
    if (!result) throw new Error('missing scripted replacement');
    return result;
  }

  async syncParent(path: string): Promise<boolean> {
    this.calls.push(`sync ${path}`);
    const result = this.syncResults.shift();
    if (result === undefined) throw new Error('missing scripted sync');
    return result;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushAsyncRejections(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('expected rejection');
  } catch (error) {
    return error;
  }
}

function captureSyncError(operation: () => unknown): unknown {
  try {
    operation();
    throw new Error('expected throw');
  } catch (error) {
    return error;
  }
}

function expectGenericError(error: unknown): void {
  expect(error).toBeInstanceOf(SettingsStoreError);
  expect(error).toMatchObject({
    name: 'SettingsStoreError',
    message: 'Settings store operation failed',
  });
  expect(String(error)).not.toContain('/data');
  expect(String(error)).not.toContain('secret');
  expect(String(error)).not.toContain('hunter2');
}
