import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  OrderConflictError,
  SessionLimitError,
  TabNotFoundError,
  TabStore,
  type TabStoreFileHandle,
  type TabStoreFileSystem,
} from './tab-store.js';

const IDS = [
  '550e8400-e29b-41d4-a716-446655440000',
  '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
  '01890f3e-7b5a-7cc1-98c4-dc0c0c07398f',
  'ffffffff-ffff-4fff-bfff-ffffffffffff',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
] as const;
const NOW = '2026-07-11T12:00:00.000Z';
const LATER = '2026-07-11T12:05:00.000Z';
const TEMP_PATH_PATTERN = /^\/data\/tabs\.json\.tmp\./;

describe('TabStore', () => {
  it('atomically creates one active Terminal 1 only when primary is absent', async () => {
    const fs = new MemoryFileSystem();
    const store = makeStore(fs);

    await store.initialize();

    expect(store.snapshot()).toEqual({
      structureRevision: 0,
      tabs: [
        {
          id: IDS[0],
          displayName: 'Terminal 1',
          position: 0,
          createdAt: NOW,
          lastActivityAt: NOW,
          desiredState: 'active',
        },
      ],
    });
    expect(readDocument(fs).tabs).toHaveLength(1);
  });

  it('restores a valid intentional empty document without recreating a tab', async () => {
    const fs = new MemoryFileSystem({
      '/data/tabs.json': JSON.stringify(document([], 8)),
    });
    const store = makeStore(fs);

    await store.initialize();

    expect(store.snapshot()).toEqual({ structureRevision: 8, tabs: [] });
    expect(fs.operations).not.toContainEqual(expect.stringMatching(/^rename /));
  });

  it('rejects a valid document that exceeds the configured session limit', async () => {
    const first = record(IDS[0], 0, 'First');
    const second = record(IDS[1], 1, 'Second');
    const fs = new MemoryFileSystem({
      '/data/tabs.json': JSON.stringify(document([first, second], 2)),
    });

    await expect(makeStore(fs, { maxCount: 1 }).initialize()).rejects.toThrow(
      'Invalid tab store document',
    );

    expect(readDocument(fs).tabs).toHaveLength(2);
  });

  it('rejects tab metadata containing invalid UTF-8', async () => {
    const bytes = Buffer.from(
      JSON.stringify(document([record(IDS[0], 0, 'X')], 1)),
    );
    const displayNameOffset =
      bytes.indexOf('"displayName":"X"') + Buffer.byteLength('"displayName":"');
    bytes[displayNameOffset] = 0x80;
    const fs = new MemoryFileSystem({ '/data/tabs.json': bytes });

    await expect(makeStore(fs).initialize()).rejects.toThrow(
      'Invalid tab store document',
    );
  });

  it('returns immutable snapshots and records detached from internal state', async () => {
    const store = makeStore(new MemoryFileSystem());
    await store.initialize();

    const snapshot = store.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tabs)).toBe(true);
    expect(Object.isFrozen(snapshot.tabs[0])).toBe(true);
    expect(() => {
      (snapshot.tabs as { displayName: string }[])[0]!.displayName = 'changed';
    }).toThrow();
    expect(store.snapshot().tabs[0]?.displayName).toBe('Terminal 1');
  });

  it('creates generated UUID tabs with normalized or sequential names', async () => {
    const store = makeStore(new MemoryFileSystem());
    await store.initialize();

    const named = await store.create('  Cafe\u0301  ');
    const automatic = await store.create();

    expect(named).toMatchObject({
      id: IDS[2],
      displayName: 'Caf\u00e9',
      position: 1,
    });
    expect(automatic).toMatchObject({
      id: IDS[4],
      displayName: 'Terminal 3',
      position: 2,
    });
    expect(Object.isFrozen(named)).toBe(true);
    expect(store.snapshot().structureRevision).toBe(2);
  });

  it('enforces session capacity with a stable error and no write', async () => {
    const fs = new MemoryFileSystem();
    const store = makeStore(fs, { maxCount: 1 });
    await store.initialize();
    fs.operations.length = 0;

    await expect(store.create()).rejects.toEqual(
      expect.objectContaining({ code: 'session_limit' }),
    );
    await expect(store.create()).rejects.toBeInstanceOf(SessionLimitError);
    expect(fs.operations).toEqual([]);
  });

  it('normalizes rename and reports missing tabs with a stable error', async () => {
    const store = makeStore(new MemoryFileSystem());
    await store.initialize();

    await expect(store.rename(IDS[0], '  Cafe\u0301  ')).resolves.toMatchObject(
      {
        displayName: 'Caf\u00e9',
      },
    );
    await expect(store.rename(IDS[5], 'Missing')).rejects.toBeInstanceOf(
      TabNotFoundError,
    );
    expect(store.snapshot().structureRevision).toBe(1);
  });

  it('reorders only an exact current ID set at the current revision', async () => {
    const store = makeStore(new MemoryFileSystem());
    await store.initialize();
    const second = await store.create('Second');
    const revision = store.snapshot().structureRevision;

    const reordered = await store.reorder(revision, [second.id, IDS[0]]);

    expect(
      reordered.tabs.map(({ id, position }) => ({ id, position })),
    ).toEqual([
      { id: second.id, position: 0 },
      { id: IDS[0], position: 1 },
    ]);
    await expect(store.reorder(revision, [IDS[0], second.id])).rejects.toEqual(
      expect.objectContaining({ code: 'order_conflict' }),
    );
    await expect(
      store.reorder(reordered.structureRevision, [IDS[0], IDS[0]]),
    ).rejects.toBeInstanceOf(OrderConflictError);
  });

  it('sets desired state, removes tabs, and keeps positions contiguous', async () => {
    const store = makeStore(new MemoryFileSystem());
    await store.initialize();
    const second = await store.create('Second');
    const third = await store.create('Third');

    await expect(
      store.setDesiredState(second.id, 'stopped'),
    ).resolves.toMatchObject({
      desiredState: 'stopped',
    });
    await store.remove(second.id);

    expect(store.has(second.id)).toBe(false);
    expect(
      store.snapshot().tabs.map(({ id, position }) => ({ id, position })),
    ).toEqual([
      { id: IDS[0], position: 0 },
      { id: third.id, position: 1 },
    ]);
    await expect(store.remove(second.id)).rejects.toBeInstanceOf(
      TabNotFoundError,
    );
  });

  it('flushes activity without changing structure revision and ignores deleted IDs', async () => {
    const fs = new MemoryFileSystem();
    const store = makeStore(fs);
    await store.initialize();
    const revision = store.snapshot().structureRevision;

    await store.flushActivity(new Set([IDS[0], IDS[5]]), LATER);

    expect(store.snapshot()).toMatchObject({
      structureRevision: revision,
      tabs: [{ lastActivityAt: LATER }],
    });
    fs.operations.length = 0;
    await store.flushActivity(new Set([IDS[5]]), LATER);
    expect(fs.operations).toEqual([]);
  });

  it('serializes concurrent mutations and derives each from queued current state', async () => {
    const fs = new MemoryFileSystem();
    const store = makeStore(fs);
    await store.initialize();
    fs.pauseNextWrite();

    const first = store.create('Second');
    const second = store.rename(IDS[0], 'Primary');
    await fs.writeStarted;
    expect(store.snapshot().tabs).toHaveLength(1);
    fs.resumeWrite();
    await Promise.all([first, second]);

    expect(store.snapshot()).toMatchObject({
      structureRevision: 2,
      tabs: [{ displayName: 'Primary' }, { displayName: 'Second' }],
    });
  });

  it.each([
    ['symlink', { kind: 'symlink' as const, content: '{}' }],
    ['non-regular', { kind: 'directory' as const, content: '' }],
    ['malformed JSON', { kind: 'file' as const, content: '{bad' }],
    [
      'unsupported version',
      {
        kind: 'file' as const,
        content: JSON.stringify({ ...document([]), formatVersion: 2 }),
      },
    ],
    [
      'oversized primary',
      { kind: 'file' as const, content: 'x'.repeat(65_537) },
    ],
  ])(
    'rejects %s primary without overwriting or cleaning temp files',
    async (_name, entry) => {
      const temp = '/data/tabs.json.tmp.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const fs = new MemoryFileSystem({
        '/data/tabs.json': entry,
        [temp]: 'orphan',
      });
      const original = fs.entry('/data/tabs.json');

      await expect(makeStore(fs).initialize()).rejects.toThrow();

      expect(fs.entry('/data/tabs.json')).toEqual(original);
      expect(fs.entry(temp)).toBeDefined();
      expect(
        fs.operations.some((operation) => operation.startsWith('rename ')),
      ).toBe(false);
    },
  );

  it('cleans only regular well-formed app temp files after successful startup', async () => {
    const valid = '/data/tabs.json.tmp.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const symlink = '/data/tabs.json.tmp.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const unrelated = '/data/tabs.json.tmp.notes';
    const fs = new MemoryFileSystem({
      '/data/tabs.json': JSON.stringify(document([])),
      [valid]: 'old',
      [symlink]: { kind: 'symlink', content: 'elsewhere' },
      [unrelated]: 'keep',
    });

    await makeStore(fs).initialize();

    expect(fs.entry(valid)).toBeUndefined();
    expect(fs.entry(symlink)).toBeDefined();
    expect(fs.entry(unrelated)).toBeDefined();
  });

  it('does not fail valid startup when best-effort temp cleanup fails', async () => {
    const temp = '/data/tabs.json.tmp.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fs = new MemoryFileSystem({
      '/data/tabs.json': JSON.stringify(document([])),
      [temp]: 'old',
    });
    fs.failNext = 'unlink';
    const store = makeStore(fs);

    await expect(store.initialize()).resolves.toBeUndefined();

    expect(store.snapshot()).toEqual({ structureRevision: 0, tabs: [] });
    expect(fs.entry(temp)).toBeDefined();
  });

  it('uses unique same-directory mode 0600 temps in exact atomic order', async () => {
    const fs = new MemoryFileSystem();
    const store = makeStore(fs);
    await store.initialize();
    fs.operations.length = 0;

    await store.rename(IDS[0], 'One');
    await store.rename(IDS[0], 'Two');

    const opens = fs.operations.filter((operation) =>
      operation.startsWith('open-wx '),
    );
    expect(opens).toHaveLength(2);
    expect(new Set(opens).size).toBe(2);
    expect(opens.every((operation) => operation.includes(' mode=384'))).toBe(
      true,
    );
    expect(fs.operations.slice(0, 8)).toEqual([
      expect.stringMatching(/^open-wx \/data\/tabs\.json\.tmp\./),
      expect.stringMatching(/^write \/data\/tabs\.json\.tmp\./),
      expect.stringMatching(/^file-sync \/data\/tabs\.json\.tmp\./),
      expect.stringMatching(/^close \/data\/tabs\.json\.tmp\./),
      expect.stringMatching(
        /^rename \/data\/tabs\.json\.tmp\..* -> \/data\/tabs\.json$/,
      ),
      'open-dir /data',
      'dir-sync /data',
      'close-dir /data',
    ]);
  });

  it('retries a colliding temp name without deleting the existing file', async () => {
    const fs = new MemoryFileSystem();
    const store = makeStore(fs);
    await store.initialize();
    fs.collideNextOpen = true;

    await store.rename(IDS[0], 'Retried');

    expect(store.snapshot().tabs[0]?.displayName).toBe('Retried');
    expect(fs.collisionPath).toBeDefined();
    expect(fs.entry(fs.collisionPath!)).toEqual({
      kind: 'file',
      content: 'owned',
    });
    expect(fs.operations).not.toContain(`unlink ${fs.collisionPath}`);
  });

  it.each(['open-wx', 'write', 'file-sync', 'close', 'rename'] as const)(
    'keeps prior memory and disk after pre-commit %s failure',
    async (phase) => {
      const fs = new MemoryFileSystem();
      const store = makeStore(fs);
      await store.initialize();
      const beforeMemory = store.snapshot();
      const beforeDisk = fs.entry('/data/tabs.json');
      fs.failNext = phase;

      await expect(store.rename(IDS[0], 'Changed')).rejects.toThrow(
        `${phase} failed`,
      );

      expect(store.snapshot()).toEqual(beforeMemory);
      expect(fs.entry('/data/tabs.json')).toEqual(beforeDisk);
      expect(fs.paths()).not.toEqual(
        expect.arrayContaining([expect.stringMatching(TEMP_PATH_PATTERN)]),
      );
    },
  );

  it('commits after rename, emits one bounded durability event, and later recovers', async () => {
    const fs = new MemoryFileSystem();
    const onDurabilityEvent = vi.fn();
    const store = makeStore(fs, { onDurabilityEvent });
    await store.initialize();
    fs.failNext = 'dir-sync';

    await expect(store.rename(IDS[0], 'Committed')).resolves.toMatchObject({
      displayName: 'Committed',
    });

    expect(store.snapshot().tabs[0]?.displayName).toBe('Committed');
    expect(readDocument(fs).tabs[0]?.displayName).toBe('Committed');
    expect(store.durabilityReady()).toBe(false);
    expect(onDurabilityEvent).toHaveBeenCalledOnce();
    expect(onDurabilityEvent).toHaveBeenCalledWith({
      type: 'tab_store_durability_degraded',
    });
    expect(JSON.stringify(onDurabilityEvent.mock.calls)).not.toContain('/data');
    expect(JSON.stringify(onDurabilityEvent.mock.calls)).not.toContain(
      'Committed',
    );

    await store.rename(IDS[0], 'Durable');
    expect(store.durabilityReady()).toBe(true);
    expect(onDurabilityEvent).toHaveBeenCalledOnce();
  });

  it('preserves a directory sync failure when closing the directory also fails', async () => {
    const fs = new MemoryFileSystem();
    const onDurabilityEvent = vi.fn();
    const store = makeStore(fs, { onDurabilityEvent });
    await store.initialize();
    fs.failNext = 'dir-sync';
    fs.directoryCloseError = nodeError('EINVAL');

    await expect(store.rename(IDS[0], 'Committed')).resolves.toMatchObject({
      displayName: 'Committed',
    });

    expect(store.durabilityReady()).toBe(false);
    expect(onDurabilityEvent).toHaveBeenCalledOnce();
  });
});

function document(tabs: unknown[], structureRevision = 0) {
  return { formatVersion: 1, structureRevision, tabs };
}

function record(id: string, position: number, displayName: string) {
  return {
    id,
    displayName,
    position,
    createdAt: NOW,
    lastActivityAt: NOW,
    desiredState: 'active',
  };
}

function makeStore(
  fileSystem: MemoryFileSystem,
  options: {
    maxCount?: number;
    onDurabilityEvent?: (event: unknown) => void;
  } = {},
) {
  let index = 0;
  return new TabStore({
    dataDir: '/data',
    sessionMaxCount: options.maxCount ?? 10,
    fileSystem,
    randomUUID: () => IDS[index++ % IDS.length]!,
    now: () => NOW,
    ...(options.onDurabilityEvent
      ? { onDurabilityEvent: options.onDurabilityEvent }
      : {}),
  });
}

function readDocument(fs: MemoryFileSystem) {
  const entry = fs.entry('/data/tabs.json');
  if (!entry || entry.kind !== 'file') throw new Error('primary missing');
  return JSON.parse(Buffer.from(entry.content).toString()) as {
    tabs: { displayName: string }[];
  };
}

type Entry = {
  kind: 'file' | 'symlink' | 'directory';
  content: string | Uint8Array;
};
type InitialEntry = string | Uint8Array | Entry;

class MemoryFileSystem implements TabStoreFileSystem {
  readonly operations: string[] = [];
  collideNextOpen = false;
  collisionPath: string | undefined;
  directoryCloseError: Error | undefined;
  failNext:
    | 'open-wx'
    | 'write'
    | 'file-sync'
    | 'close'
    | 'rename'
    | 'dir-sync'
    | 'unlink'
    | undefined;
  writeStarted: Promise<void> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private releaseWrite: (() => void) | undefined;
  private markWriteStarted: (() => void) | undefined;
  private pauseWrite = false;

  constructor(initial: Record<string, InitialEntry> = {}) {
    this.entries.set('/data', { kind: 'directory', content: '' });
    for (const [path, value] of Object.entries(initial)) {
      this.entries.set(
        path,
        typeof value === 'string' || value instanceof Uint8Array
          ? { kind: 'file', content: value }
          : { ...value },
      );
    }
  }

  entry(path: string): Entry | undefined {
    const entry = this.entries.get(path);
    return entry ? { ...entry } : undefined;
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  pauseNextWrite(): void {
    this.pauseWrite = true;
    this.writeStarted = new Promise((resolve) => {
      this.markWriteStarted = resolve;
    });
  }

  resumeWrite(): void {
    this.releaseWrite?.();
  }

  async mkdir(path: string): Promise<void> {
    this.entries.set(path, { kind: 'directory', content: '' });
  }

  async lstat(path: string) {
    const entry = this.entries.get(path);
    if (!entry) throw nodeError('ENOENT');
    return {
      size: Buffer.byteLength(entry.content),
      isFile: () => entry.kind === 'file',
      isSymbolicLink: () => entry.kind === 'symlink',
    };
  }

  async readFile(path: string): Promise<Buffer> {
    const entry = this.entries.get(path);
    if (!entry || entry.kind !== 'file') throw nodeError('ENOENT');
    return Buffer.from(entry.content);
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.entries.keys()]
      .filter((candidate) => posix.dirname(candidate) === path)
      .map((candidate) => posix.basename(candidate));
  }

  async unlink(path: string): Promise<void> {
    this.operations.push(`unlink ${path}`);
    if (this.failNext === 'unlink') {
      this.failNext = undefined;
      throw new Error('unlink failed');
    }
    this.entries.delete(path);
  }

  async open(
    path: string,
    flags: 'wx' | 'r',
    mode?: number,
  ): Promise<TabStoreFileHandle> {
    if (flags === 'r') {
      this.operations.push(`open-dir ${path}`);
      return {
        writeFile: async () => undefined,
        sync: async () => {
          this.operations.push(`dir-sync ${path}`);
          if (this.failNext === 'dir-sync') {
            this.failNext = undefined;
            throw new Error('dir-sync failed');
          }
        },
        close: async () => {
          this.operations.push(`close-dir ${path}`);
          if (this.directoryCloseError) throw this.directoryCloseError;
        },
      };
    }
    if (this.collideNextOpen) {
      this.collideNextOpen = false;
      this.collisionPath = path;
      this.entries.set(path, { kind: 'file', content: 'owned' });
      throw nodeError('EEXIST');
    }
    if (this.entries.has(path)) throw nodeError('EEXIST');
    this.operations.push(`open-wx ${path} mode=${mode}`);
    if (this.failNext === 'open-wx') {
      this.failNext = undefined;
      throw new Error('open-wx failed');
    }
    this.entries.set(path, { kind: 'file', content: '' });
    return {
      writeFile: async (data) => {
        this.operations.push(`write ${path}`);
        this.markWriteStarted?.();
        this.markWriteStarted = undefined;
        if (this.pauseWrite) {
          this.pauseWrite = false;
          await new Promise<void>((resolve) => {
            this.releaseWrite = resolve;
          });
          this.releaseWrite = undefined;
        }
        if (this.failNext === 'write') {
          this.failNext = undefined;
          throw new Error('write failed');
        }
        const entry = this.entries.get(path);
        if (entry)
          entry.content =
            typeof data === 'string' ? data : Buffer.from(data).toString();
      },
      sync: async () => {
        this.operations.push(`file-sync ${path}`);
        if (this.failNext === 'file-sync') {
          this.failNext = undefined;
          throw new Error('file-sync failed');
        }
      },
      close: async () => {
        this.operations.push(`close ${path}`);
        if (this.failNext === 'close') {
          this.failNext = undefined;
          throw new Error('close failed');
        }
      },
    };
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push(`rename ${from} -> ${to}`);
    if (this.failNext === 'rename') {
      this.failNext = undefined;
      throw new Error('rename failed');
    }
    const entry = this.entries.get(from);
    if (!entry) throw nodeError('ENOENT');
    this.entries.set(to, entry);
    this.entries.delete(from);
  }
}

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
