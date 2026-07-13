import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';

const MAX_CONFIG_FILE_BYTES = 64 * 1024;
const SECRET_KEY_PATTERN = /(password|secret|token|cookie|privatekey)/i;
const ALLOWED_CONFIG_KEYS = new Set([
  'port',
  'bindHost',
  'basePath',
  'publicUrl',
  'defaultShell',
  'defaultFontSize',
  'xtermScrollback',
  'tmuxHistoryLimit',
  'wsHeartbeatSeconds',
  'wsMaxBufferBytes',
  'resizeDebounceMs',
  'reconnectMaxSeconds',
  'logLevel',
  'homeDir',
  'dataDir',
  'sessionMaxCount',
  'authMode',
  'localAuthUsername',
  'bcryptCost',
  'authIdleMinutes',
  'authAbsoluteHours',
  'authSessionMaxCount',
  'cloudflareTeamDomain',
  'cloudflareAccessAud',
  'trustProxy',
  'trustedAuthHeader',
  'allowedShells',
  'maxFontSize',
  'maxXtermScrollback',
  'maxTmuxHistoryLimit',
  'maxStaleSessionCleanupHours',
  'sessionCleanupIntervalMinutes',
]);

export interface ConfigFileHandle {
  stat(): Promise<{ size: number; isFile(): boolean }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ConfigFileSystem {
  open(path: string, flags: number): Promise<ConfigFileHandle>;
}

const nodeFileSystem: ConfigFileSystem = {
  open: (path, flags) => fs.open(path, flags),
};

export type OptionalConfigFileValues = Readonly<Record<string, unknown>>;

export async function loadOptionalConfigFile(
  path: string | undefined,
  fileSystem: ConfigFileSystem = nodeFileSystem,
): Promise<OptionalConfigFileValues> {
  if (path === undefined || path === '') return Object.freeze({});

  let handle: ConfigFileHandle | undefined;
  let result: OptionalConfigFileValues | undefined;
  let failed = false;
  try {
    if (!path.startsWith('/')) throw new Error('invalid path');
    handle = await fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) {
      throw new Error('invalid file');
    }
    const bytes = await readBounded(handle);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error('invalid document');
    for (const key of Object.keys(parsed)) {
      if (SECRET_KEY_PATTERN.test(key) || !ALLOWED_CONFIG_KEYS.has(key)) {
        throw new Error('invalid key');
      }
    }
    result = deepFreeze(structuredClone(parsed));
  } catch {
    failed = true;
  }
  try {
    await handle?.close();
  } catch {
    failed = true;
  }
  if (failed || result === undefined) {
    throw new Error('Invalid server configuration');
  }
  return result;
}

async function readBounded(handle: ConfigFileHandle): Promise<Uint8Array> {
  const buffer = new Uint8Array(MAX_CONFIG_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_CONFIG_FILE_BYTES) throw new Error('oversized');
  return buffer.subarray(0, offset);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
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
