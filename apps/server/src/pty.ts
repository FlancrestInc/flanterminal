import { spawn as spawnNativePty } from 'node-pty';

import type { AttachSpec } from './tmux.js';

export interface Disposable {
  dispose(): void;
}

export type PtyExit = Readonly<{ exitCode: number; signal?: number }>;

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExit) => void): Disposable;
}

export type TerminalDimensions = Readonly<{ cols: number; rows: number }>;

export interface PtyFactory {
  spawn(spec: AttachSpec, dimensions?: TerminalDimensions): PtyProcess;
}

export type NativePtyOptions = Readonly<{
  cols: number;
  rows: number;
  name: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export type NativePtyProcess = PtyProcess;

export interface NativePtySpawner {
  spawn(
    executable: string,
    args: readonly string[],
    options: NativePtyOptions,
  ): NativePtyProcess;
}

const inheritedKeys = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'LANG',
  'TZ',
  'TERM',
  'SHELL',
]);

/** Prevents unrelated process secrets from entering the interactive terminal. */
export function sanitizePtyEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      (inheritedKeys.has(key) || key.startsWith('LC_'))
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

const defaultSpawner: NativePtySpawner = {
  spawn(executable, args, options) {
    return spawnNativePty(executable, [...args], options);
  },
};

export class NodePtyFactory implements PtyFactory {
  constructor(
    private readonly spawner: NativePtySpawner = defaultSpawner,
    private readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
  ) {}

  spawn(
    spec: AttachSpec,
    dimensions: TerminalDimensions = { cols: 80, rows: 24 },
  ): PtyProcess {
    return this.spawner.spawn(spec.executable, spec.args, {
      cols: dimensions.cols,
      rows: dimensions.rows,
      name: 'xterm-256color',
      cwd: spec.cwd,
      env: {
        ...sanitizePtyEnvironment(this.environment),
        ...spec.env,
      },
    });
  }
}
