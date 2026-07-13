import bcrypt from 'bcrypt';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { inspect } from 'node:util';

import {
  MAX_SECURE_JSON_BYTES,
  type ReplaceResult,
  type SecureJsonFile,
} from './secure-json-file.js';

const AUTH_FILENAME = 'auth.json';
const MAX_BOOTSTRAP_BYTES = 4_096;
const MAX_PASSWORD_BYTES = 72;
const MIN_PASSWORD_BYTES = 12;
const GENERIC_ERROR_MESSAGE = 'Credential store operation failed';
const BCRYPT_PATTERN = /^\$2[aby]\$(1[0-5])\$[./A-Za-z0-9]{53}$/;

export interface PasswordHasher {
  hash(password: string, cost: number): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

export interface BootstrapSecretStat {
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
}

export interface BootstrapSecretHandle {
  stat(): Promise<BootstrapSecretStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface BootstrapSecretFileSystem {
  open(path: string, flags: number): Promise<BootstrapSecretHandle>;
}

export type CredentialStoreOptions = Readonly<{
  dataDir: string;
  secureFile: SecureJsonFile;
  hasher?: PasswordHasher;
  bootstrapFileSystem?: BootstrapSecretFileSystem;
  runtimeUid?: number;
  clock?: () => Date;
}>;

type CredentialRecord = Readonly<{
  version: 1;
  username: string;
  passwordHash: string;
  passwordChangedAt: string;
}>;

const defaultHasher: PasswordHasher = {
  hash: (password, cost) => bcrypt.hash(password, cost),
  compare: (password, hash) => bcrypt.compare(password, hash),
};

const defaultBootstrapFileSystem: BootstrapSecretFileSystem = {
  open: (path, flags) => fs.open(path, flags),
};

export class CredentialStoreError extends Error {
  constructor() {
    super(GENERIC_ERROR_MESSAGE);
    this.name = 'CredentialStoreError';
  }
}

export class CredentialStore {
  private readonly authPath: string;
  private readonly secureFile: SecureJsonFile;
  private readonly hasher: PasswordHasher;
  private readonly bootstrapFileSystem: BootstrapSecretFileSystem;
  private readonly runtimeUid: number;
  private readonly clock: () => Date;
  private operationTail: Promise<void> = Promise.resolve();
  private current: CredentialRecord | undefined;
  private cost = 0;
  private initializeAttempted = false;

  constructor(options: CredentialStoreOptions) {
    try {
      const runtimeUid = options.runtimeUid ?? process.getuid?.();
      if (
        !isAbsolute(options.dataDir) ||
        runtimeUid === undefined ||
        !Number.isInteger(runtimeUid) ||
        runtimeUid < 0
      ) {
        throw new Error('invalid options');
      }
      this.authPath = join(options.dataDir, AUTH_FILENAME);
      this.secureFile = options.secureFile;
      this.hasher = options.hasher ?? defaultHasher;
      this.bootstrapFileSystem =
        options.bootstrapFileSystem ?? defaultBootstrapFileSystem;
      this.runtimeUid = runtimeUid;
      this.clock = options.clock ?? (() => new Date());
    } catch {
      throw new CredentialStoreError();
    }
  }

  initializeLocal(
    username: string,
    passwordFile: string,
    cost: number,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.initializeAttempted) throw new CredentialStoreError();
      this.initializeAttempted = true;
      try {
        const normalizedUsername = normalizeUsername(username);
        validateCost(cost);
        const persisted = await this.secureFile.read(
          this.authPath,
          MAX_SECURE_JSON_BYTES,
        );
        if (persisted !== undefined) {
          const record = parseRecord(persisted);
          if (record.username !== normalizedUsername) {
            throw new Error('username mismatch');
          }
          this.current = record;
          this.cost = cost;
          return;
        }

        if (!isAbsolute(passwordFile)) throw new Error('invalid secret path');
        const password = await this.readBootstrapPassword(passwordFile);
        const passwordHash = await this.hasher.hash(password, cost);
        if (bcryptCost(passwordHash) !== cost) throw new Error('invalid hash');
        const record = makeRecord(
          normalizedUsername,
          passwordHash,
          currentTimestamp(this.clock),
        );
        const result = await this.secureFile.replace(
          this.authPath,
          record,
          0o600,
        );
        if (result.state !== 'committed') throw new Error('not durable');
        this.current = record;
        this.cost = cost;
      } catch {
        throw new CredentialStoreError();
      }
    });
  }

  verify(username: string, password: string): Promise<boolean> {
    if (!this.current) return Promise.reject(new CredentialStoreError());
    if (!isValidPassword(password)) return Promise.resolve(false);
    return this.enqueue(async () => {
      const record = this.requireCurrent();
      let matches: boolean;
      try {
        matches = await this.hasher.compare(password, record.passwordHash);
      } catch {
        throw new CredentialStoreError();
      }
      return matches && username === record.username;
    });
  }

  replacePassword(newPassword: string): Promise<ReplaceResult> {
    if (!this.current) return Promise.reject(new CredentialStoreError());
    if (!isValidPassword(newPassword)) {
      return Promise.reject(new CredentialStoreError());
    }

    return this.enqueue(async () => {
      const prior = this.requireCurrent();
      try {
        const passwordHash = await this.hasher.hash(newPassword, this.cost);
        if (bcryptCost(passwordHash) !== this.cost) {
          throw new Error('invalid hash');
        }
        const next = makeRecord(
          prior.username,
          passwordHash,
          currentTimestamp(this.clock),
        );
        const result = await this.secureFile.replace(
          this.authPath,
          next,
          0o600,
        );
        if (result.state !== 'not_committed') this.current = next;
        return result;
      } catch {
        throw new CredentialStoreError();
      }
    });
  }

  toJSON(): Readonly<{ type: 'CredentialStore' }> {
    return Object.freeze({ type: 'CredentialStore' });
  }

  [inspect.custom](): string {
    return 'CredentialStore {}';
  }

  private requireCurrent(): CredentialRecord {
    if (!this.current) throw new CredentialStoreError();
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

  private async readBootstrapPassword(path: string): Promise<string> {
    let handle: BootstrapSecretHandle | undefined;
    let bytes: Uint8Array | undefined;
    let failed = false;
    try {
      handle = await this.bootstrapFileSystem.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        (stat.uid !== 0 && stat.uid !== this.runtimeUid) ||
        (stat.mode & 0o022) !== 0 ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > MAX_BOOTSTRAP_BYTES
      ) {
        throw new Error('unsafe secret');
      }
      bytes = await readBounded(handle, MAX_BOOTSTRAP_BYTES);
    } catch {
      failed = true;
    }
    try {
      await handle?.close();
    } catch {
      failed = true;
    }
    if (failed || !bytes) throw new Error('secret read failed');
    let password = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (password.endsWith('\r\n')) password = password.slice(0, -2);
    else if (password.endsWith('\n')) password = password.slice(0, -1);
    validatePassword(password);
    return password;
  }
}

async function readBounded(
  handle: BootstrapSecretHandle,
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

function normalizeUsername(username: string): string {
  if (typeof username !== 'string') throw new Error('invalid username');
  const normalized = username.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (
    normalized.length === 0 ||
    normalized !== username ||
    bytes > 256 ||
    hasControlCharacter(normalized)
  ) {
    throw new Error('invalid username');
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validatePassword(password: string): void {
  if (!isValidPassword(password)) throw new Error('invalid password');
}

function isValidPassword(password: string): boolean {
  if (typeof password !== 'string' || password.includes('\0')) return false;
  const bytes = new TextEncoder().encode(password).byteLength;
  return bytes >= MIN_PASSWORD_BYTES && bytes <= MAX_PASSWORD_BYTES;
}

function validateCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < 10 || cost > 15) {
    throw new Error('invalid cost');
  }
}

function bcryptCost(hash: string): number {
  const match = BCRYPT_PATTERN.exec(hash);
  if (!match) throw new Error('invalid bcrypt hash');
  return Number(match[1]);
}

function parseRecord(value: unknown): CredentialRecord {
  if (!isPlainRecord(value)) throw new Error('invalid record');
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !['version', 'username', 'passwordHash', 'passwordChangedAt'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    value.version !== 1 ||
    typeof value.username !== 'string' ||
    normalizeUsername(value.username) !== value.username ||
    typeof value.passwordHash !== 'string' ||
    typeof value.passwordChangedAt !== 'string'
  ) {
    throw new Error('invalid record');
  }
  bcryptCost(value.passwordHash);
  validateTimestamp(value.passwordChangedAt);
  return makeRecord(
    value.username,
    value.passwordHash,
    value.passwordChangedAt,
  );
}

function makeRecord(
  username: string,
  passwordHash: string,
  passwordChangedAt: string,
): CredentialRecord {
  bcryptCost(passwordHash);
  validateTimestamp(passwordChangedAt);
  return Object.freeze({
    version: 1 as const,
    username,
    passwordHash,
    passwordChangedAt,
  });
}

function currentTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid clock');
  }
  return value.toISOString();
}

function validateTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('invalid timestamp');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
