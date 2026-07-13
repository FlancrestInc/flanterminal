import { describe, expect, it, vi } from 'vitest';

import {
  TmuxSessionPreparer,
  tmuxSessionName,
  type CommandResult,
  type CommandRunner,
} from './tmux.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const SESSION_NAME = 'webterm-tab-550e8400e29b41d4a716446655440000';

const config = {
  executable: '/usr/bin/tmux',
  homeDir: '/home/webterm',
};
const settings = Object.freeze({ shell: '/bin/bash', historyLimit: 20_000 });

function runnerWith(...results: CommandResult[]): CommandRunner {
  let index = 0;
  return {
    run: vi.fn(
      async () => results[index++] ?? { exitCode: 0, stdout: '', stderr: '' },
    ),
  };
}

describe('TmuxSessionPreparer', () => {
  it('derives the safe tmux name only from a validated canonical UUID', () => {
    expect(tmuxSessionName(SESSION_ID)).toBe(SESSION_NAME);
    expect(() => tmuxSessionName('../unsafe')).toThrow('Invalid session');
  });

  it.each(['other', '../unsafe', SESSION_ID.toUpperCase()])(
    'rejects invalid session id %s before commands',
    async (sessionId) => {
      const runner = runnerWith();
      const preparer = new TmuxSessionPreparer(config, runner);

      await expect(preparer.prepare(sessionId, settings)).rejects.toThrow(
        'Invalid session',
      );
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it('probes an existing session with an argument array', async () => {
    const runner = runnerWith({ exitCode: 0, stdout: '', stderr: '' });
    const preparer = new TmuxSessionPreparer(config, runner);

    await expect(preparer.exists(SESSION_ID)).resolves.toBe(true);
    expect(runner.run).toHaveBeenCalledWith('/usr/bin/tmux', [
      'has-session',
      '-t',
      SESSION_NAME,
    ]);
  });

  it('treats has-session exit 1 as absent', async () => {
    const preparer = new TmuxSessionPreparer(
      config,
      runnerWith({ exitCode: 1, stdout: 'secret', stderr: 'secret' }),
    );

    await expect(preparer.exists(SESSION_ID)).resolves.toBe(false);
  });

  it.each([2, 127])('bounds unexpected probe exit %s', async (exitCode) => {
    const preparer = new TmuxSessionPreparer(
      config,
      runnerWith({ exitCode, stdout: 'terminal-secret', stderr: 'raw-secret' }),
    );

    await expect(preparer.exists(SESSION_ID)).rejects.toThrow(
      /^Tmux command failed$/,
    );
  });

  it('does not create an existing session', async () => {
    const runner = runnerWith({ exitCode: 0, stdout: '', stderr: '' });
    const preparer = new TmuxSessionPreparer(config, runner);

    await preparer.prepare(SESSION_ID, settings);

    expect(runner.run).toHaveBeenCalledOnce();
  });

  it('creates a missing session with one safe argument array', async () => {
    const runner = runnerWith(
      { exitCode: 1, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    );
    const preparer = new TmuxSessionPreparer(config, runner);

    await preparer.prepare(SESSION_ID, settings);

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
      SESSION_NAME,
      '/bin/bash',
      ';',
      'set-option',
      '-g',
      'exit-empty',
      'on',
    ]);
  });

  it('kills only the requested session and treats absence as success', async () => {
    const runner = runnerWith({ exitCode: 1, stdout: '', stderr: '' });
    const preparer = new TmuxSessionPreparer(config, runner);

    await expect(preparer.kill(OTHER_SESSION_ID)).resolves.toBeUndefined();
    expect(runner.run).toHaveBeenCalledWith('/usr/bin/tmux', [
      'kill-session',
      '-t',
      'webterm-tab-123e4567e89b42d3a456426614174000',
    ]);
  });

  it('bounds unexpected kill and command execution failures', async () => {
    const failed = new TmuxSessionPreparer(
      config,
      runnerWith({ exitCode: 2, stdout: 'secret', stderr: 'secret' }),
    );
    const thrown = new TmuxSessionPreparer(config, {
      run: vi.fn(async () => {
        throw new Error('raw-command-secret');
      }),
    });

    await expect(failed.kill(SESSION_ID)).rejects.toThrow(
      /^Tmux command failed$/,
    );
    await expect(thrown.kill(SESSION_ID)).rejects.toThrow(
      /^Tmux command failed$/,
    );
  });

  it('lists only exact canonical application session names', async () => {
    const stdout = [
      SESSION_NAME,
      'unrelated',
      'webterm-tab-123e4567e89b42d3a456426614174000',
      'webterm-tab-123E4567E89B42D3A456426614174000',
      'webterm-tab-123e4567e89b42d3a45642661417400',
      'webterm-tab-00000000000000000000000000000000',
      `${SESSION_NAME}-extra`,
      '',
    ].join('\n');
    const runner = runnerWith({ exitCode: 0, stdout, stderr: '' });
    const preparer = new TmuxSessionPreparer(config, runner);

    await expect(preparer.listActiveSessionIds()).resolves.toEqual([
      SESSION_ID,
      OTHER_SESSION_ID,
    ]);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledWith('/usr/bin/tmux', [
      'list-sessions',
      '-F',
      '#{session_name}',
    ]);
  });

  it.each([
    { exitCode: 1, stdout: 'server-secret', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  ])('returns an empty list when tmux has no sessions', async (result) => {
    const preparer = new TmuxSessionPreparer(config, runnerWith(result));
    await expect(preparer.listActiveSessionIds()).resolves.toEqual([]);
  });

  it('bounds unexpected list failures', async () => {
    const preparer = new TmuxSessionPreparer(
      config,
      runnerWith({ exitCode: 2, stdout: 'secret', stderr: 'secret' }),
    );
    await expect(preparer.listActiveSessionIds()).rejects.toThrow(
      /^Tmux command failed$/,
    );
  });

  it('returns a direct tmux attach specification', async () => {
    const preparer = new TmuxSessionPreparer(
      config,
      runnerWith({ exitCode: 0, stdout: '', stderr: '' }),
    );

    await expect(preparer.prepare(SESSION_ID, settings)).resolves.toEqual({
      executable: '/usr/bin/tmux',
      args: ['attach-session', '-t', SESSION_NAME],
      cwd: '/home/webterm',
      env: {
        HOME: '/home/webterm',
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
      },
    });
  });

  it('uses only the captured settings snapshot across the existence await', async () => {
    const probe = deferred<CommandResult>();
    const runner: CommandRunner = {
      run: vi
        .fn<CommandRunner['run']>()
        .mockReturnValueOnce(probe.promise)
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const preparer = new TmuxSessionPreparer(config, runner);
    const captured = Object.freeze({ shell: '/bin/zsh', historyLimit: 30_000 });

    const preparing = preparer.prepare(SESSION_ID, captured);
    probe.resolve({ exitCode: 1, stdout: '', stderr: '' });
    await preparing;

    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/tmux',
      expect.arrayContaining(['30000', '/bin/zsh']),
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
