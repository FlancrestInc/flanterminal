import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

const TEMP_OPEN_ATTEMPTS = 8;
const GENERIC_ERROR_MESSAGE = 'Secure JSON file operation failed';
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
      await writeAll(temp, bytes);
      await temp.sync();
      await temp.close();
      temp = undefined;

      await this.validateExistingTarget(path);
      await this.fileSystem.rename(tempPath, path);
      ownsTemp = false;
    } catch (error) {
      if (temp) await temp.close().catch(() => undefined);
      if (ownsTemp)
        await this.fileSystem.unlink(tempPath).catch(() => undefined);
      await parent.close().catch(() => undefined);
      if (error instanceof SecurityValidationError) {
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
  validateJsonValue(value, new WeakSet<object>());
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('invalid JSON');
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > MAX_SECURE_JSON_BYTES) {
    throw new Error('oversized JSON');
  }
  return bytes;
}

function validateJsonValue(value: unknown, ancestors: WeakSet<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid number');
    return;
  }
  if (typeof value !== 'object') throw new Error('invalid JSON value');
  if (ancestors.has(value)) throw new Error('circular JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.keys(value).length !== value.length
      ) {
        throw new Error('invalid array');
      }
      for (const child of value) validateJsonValue(child, ancestors);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('invalid object');
    }
    const names = Object.getOwnPropertyNames(value);
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      names.length !== Object.keys(value).length
    ) {
      throw new Error('invalid object properties');
    }
    for (const child of Object.values(value)) {
      validateJsonValue(child, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
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
