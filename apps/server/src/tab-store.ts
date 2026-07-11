import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  TAB_DOCUMENT_FORMAT_VERSION,
  desiredStateSchema,
  displayNameSchema,
  persistedTabsDocumentSchema,
  type DesiredState,
  type PersistedTabsDocument,
  type TabCollection,
  type TabRecord,
} from '@flanterminal/shared';

const PRIMARY_FILENAME = 'tabs.json';
const MAX_DOCUMENT_BYTES = 64 * 1024;
const TEMP_FILENAME_PATTERN =
  /^tabs\.json\.tmp\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EINVAL',
  'ENOTSUP',
  'ENOSYS',
]);

export type TabStoreErrorCode =
  | 'not_initialized'
  | 'already_initialized'
  | 'tab_not_found'
  | 'session_limit'
  | 'order_conflict';

export class TabStoreError extends Error {
  constructor(
    readonly code: TabStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class TabNotFoundError extends TabStoreError {
  constructor() {
    super('tab_not_found', 'Tab not found');
  }
}

export class SessionLimitError extends TabStoreError {
  constructor() {
    super('session_limit', 'Session limit reached');
  }
}

export class OrderConflictError extends TabStoreError {
  constructor() {
    super('order_conflict', 'Tab order conflict');
  }
}

export type DurabilityEvent = Readonly<{
  type: 'tab_store_durability_degraded';
}>;

export interface TabStoreFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface TabStoreFileSystem {
  mkdir(path: string, options?: { recursive: boolean }): Promise<unknown>;
  lstat(path: string): Promise<{
    size: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  open(
    path: string,
    flags: 'wx' | 'r',
    mode?: number,
  ): Promise<TabStoreFileHandle>;
  rename(from: string, to: string): Promise<void>;
}

export type TabStoreOptions = Readonly<{
  dataDir: string;
  sessionMaxCount: number;
  fileSystem?: TabStoreFileSystem;
  randomUUID?: () => string;
  now?: () => string;
  onDurabilityEvent?: (event: DurabilityEvent) => void;
}>;

const nodeFileSystem: TabStoreFileSystem = {
  mkdir: (path, options) => fs.mkdir(path, options),
  lstat: (path) => fs.lstat(path),
  readFile: (path) => fs.readFile(path),
  readdir: (path) => fs.readdir(path),
  unlink: (path) => fs.unlink(path),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  rename: (from, to) => fs.rename(from, to),
};

export class TabStore {
  private readonly primaryPath: string;
  private readonly fileSystem: TabStoreFileSystem;
  private readonly randomUUID: () => string;
  private readonly now: () => string;
  private readonly onDurabilityEvent:
    ((event: DurabilityEvent) => void) | undefined;
  private document: PersistedTabsDocument | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private ready = true;

  constructor(private readonly options: TabStoreOptions) {
    this.primaryPath = join(options.dataDir, PRIMARY_FILENAME);
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onDurabilityEvent = options.onDurabilityEvent;
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.document) {
        throw new TabStoreError(
          'already_initialized',
          'Tab store already initialized',
        );
      }
      await this.fileSystem.mkdir(this.options.dataDir, { recursive: true });

      let document: PersistedTabsDocument;
      try {
        document = await this.readPrimary();
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
        const timestamp = this.now();
        document = parseDocument({
          formatVersion: TAB_DOCUMENT_FORMAT_VERSION,
          structureRevision: 0,
          tabs: [
            {
              id: this.randomUUID(),
              displayName: 'Terminal 1',
              position: 0,
              createdAt: timestamp,
              lastActivityAt: timestamp,
              desiredState: 'active',
            },
          ],
        });
        await this.persist(document);
      }

      this.document ??= document;
      await this.cleanupTemps();
    });
  }

  snapshot(): TabCollection {
    const document = this.requireDocument();
    return immutableCopy({
      structureRevision: document.structureRevision,
      tabs: document.tabs,
    });
  }

  has(id: string): boolean {
    return this.requireDocument().tabs.some((tab) => tab.id === id);
  }

  create(name?: string): Promise<TabRecord> {
    return this.mutate(async (current) => {
      if (current.tabs.length >= this.options.sessionMaxCount) {
        throw new SessionLimitError();
      }
      const timestamp = this.now();
      const tab: TabRecord = {
        id: this.randomUUID(),
        displayName:
          name === undefined
            ? `Terminal ${current.tabs.length + 1}`
            : displayNameSchema.parse(name),
        position: current.tabs.length,
        createdAt: timestamp,
        lastActivityAt: timestamp,
        desiredState: 'active',
      };
      return {
        next: structuralDocument(current, [...current.tabs, tab]),
        result: () => findTab(this.requireDocument(), tab.id),
      };
    });
  }

  rename(id: string, name: string): Promise<TabRecord> {
    return this.mutate(async (current) => {
      requireTab(current, id);
      const displayName = displayNameSchema.parse(name);
      return {
        next: structuralDocument(
          current,
          current.tabs.map((tab) =>
            tab.id === id ? { ...tab, displayName } : tab,
          ),
        ),
        result: () => findTab(this.requireDocument(), id),
      };
    });
  }

  reorder(revision: number, ids: readonly string[]): Promise<TabCollection> {
    return this.mutate(async (current) => {
      if (
        revision !== current.structureRevision ||
        ids.length !== current.tabs.length ||
        new Set(ids).size !== current.tabs.length ||
        ids.some((id) => !current.tabs.some((tab) => tab.id === id))
      ) {
        throw new OrderConflictError();
      }
      const byId = new Map(current.tabs.map((tab) => [tab.id, tab]));
      const tabs = ids.map((id, position) => ({ ...byId.get(id)!, position }));
      return {
        next: structuralDocument(current, tabs),
        result: () => this.snapshot(),
      };
    });
  }

  setDesiredState(id: string, state: DesiredState): Promise<TabRecord> {
    return this.mutate(async (current) => {
      requireTab(current, id);
      const desiredState = desiredStateSchema.parse(state);
      return {
        next: structuralDocument(
          current,
          current.tabs.map((tab) =>
            tab.id === id ? { ...tab, desiredState } : tab,
          ),
        ),
        result: () => findTab(this.requireDocument(), id),
      };
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async (current) => {
      requireTab(current, id);
      const tabs = current.tabs
        .filter((tab) => tab.id !== id)
        .map((tab, position) => ({ ...tab, position }));
      return {
        next: structuralDocument(current, tabs),
        result: () => undefined,
      };
    });
  }

  flushActivity(ids: ReadonlySet<string>, now: string): Promise<void> {
    return this.mutate(async (current) => {
      if (!current.tabs.some((tab) => ids.has(tab.id))) return undefined;
      return {
        next: parseDocument({
          ...current,
          tabs: current.tabs.map((tab) =>
            ids.has(tab.id) ? { ...tab, lastActivityAt: now } : tab,
          ),
        }),
        result: () => undefined,
      };
    });
  }

  durabilityReady(): boolean {
    return this.ready;
  }

  private async readPrimary(): Promise<PersistedTabsDocument> {
    const stat = await this.fileSystem.lstat(this.primaryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Invalid tab store document');
    }
    if (stat.size > MAX_DOCUMENT_BYTES) {
      throw new Error('Invalid tab store document');
    }
    const bytes = await this.fileSystem.readFile(this.primaryPath);
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error('Invalid tab store document');
    }
    try {
      const document = parseDocument(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      if (document.tabs.length > this.options.sessionMaxCount) {
        throw new Error('session limit exceeded');
      }
      return document;
    } catch {
      throw new Error('Invalid tab store document');
    }
  }

  private async cleanupTemps(): Promise<void> {
    let names: string[];
    try {
      names = await this.fileSystem.readdir(this.options.dataDir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => TEMP_FILENAME_PATTERN.test(name))
        .map(async (name) => {
          const path = join(this.options.dataDir, name);
          try {
            const stat = await this.fileSystem.lstat(path);
            if (stat.isFile() && !stat.isSymbolicLink())
              await this.fileSystem.unlink(path);
          } catch {
            // Orphan cleanup cannot make a validated primary unavailable.
          }
        }),
    );
  }

  private mutate<T>(
    build: (
      current: PersistedTabsDocument,
    ) => Promise<{ next: PersistedTabsDocument; result: () => T } | undefined>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const mutation = await build(this.requireDocument());
      if (!mutation) return undefined as T;
      await this.persist(mutation.next);
      return mutation.result();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(candidate: PersistedTabsDocument): Promise<void> {
    const next = parseDocument(candidate);
    const serialized = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES) {
      throw new Error('Tab store document exceeds size limit');
    }
    let tempPath = '';
    let handle: TabStoreFileHandle | undefined;
    let ownsTemp = false;
    let renamed = false;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        tempPath = join(
          this.options.dataDir,
          `${PRIMARY_FILENAME}.tmp.${this.randomUUID()}`,
        );
        try {
          handle = await this.fileSystem.open(tempPath, 'wx', 0o600);
          ownsTemp = true;
          break;
        } catch (error) {
          if (!isErrorCode(error, 'EEXIST')) throw error;
        }
      }
      if (!handle)
        throw new Error('Unable to allocate tab store temporary file');
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fileSystem.rename(tempPath, this.primaryPath);
      ownsTemp = false;
      renamed = true;
      this.document = next;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (!renamed && ownsTemp) {
        await this.fileSystem.unlink(tempPath).catch(() => undefined);
      }
      throw error;
    }

    try {
      await this.syncDirectory();
      this.ready = true;
    } catch (error) {
      if (isUnsupportedDirectorySync(error)) {
        this.ready = true;
        return;
      }
      this.ready = false;
      try {
        this.onDurabilityEvent?.(
          Object.freeze({ type: 'tab_store_durability_degraded' }),
        );
      } catch {
        // Observers cannot roll back a committed metadata mutation.
      }
    }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await this.fileSystem.open(this.options.dataDir, 'r');
    let failure: { error: unknown } | undefined;
    try {
      await handle.sync();
    } catch (error) {
      failure = { error };
    }
    try {
      await handle.close();
    } catch (error) {
      failure ??= { error };
    }
    if (failure) throw failure.error;
  }

  private requireDocument(): PersistedTabsDocument {
    if (!this.document) {
      throw new TabStoreError('not_initialized', 'Tab store not initialized');
    }
    return this.document;
  }
}

function structuralDocument(
  current: PersistedTabsDocument,
  tabs: readonly TabRecord[],
): PersistedTabsDocument {
  return parseDocument({
    formatVersion: TAB_DOCUMENT_FORMAT_VERSION,
    structureRevision: current.structureRevision + 1,
    tabs,
  });
}

function parseDocument(value: unknown): PersistedTabsDocument {
  return persistedTabsDocumentSchema.parse(value);
}

function requireTab(document: PersistedTabsDocument, id: string): TabRecord {
  const tab = document.tabs.find((candidate) => candidate.id === id);
  if (!tab) throw new TabNotFoundError();
  return tab;
}

function findTab(document: PersistedTabsDocument, id: string): TabRecord {
  return immutableCopy(requireTab(document, id));
}

function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  return deepFreeze(copy);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    error instanceof Error &&
    UNSUPPORTED_DIRECTORY_SYNC_CODES.has(
      (error as NodeJS.ErrnoException).code ?? '',
    )
  );
}
