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
const BUILD_SESSION_NAME = 'webterm-build-123e4567e89b42d3a456426614174000';

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

  it('does not create or mutate options for an existing session', async () => {
    const runner = runnerWith({ exitCode: 0, stdout: '', stderr: '' });
    const preparer = new TmuxSessionPreparer(
      config,
      runner,
      () => OTHER_SESSION_ID,
    );

    await preparer.prepare(SESSION_ID, settings);

    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledWith('/usr/bin/tmux', [
      'has-session',
      '-t',
      SESSION_NAME,
    ]);
  });

  it('applies session options before creating the real pane', async () => {
    const runner = runnerWith(
      { exitCode: 1, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    );
    const preparer = new TmuxSessionPreparer(
      config,
      runner,
      () => OTHER_SESSION_ID,
    );

    await preparer.prepare(SESSION_ID, settings);

    expect(runner.run).toHaveBeenNthCalledWith(2, '/usr/bin/tmux', [
      'new-session',
      '-d',
      '-s',
      BUILD_SESSION_NAME,
      '/usr/bin/sleep',
      '2147483647',
      ';',
      'set-option',
      '-t',
      BUILD_SESSION_NAME,
      'history-limit',
      '20000',
      ';',
      'set-option',
      '-t',
      BUILD_SESSION_NAME,
      'default-shell',
      '/bin/bash',
      ';',
      'set-option',
      '-t',
      BUILD_SESSION_NAME,
      'default-command',
      '',
      ';',
      'set-window-option',
      '-t',
      `${BUILD_SESSION_NAME}:0`,
      'alternate-screen',
      'off',
      ';',
      'split-window',
      '-d',
      '-t',
      `${BUILD_SESSION_NAME}:`,
      ';',
      'kill-pane',
      '-t',
      `${BUILD_SESSION_NAME}:`,
      ';',
      'rename-session',
      '-t',
      BUILD_SESSION_NAME,
      SESSION_NAME,
    ]);
    const creationArgs = vi.mocked(runner.run).mock.calls[1]?.[1];
    expect(creationArgs).not.toContain('-g');
    expect(creationArgs).not.toContain('exit-empty');
    expect(
      creationArgs?.filter((argument) => argument === '/bin/bash'),
    ).toHaveLength(1);
    expect(creationArgs?.slice(4, 6)).toEqual(['/usr/bin/sleep', '2147483647']);
    const realPaneIndex = creationArgs?.indexOf('split-window') ?? -1;
    expect(creationArgs?.indexOf('history-limit')).toBeLessThan(realPaneIndex);
    expect(creationArgs?.indexOf('default-shell')).toBeLessThan(realPaneIndex);
    expect(realPaneIndex).toBeLessThan(
      creationArgs?.indexOf('kill-pane') ?? -1,
    );
    expect(creationArgs?.slice(-4)).toEqual([
      'rename-session',
      '-t',
      BUILD_SESSION_NAME,
      SESSION_NAME,
    ]);
    expect(
      creationArgs?.filter((argument) => argument === SESSION_NAME),
    ).toEqual([SESSION_NAME]);
  });

  it.each([0, 1, 2])(
    'cleans only the build session after a final rename collision with cleanup exit %s',
    async (cleanupExitCode) => {
      const runner = runnerWith(
        { exitCode: 1, stdout: '', stderr: '' },
        { exitCode: 2, stdout: 'private', stderr: 'private' },
        { exitCode: cleanupExitCode, stdout: 'private', stderr: 'private' },
      );
      const preparer = new TmuxSessionPreparer(
        config,
        runner,
        () => OTHER_SESSION_ID,
      );

      await expect(preparer.prepare(SESSION_ID, settings)).rejects.toThrow(
        /^Tmux command failed$/,
      );

      expect(runner.run).toHaveBeenNthCalledWith(3, '/usr/bin/tmux', [
        'kill-session',
        '-t',
        BUILD_SESSION_NAME,
      ]);
      expect(runner.run).not.toHaveBeenCalledWith('/usr/bin/tmux', [
        'kill-session',
        '-t',
        SESSION_NAME,
      ]);
    },
  );

  it('cleans only the build session when creation throws', async () => {
    const runner: CommandRunner = {
      run: vi
        .fn<CommandRunner['run']>()
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
        .mockRejectedValueOnce(new Error('private creation failure'))
        .mockResolvedValueOnce({ exitCode: 1, stdout: 'private', stderr: '' }),
    };
    const preparer = new TmuxSessionPreparer(
      config,
      runner,
      () => OTHER_SESSION_ID,
    );

    await expect(preparer.prepare(SESSION_ID, settings)).rejects.toThrow(
      /^Tmux command failed$/,
    );
    expect(runner.run).toHaveBeenNthCalledWith(3, '/usr/bin/tmux', [
      'kill-session',
      '-t',
      BUILD_SESSION_NAME,
    ]);
    expect(runner.run).not.toHaveBeenCalledWith('/usr/bin/tmux', [
      'kill-session',
      '-t',
      SESSION_NAME,
    ]);
  });

  it.each(['../unsafe', 'not-a-uuid', OTHER_SESSION_ID.toUpperCase()])(
    'rejects invalid build id %s before commands',
    async (buildId) => {
      const runner = runnerWith();
      const preparer = new TmuxSessionPreparer(config, runner, () => buildId);

      await expect(preparer.prepare(SESSION_ID, settings)).rejects.toThrow(
        'Invalid session',
      );
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it('bounds a throwing build id source before commands', async () => {
    const runner = runnerWith();
    const preparer = new TmuxSessionPreparer(config, runner, () => {
      throw new Error('private random source failure');
    });

    await expect(preparer.prepare(SESSION_ID, settings)).rejects.toThrow(
      /^Invalid session$/,
    );
    expect(runner.run).not.toHaveBeenCalled();
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
      BUILD_SESSION_NAME,
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
      args: ['attach-session', '-E', '-t', SESSION_NAME],
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
