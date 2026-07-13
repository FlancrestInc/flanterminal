import { isAbsolute, join } from 'node:path';

import {
  parseWorkspaceSettings,
  type WorkspaceSettings,
  type WorkspaceSettingsConstraints,
} from '@flanterminal/shared';

import {
  MAX_SECURE_JSON_BYTES,
  type ReplaceResult,
  type SecureJsonFile,
} from './secure-json-file.js';

const SETTINGS_FILENAME = 'settings.json';
const MAX_LISTENERS = 64;
const GENERIC_ERROR_MESSAGE = 'Settings store operation failed';
const DURABILITY_EVENT = Object.freeze({
  type: 'settings_store_durability_degraded' as const,
});

export type SettingsStoreDurabilityEvent = typeof DURABILITY_EVENT;

export type SettingsStoreOptions = Readonly<{
  dataDir: string;
  defaults: WorkspaceSettings;
  constraints: WorkspaceSettingsConstraints;
  secureFile: SecureJsonFile;
  onDurabilityEvent?: (event: SettingsStoreDurabilityEvent) => void;
}>;

export class SettingsStoreError extends Error {
  constructor() {
    super(GENERIC_ERROR_MESSAGE);
    this.name = 'SettingsStoreError';
  }
}

export class SettingsStore {
  private readonly settingsPath: string;
  private readonly defaults: WorkspaceSettings;
  private readonly constraints: WorkspaceSettingsConstraints;
  private readonly secureFile: SecureJsonFile;
  private readonly onDurabilityEvent:
    ((event: SettingsStoreDurabilityEvent) => void) | undefined;
  private readonly listeners = new Set<(settings: WorkspaceSettings) => void>();
  private operationTail: Promise<void> = Promise.resolve();
  private current: WorkspaceSettings | undefined;
  private ready = false;
  private initializeAttempted = false;

  constructor(options: SettingsStoreOptions) {
    try {
      if (typeof options.dataDir !== 'string' || !isAbsolute(options.dataDir)) {
        throw new Error('invalid data directory');
      }
      this.settingsPath = join(options.dataDir, SETTINGS_FILENAME);
      this.defaults = immutableCopy(options.defaults);
      this.constraints = immutableCopy(options.constraints);
      this.secureFile = options.secureFile;
      this.onDurabilityEvent = options.onDurabilityEvent;
    } catch {
      throw new SettingsStoreError();
    }
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initializeAttempted) throw new SettingsStoreError();
      this.initializeAttempted = true;

      try {
        const persisted = await this.secureFile.read(
          this.settingsPath,
          MAX_SECURE_JSON_BYTES,
        );
        if (persisted !== undefined) {
          this.current = parseWorkspaceSettings(persisted, this.constraints);
          this.ready = true;
          return;
        }

        const initial = parseWorkspaceSettings(this.defaults, this.constraints);
        const result = await this.secureFile.replace(
          this.settingsPath,
          initial,
          0o600,
        );
        if (result.state === 'not_committed') throw new Error('not committed');
        this.current = initial;
        this.ready = result.state === 'committed';
        if (!this.ready) this.emitDurabilityEvent();
      } catch {
        throw new SettingsStoreError();
      }
    });
  }

  snapshot(): WorkspaceSettings {
    return this.requireCurrent();
  }

  replace(candidate: unknown): Promise<ReplaceResult> {
    if (!this.current) return Promise.reject(new SettingsStoreError());

    let next: WorkspaceSettings;
    try {
      next = parseWorkspaceSettings(candidate, this.constraints);
    } catch {
      return Promise.reject(new SettingsStoreError());
    }

    return this.enqueue(async () => {
      this.requireCurrent();
      let result: ReplaceResult;
      try {
        result = await this.secureFile.replace(this.settingsPath, next, 0o600);
      } catch {
        throw new SettingsStoreError();
      }

      if (result.state === 'not_committed') return result;
      this.current = next;
      this.ready = result.state === 'committed';
      if (!this.ready) this.emitDurabilityEvent();
      this.notify(next);
      return result;
    });
  }

  durabilityReady(): boolean {
    this.requireCurrent();
    return this.ready;
  }

  retryDurability(): Promise<boolean> {
    if (!this.current) return Promise.reject(new SettingsStoreError());

    return this.enqueue(async () => {
      this.requireCurrent();
      if (this.ready) return true;

      let synced: boolean;
      try {
        synced = await this.secureFile.syncParent(this.settingsPath);
      } catch {
        synced = false;
      }
      if (synced) this.ready = true;
      return synced;
    });
  }

  subscribe(listener: (settings: WorkspaceSettings) => void): () => void {
    if (
      typeof listener !== 'function' ||
      this.listeners.size >= MAX_LISTENERS
    ) {
      throw new SettingsStoreError();
    }
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  private requireCurrent(): WorkspaceSettings {
    if (!this.current) throw new SettingsStoreError();
    return this.current;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private notify(settings: WorkspaceSettings): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(settings);
      } catch {
        // Observers cannot affect the authoritative commit state.
      }
    }
  }

  private emitDurabilityEvent(): void {
    try {
      this.onDurabilityEvent?.(DURABILITY_EVENT);
    } catch {
      // Telemetry cannot affect the authoritative commit state.
    }
  }
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
