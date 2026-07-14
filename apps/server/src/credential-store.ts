import bcrypt from 'bcrypt';
import { isAbsolute, join } from 'node:path';
import { inspect } from 'node:util';

import {
  MAX_SECURE_JSON_BYTES,
  type ReplaceResult,
  type SecureJsonFile,
} from './secure-json-file.js';

const AUTH_FILENAME = 'auth.json';
const MAX_PASSWORD_BYTES = 72;
const MIN_PASSWORD_BYTES = 12;
const GENERIC_ERROR_MESSAGE = 'Credential store operation failed';
const BCRYPT_PATTERN = /^\$2[ab]\$(1[0-5])\$[./A-Za-z0-9]{53}$/;

export interface PasswordHasher {
  hash(password: string, cost: number): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

export type CredentialStoreOptions = Readonly<{
  dataDir: string;
  secureFile: SecureJsonFile;
  hasher?: PasswordHasher;
  clock?: () => Date;
}>;

export type EnrollmentResult =
  | Readonly<{
      outcome: 'enrolled';
      persistence: 'committed' | 'committed_durability_uncertain';
    }>
  | Readonly<{ outcome: 'already_initialized' }>
  | Readonly<{ outcome: 'not_committed' }>;

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

const ALREADY_INITIALIZED_RESULT: EnrollmentResult = Object.freeze({
  outcome: 'already_initialized',
});
const NOT_COMMITTED_RESULT: EnrollmentResult = Object.freeze({
  outcome: 'not_committed',
});

export class CredentialStoreError extends Error {
  constructor() {
    super(GENERIC_ERROR_MESSAGE);
    this.name = 'CredentialStoreError';
  }
}

export class CredentialStore {
  readonly #authPath: string;
  readonly #secureFile: SecureJsonFile;
  readonly #hasher: PasswordHasher;
  readonly #clock: () => Date;
  #operationTail: Promise<void> = Promise.resolve();
  #current: CredentialRecord | undefined;
  #username = '';
  #cost = 0;
  #initializeAttempted = false;
  #initializationComplete = false;

  constructor(options: CredentialStoreOptions) {
    try {
      if (!isAbsolute(options.dataDir)) throw new Error('invalid options');
      this.#authPath = join(options.dataDir, AUTH_FILENAME);
      this.#secureFile = options.secureFile;
      this.#hasher = options.hasher ?? defaultHasher;
      this.#clock = options.clock ?? (() => new Date());
    } catch {
      throw new CredentialStoreError();
    }
  }

  initializeLocal(username: string, cost: number): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#initializeAttempted) throw new CredentialStoreError();
      this.#initializeAttempted = true;
      try {
        const normalizedUsername = normalizeUsername(username);
        validateCost(cost);
        const persisted = await this.#secureFile.read(
          this.#authPath,
          MAX_SECURE_JSON_BYTES,
        );
        if (persisted !== undefined) {
          const record = parseRecord(persisted);
          if (record.username !== normalizedUsername) {
            throw new Error('username mismatch');
          }
          this.#current = record;
        }
        this.#username = normalizedUsername;
        this.#cost = cost;
        this.#initializationComplete = true;
      } catch {
        throw new CredentialStoreError();
      }
    });
  }

  isInitialized(): boolean {
    if (!this.#initializationComplete) throw new CredentialStoreError();
    return this.#current !== undefined;
  }

  enroll(password: string): Promise<EnrollmentResult> {
    if (!this.#initializationComplete) {
      return Promise.reject(new CredentialStoreError());
    }
    return this.#enqueue(async () => {
      if (!this.#initializationComplete) throw new CredentialStoreError();
      if (this.#current) return ALREADY_INITIALIZED_RESULT;
      try {
        validatePassword(password);
        const passwordHash = await this.#hasher.hash(password, this.#cost);
        if (bcryptCost(passwordHash) !== this.#cost) {
          throw new Error('invalid hash');
        }
        const next = makeRecord(
          this.#username,
          passwordHash,
          currentTimestamp(this.#clock),
        );
        const result = await this.#secureFile.replace(
          this.#authPath,
          next,
          0o600,
        );
        if (result.state === 'not_committed') return NOT_COMMITTED_RESULT;
        this.#current = next;
        return Object.freeze({
          outcome: 'enrolled',
          persistence: result.state,
        });
      } catch {
        throw new CredentialStoreError();
      }
    });
  }

  verify(username: string, password: string): Promise<boolean> {
    if (!this.#current) return Promise.reject(new CredentialStoreError());
    if (!isValidPassword(password)) return Promise.resolve(false);
    return this.#enqueue(async () => {
      const record = this.#requireCurrent();
      let matches: boolean;
      try {
        matches = await this.#hasher.compare(password, record.passwordHash);
      } catch {
        throw new CredentialStoreError();
      }
      return matches && username === record.username;
    });
  }

  replacePassword(newPassword: string): Promise<ReplaceResult> {
    if (!this.#current) return Promise.reject(new CredentialStoreError());
    if (!isValidPassword(newPassword)) {
      return Promise.reject(new CredentialStoreError());
    }

    return this.#enqueue(async () => {
      const prior = this.#requireCurrent();
      try {
        const passwordHash = await this.#hasher.hash(newPassword, this.#cost);
        if (bcryptCost(passwordHash) !== this.#cost) {
          throw new Error('invalid hash');
        }
        const next = makeRecord(
          prior.username,
          passwordHash,
          currentTimestamp(this.#clock),
        );
        const result = await this.#secureFile.replace(
          this.#authPath,
          next,
          0o600,
        );
        if (result.state !== 'not_committed') this.#current = next;
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

  #requireCurrent(): CredentialRecord {
    if (!this.#current) throw new CredentialStoreError();
    return this.#current;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
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
