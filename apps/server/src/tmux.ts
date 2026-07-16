import { execFile } from 'node:child_process';
import { randomUUID as nodeRandomUUID } from 'node:crypto';

import { isSessionId } from '@flanterminal/shared';

import type { SessionRuntimeSettings } from './session-runtime-settings.js';

export type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export interface CommandRunner {
  run(executable: string, args: readonly string[]): Promise<CommandResult>;
}

export class ExecFileCommandRunner implements CommandRunner {
  run(executable: string, args: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(executable, [...args], (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }

        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(new Error('Command execution failed'));
      });
    });
  }
}

export type AttachSpec = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export interface SessionPreparer {
  prepare(
    sessionId: string,
    settings?: SessionRuntimeSettings,
  ): Promise<AttachSpec>;
}

export type TmuxConfig = Readonly<{
  executable: string;
  homeDir: string;
}>;

const APP_SESSION_NAME = /^webterm-tab-([0-9a-f]{32})$/;
const BOOTSTRAP_EXECUTABLE = '/usr/bin/sleep';
const BOOTSTRAP_DURATION_SECONDS = '2147483647';

export function tmuxSessionName(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error('Invalid session');
  return `webterm-tab-${sessionId.replaceAll('-', '')}`;
}

function tmuxBuildSessionName(randomUUID: () => string): string {
  let buildId: unknown;
  try {
    buildId = randomUUID();
  } catch {
    throw new Error('Invalid session');
  }
  if (!isSessionId(buildId)) throw new Error('Invalid session');
  return `webterm-build-${buildId.replaceAll('-', '')}`;
}

export class TmuxSessionPreparer implements SessionPreparer {
  constructor(
    private readonly config: TmuxConfig,
    private readonly runner: CommandRunner,
    private readonly randomUUID: () => string = nodeRandomUUID,
  ) {}

  async prepare(
    sessionId: string,
    settings?: SessionRuntimeSettings,
  ): Promise<AttachSpec> {
    const name = tmuxSessionName(sessionId);
    if (settings === undefined) throw new Error('Invalid runtime settings');
    const buildName = tmuxBuildSessionName(this.randomUUID);
    const windowTarget = `${buildName}:`;
    const initialWindowTarget = `${buildName}:0`;
    if (!(await this.exists(sessionId))) {
      try {
        const creation = await this.run([
          'new-session',
          '-d',
          '-s',
          buildName,
          BOOTSTRAP_EXECUTABLE,
          BOOTSTRAP_DURATION_SECONDS,
          ';',
          'set-option',
          '-t',
          buildName,
          'history-limit',
          String(settings.historyLimit),
          ';',
          'set-option',
          '-t',
          buildName,
          'default-shell',
          settings.shell,
          ';',
          'set-option',
          '-t',
          buildName,
          'default-command',
          '',
          ';',
          'set-window-option',
          '-t',
          initialWindowTarget,
          'alternate-screen',
          'off',
          ';',
          'split-window',
          '-d',
          '-t',
          windowTarget,
          ';',
          'kill-pane',
          '-t',
          windowTarget,
          ';',
          'rename-session',
          '-t',
          buildName,
          name,
        ]);
        if (creation.exitCode !== 0) throw new Error();
      } catch {
        try {
          await this.killNamedSession(buildName);
        } catch {
          // Preserve the bounded creation failure after best-effort cleanup.
        }
        throw new Error('Tmux command failed');
      }
    }

    try {
      const alternateScreen = await this.run([
        'set-window-option',
        '-t',
        `${name}:0`,
        'alternate-screen',
        'off',
      ]);
      if (alternateScreen.exitCode !== 0) throw new Error();

      const mouse = await this.run(['set-option', '-t', name, 'mouse', 'off']);
      if (mouse.exitCode !== 0) throw new Error();
    } catch {
      throw new Error('Tmux command failed');
    }

    return this.attachSpec(sessionId, settings);
  }

  async exists(sessionId: string): Promise<boolean> {
    const result = await this.run([
      'has-session',
      '-t',
      tmuxSessionName(sessionId),
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error('Tmux command failed');
  }

  async kill(sessionId: string): Promise<void> {
    await this.killNamedSession(tmuxSessionName(sessionId));
  }

  private async killNamedSession(name: string): Promise<void> {
    const result = await this.run(['kill-session', '-t', name]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error('Tmux command failed');
    }
  }

  async listActiveSessionIds(): Promise<string[]> {
    const result = await this.run(['list-sessions', '-F', '#{session_name}']);
    if (result.exitCode === 1) return [];
    if (result.exitCode !== 0) throw new Error('Tmux command failed');
    if (result.stdout.trim() === '') return [];

    const sessionIds: string[] = [];
    for (const line of result.stdout.split(/\r?\n/u)) {
      const match = APP_SESSION_NAME.exec(line);
      if (match === null) continue;
      const compact = match[1];
      if (compact === undefined) continue;
      const sessionId = [
        compact.slice(0, 8),
        compact.slice(8, 12),
        compact.slice(12, 16),
        compact.slice(16, 20),
        compact.slice(20),
      ].join('-');
      if (isSessionId(sessionId)) sessionIds.push(sessionId);
    }
    return sessionIds;
  }

  attachSpec(sessionId: string, settings?: SessionRuntimeSettings): AttachSpec {
    if (settings === undefined) throw new Error('Invalid runtime settings');
    const name = tmuxSessionName(sessionId);
    return {
      executable: this.config.executable,
      args: ['attach-session', '-E', '-t', name],
      cwd: this.config.homeDir,
      env: {
        HOME: this.config.homeDir,
        SHELL: settings.shell,
        TERM: 'xterm-256color',
      },
    };
  }

  private async run(args: readonly string[]): Promise<CommandResult> {
    try {
      return await this.runner.run(this.config.executable, args);
    } catch {
      throw new Error('Tmux command failed');
    }
  }
}
