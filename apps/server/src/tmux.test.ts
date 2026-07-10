import { describe, expect, it, vi } from 'vitest';

import {
  TmuxSessionPreparer,
  type CommandResult,
  type CommandRunner,
} from './tmux.js';

const config = {
  executable: '/usr/bin/tmux',
  shell: '/bin/bash',
  homeDir: '/home/webterm',
  historyLimit: 20_000,
};

function runnerWith(...results: CommandResult[]): CommandRunner {
  let index = 0;
  return {
    run: vi.fn(
      async () => results[index++] ?? { exitCode: 0, stdout: '', stderr: '' },
    ),
  };
}

describe('TmuxSessionPreparer', () => {
  it('does not create an existing fixed session', async () => {
    const runner = runnerWith({ exitCode: 0, stdout: '', stderr: '' });
    const preparer = new TmuxSessionPreparer(config, runner);

    await preparer.prepare('phase-1-main');

    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledWith('/usr/bin/tmux', [
      'has-session',
      '-t',
      'webterm-phase-1-main',
    ]);
  });

  it('creates a missing session with one fixed argument array', async () => {
    const runner = runnerWith(
      { exitCode: 1, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    );
    const preparer = new TmuxSessionPreparer(config, runner);

    await preparer.prepare('phase-1-main');

    expect(runner.run).toHaveBeenNthCalledWith(2, '/usr/bin/tmux', [
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
      '20000',
      ';',
      'set-option',
      '-g',
      'default-shell',
      '/bin/bash',
      ';',
      'new-session',
      '-d',
      '-s',
      'webterm-phase-1-main',
      '/bin/bash',
      ';',
      'set-option',
      '-g',
      'exit-empty',
      'on',
    ]);
  });

  it.each(['other', '../phase-1-main'])(
    'rejects invalid session id %s before commands',
    async (sessionId) => {
      const runner = runnerWith();
      const preparer = new TmuxSessionPreparer(config, runner);

      await expect(preparer.prepare(sessionId)).rejects.toThrow(
        'Invalid session',
      );
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it('fails safely for unexpected exits without leaking command output', async () => {
    const secret = 'terminal-secret-output';
    const runner = runnerWith({ exitCode: 2, stdout: secret, stderr: secret });
    const preparer = new TmuxSessionPreparer(config, runner);

    const error = await preparer
      .prepare('phase-1-main')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
  });

  it('fails safely when command execution throws', async () => {
    const secret = 'raw-command-secret';
    const runner: CommandRunner = {
      run: vi.fn(async () => {
        throw new Error(secret);
      }),
    };
    const preparer = new TmuxSessionPreparer(config, runner);

    const error = await preparer
      .prepare('phase-1-main')
      .catch((caught: unknown) => caught);

    expect(String(error)).toBe('Error: Tmux command failed');
    expect(String(error)).not.toContain(secret);
  });

  it('returns a direct tmux attach specification', async () => {
    const preparer = new TmuxSessionPreparer(
      config,
      runnerWith({ exitCode: 0, stdout: '', stderr: '' }),
    );

    await expect(preparer.prepare('phase-1-main')).resolves.toEqual({
      executable: '/usr/bin/tmux',
      args: ['attach-session', '-t', 'webterm-phase-1-main'],
      cwd: '/home/webterm',
      env: {
        HOME: '/home/webterm',
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
      },
    });
  });
});
