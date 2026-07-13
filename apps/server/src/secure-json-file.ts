import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

const TEMP_OPEN_ATTEMPTS = 8;
const GENERIC_ERROR_MESSAGE = 'Secure JSON file operation failed';
const MAX_SERIALIZATION_DEPTH = 256;
const MAX_SERIALIZATION_KEYS = 100_000;
const MAX_SERIALIZATION_NODES = 100_000;
export const MAX_SECURE_JSON_BYTES = 1_048_576;

export type ReplaceResult =
  | Readonly<{ state: 'not_committed' }>
  | Readonly<{ state: 'committed' }>
  | Readonly<{ state: 'committed_durability_uncertain' }>;

export interface SecureJsonFile {
  read(path: string, maximumBytes: number): Promise<unknown | undefined>;
  replace(path: string, value: unknown, mode: 0o600): Promise<ReplaceResult>;
  syncParent(path: string): Promise<boolean>;
}

export interface SecureJsonFileStat {
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface SecureJsonFileHandle {
  stat(): Promise<SecureJsonFileStat>;
  chmod(mode: number): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SecureJsonFileSystem {
  open(
    path: string,
    flags: number,
    mode?: number,
  ): Promise<SecureJsonFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export type SecureJsonFileOptions = Readonly<{
  fileSystem?: SecureJsonFileSystem;
  runtimeUid?: number;
  randomName?: () => string;
}>;

export class SecureJsonFileError extends Error {
  constructor() {
    super(GENERIC_ERROR_MESSAGE);
    this.name = 'SecureJsonFileError';
  }
}

const nodeFileSystem: SecureJsonFileSystem = {
  open: (path, flags, mode) => fs.open(path, flags, mode),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
};

export function createSecureJsonFile(
  options: SecureJsonFileOptions = {},
): SecureJsonFile {
  const runtimeUid = options.runtimeUid ?? process.getuid?.();
  if (
    runtimeUid === undefined ||
    !Number.isInteger(runtimeUid) ||
    runtimeUid < 0
  ) {
    throw new SecureJsonFileError();
  }
  return new SecureJsonFileService(
    options.fileSystem ?? nodeFileSystem,
    runtimeUid,
    options.randomName ?? randomUUID,
  );
}

class SecureJsonFileService implements SecureJsonFile {
  constructor(
    private readonly fileSystem: SecureJsonFileSystem,
    private readonly runtimeUid: number,
    private readonly randomName: () => string,
  ) {}

  async read(path: string, maximumBytes: number): Promise<unknown | undefined> {
    try {
      validatePath(path);
      if (
        !Number.isInteger(maximumBytes) ||
        maximumBytes < 1 ||
        maximumBytes > MAX_SECURE_JSON_BYTES
      ) {
        throw new Error('invalid maximum');
      }
      await this.validateAndCloseParent(path);

      let handle: SecureJsonFileHandle;
      try {
        handle = await this.fileSystem.open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw error;
      }

      let value: unknown;
      let failed = false;
      try {
        const stat = await handle.stat();
        validateTargetStat(stat, this.runtimeUid);
        if (stat.size > maximumBytes) throw new Error('oversized');
        const bytes = await readBounded(handle, maximumBytes);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        value = JSON.parse(text) as unknown;
      } catch {
        failed = true;
      }
      try {
        await handle.close();
      } catch {
        failed = true;
      }
      if (failed) throw new Error('read failed');
      return deepFreeze(structuredClone(value));
    } catch {
      throw new SecureJsonFileError();
    }
  }

  async replace(
    path: string,
    value: unknown,
    mode: 0o600,
  ): Promise<ReplaceResult> {
    let bytes: Uint8Array;
    try {
      validatePath(path);
      if (mode !== 0o600) throw new Error('invalid mode');
      bytes = serializeJson(value);
    } catch {
      throw new SecureJsonFileError();
    }

    let parent: SecureJsonFileHandle | undefined;
    try {
      parent = await this.openValidatedParent(path);
      await this.validateExistingTarget(path);
    } catch {
      await parent?.close().catch(() => undefined);
      throw new SecureJsonFileError();
    }

    let tempPath = '';
    let temp: SecureJsonFileHandle | undefined;
    let ownsTemp = false;
    try {
      for (let attempt = 0; attempt < TEMP_OPEN_ATTEMPTS; attempt += 1) {
        tempPath = join(
          dirname(path),
          `.${basename(path)}.secure-json-${this.randomName()}.tmp`,
        );
        try {
          temp = await this.fileSystem.open(
            tempPath,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              constants.O_NOFOLLOW,
            0o600,
          );
          ownsTemp = true;
          break;
        } catch (error) {
          if (!isErrorCode(error, 'EEXIST')) throw error;
        }
      }
      if (!temp) throw new Error('temp allocation failed');
      await temp.chmod(0o600);
      validateTempStat(await temp.stat(), this.runtimeUid);
      await writeAll(temp, bytes);
      await temp.sync();
      await temp.close();
      temp = undefined;

      await this.validateExistingTarget(path);
      await this.fileSystem.rename(tempPath, path);
      ownsTemp = false;
    } catch (error) {
      let cleanupFailed = false;
      if (temp) {
        try {
          await temp.close();
        } catch {
          cleanupFailed = true;
        }
      }
      if (ownsTemp) {
        try {
          await this.fileSystem.unlink(tempPath);
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await parent.close();
      } catch {
        cleanupFailed = true;
      }
      if (error instanceof SecurityValidationError || cleanupFailed) {
        throw new SecureJsonFileError();
      }
      return Object.freeze({ state: 'not_committed' });
    }

    let durable = true;
    try {
      await parent.sync();
    } catch {
      durable = false;
    }
    try {
      await parent.close();
    } catch {
      durable = false;
    }
    return Object.freeze({
      state: durable ? 'committed' : 'committed_durability_uncertain',
    });
  }

  async syncParent(path: string): Promise<boolean> {
    let parent: SecureJsonFileHandle | undefined;
    let successful = true;
    try {
      validatePath(path);
      parent = await this.openValidatedParent(path);
      await parent.sync();
    } catch {
      successful = false;
    }
    try {
      await parent?.close();
    } catch {
      successful = false;
    }
    return successful && parent !== undefined;
  }

  private async validateAndCloseParent(path: string): Promise<void> {
    let parent: SecureJsonFileHandle | undefined;
    let failed = false;
    try {
      parent = await this.openValidatedParent(path);
    } catch {
      failed = true;
    }
    try {
      await parent?.close();
    } catch {
      failed = true;
    }
    if (failed || !parent) throw new Error('invalid parent');
  }

  private async openValidatedParent(
    path: string,
  ): Promise<SecureJsonFileHandle> {
    let handle: SecureJsonFileHandle | undefined;
    try {
      handle = await this.fileSystem.open(
        dirname(path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      const stat = await handle.stat();
      if (
        !stat.isDirectory() ||
        stat.uid !== this.runtimeUid ||
        (stat.mode & 0o022) !== 0
      ) {
        throw new Error('unsafe parent');
      }
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private async validateExistingTarget(path: string): Promise<void> {
    let handle: SecureJsonFileHandle | undefined;
    try {
      handle = await this.fileSystem.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return;
      if (isErrorCode(error, 'ELOOP')) throw new SecurityValidationError();
      throw error;
    }

    let failure: unknown;
    try {
      validateTargetStat(await handle.stat(), this.runtimeUid);
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
}

class SecurityValidationError extends Error {}

function validatePath(path: string): void {
  if (!isAbsolute(path) || basename(path) === '')
    throw new Error('invalid path');
}

function validateTargetStat(
  stat: SecureJsonFileStat,
  runtimeUid: number,
): void {
  if (!stat.isFile() || stat.uid !== runtimeUid || (stat.mode & 0o7177) !== 0) {
    throw new SecurityValidationError();
  }
}

function validateTempStat(stat: SecureJsonFileStat, runtimeUid: number): void {
  if (
    !stat.isFile() ||
    stat.uid !== runtimeUid ||
    (stat.mode & 0o7777) !== 0o600
  ) {
    throw new Error('invalid temp');
  }
}

async function readBounded(
  handle: SecureJsonFileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesRead === 0) break;
    if (bytesRead < 0 || bytesRead > buffer.byteLength - offset) {
      throw new Error('invalid read');
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error('oversized');
  return buffer.subarray(0, offset);
}

async function writeAll(
  handle: SecureJsonFileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw new Error('invalid write');
    }
    offset += bytesWritten;
  }
}

function serializeJson(value: unknown): Uint8Array {
  const snapshot = preflightJson(value);
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) throw new Error('invalid JSON');
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > MAX_SECURE_JSON_BYTES) {
    throw new Error('oversized JSON');
  }
  return bytes;
}

type JsonContainer = unknown[] | Record<string, unknown>;

type PreflightWork =
  | Readonly<{
      kind: 'value';
      value: unknown;
      parent?: JsonContainer;
      key?: string | number;
      depth: number;
    }>
  | Readonly<{ kind: 'exit'; value: object }>;

function preflightJson(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const work: PreflightWork[] = [{ kind: 'value', value, depth: 0 }];
  let byteCount = 0;
  let keyCount = 0;
  let nodeCount = 0;
  let snapshot: unknown;

  const addBytes = (amount: number): void => {
    byteCount += amount;
    if (byteCount > MAX_SECURE_JSON_BYTES) throw new Error('oversized JSON');
  };

  const assign = (
    item: Extract<PreflightWork, { kind: 'value' }>,
    next: unknown,
  ) => {
    if (!item.parent) {
      snapshot = next;
    } else if (Array.isArray(item.parent)) {
      item.parent[item.key as number] = next;
    } else {
      Object.defineProperty(item.parent, item.key as string, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  };

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === 'exit') {
      ancestors.delete(item.value);
      continue;
    }
    nodeCount += 1;
    if (
      nodeCount > MAX_SERIALIZATION_NODES ||
      item.depth > MAX_SERIALIZATION_DEPTH
    ) {
      throw new Error('JSON complexity limit');
    }

    if (item.value === null) {
      addBytes(4);
      assign(item, null);
      continue;
    }
    if (typeof item.value === 'string') {
      addBytes(jsonStringByteLength(item.value));
      assign(item, item.value);
      continue;
    }
    if (typeof item.value === 'boolean') {
      addBytes(item.value ? 4 : 5);
      assign(item, item.value);
      continue;
    }
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) throw new Error('invalid number');
      addBytes(String(Object.is(item.value, -0) ? 0 : item.value).length);
      assign(item, item.value);
      continue;
    }
    if (typeof item.value !== 'object') throw new Error('invalid JSON value');
    if (ancestors.has(item.value)) throw new Error('circular JSON');
    ancestors.add(item.value);
    work.push({ kind: 'exit', value: item.value });

    const ownKeys = Reflect.ownKeys(item.value);
    keyCount += ownKeys.length;
    if (keyCount > MAX_SERIALIZATION_KEYS) {
      throw new Error('JSON key limit');
    }

    if (Array.isArray(item.value)) {
      const length = item.value.length;
      if (length > MAX_SERIALIZATION_NODES) throw new Error('array too large');
      const enumerableKeys = ownKeys.filter((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
        return descriptor?.enumerable === true;
      });
      if (
        enumerableKeys.some((key) => typeof key === 'symbol') ||
        enumerableKeys.length !== length
      ) {
        throw new Error('invalid array');
      }

      const clone: unknown[] = new Array(length);
      assign(item, clone);
      addBytes(2 + Math.max(0, length - 1));
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          item.value,
          String(index),
        );
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('invalid array property');
        }
        work.push({
          kind: 'value',
          value: descriptor.value,
          parent: clone,
          key: index,
          depth: item.depth + 1,
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(item.value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('invalid object');
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
      if (!descriptor?.enumerable) continue;
      if (typeof key === 'symbol') throw new Error('invalid symbol key');
      if (!('value' in descriptor)) throw new Error('invalid accessor');
      entries.push([key, descriptor.value]);
    }

    const clone = Object.create(null) as Record<string, unknown>;
    assign(item, clone);
    addBytes(2 + Math.max(0, entries.length - 1));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      addBytes(jsonStringByteLength(key) + 1);
      work.push({
        kind: 'value',
        value: child,
        parent: clone,
        key,
        depth: item.depth + 1,
      });
    }
  }

  return snapshot;
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_SECURE_JSON_BYTES) return bytes;
  }
  return bytes;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
