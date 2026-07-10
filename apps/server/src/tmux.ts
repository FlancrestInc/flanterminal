import { execFile } from 'node:child_process';

import { isSessionId } from '@flanterminal/shared';

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
  prepare(sessionId: string): Promise<AttachSpec>;
}

export type TmuxConfig = Readonly<{
  executable: string;
  shell: string;
  homeDir: string;
  historyLimit: number;
}>;

function sessionName(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error('Invalid session');
  return `webterm-${sessionId}`;
}

export class TmuxSessionPreparer implements SessionPreparer {
  constructor(
    private readonly config: TmuxConfig,
    private readonly runner: CommandRunner,
  ) {}

  async prepare(sessionId: string): Promise<AttachSpec> {
    const name = sessionName(sessionId);
    const status = await this.run(['has-session', '-t', name]);

    if (status.exitCode === 1) {
      const creation = await this.run([
        'start-server',
        ';',
        'set-option',
        '-g',
        'exit-empty',
        'off',
        ';',
        'set-option',
        '-g',
        'history-limit',
        String(this.config.historyLimit),
        ';',
        'set-option',
        '-g',
        'default-shell',
        this.config.shell,
        ';',
        'new-session',
        '-d',
        '-s',
        name,
        this.config.shell,
        ';',
        'set-option',
        '-g',
        'exit-empty',
        'on',
      ]);
      if (creation.exitCode !== 0) throw new Error('Tmux command failed');
    } else if (status.exitCode !== 0) {
      throw new Error('Tmux command failed');
    }

    return {
      executable: this.config.executable,
      args: ['attach-session', '-t', name],
      cwd: this.config.homeDir,
      env: {
        HOME: this.config.homeDir,
        SHELL: this.config.shell,
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
