import { describe, expect, it, vi } from 'vitest';

import {
  NodePtyFactory,
  sanitizePtyEnvironment,
  type NativePtyProcess,
  type NativePtySpawner,
} from './pty.js';

describe('sanitizePtyEnvironment', () => {
  it('inherits only interactive-shell environment keys', () => {
    expect(
      sanitizePtyEnvironment({
        HOME: '/home/user',
        USER: 'user',
        LOGNAME: 'user',
        PATH: '/bin',
        LANG: 'en_US.UTF-8',
        LC_TIME: 'C',
        TZ: 'UTC',
        TERM: 'old-term',
        SHELL: '/bin/sh',
        API_TOKEN: 'secret',
        DATABASE_URL: 'secret',
        NODE_OPTIONS: '--inspect',
      }),
    ).toEqual({
      HOME: '/home/user',
      USER: 'user',
      LOGNAME: 'user',
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
      LC_TIME: 'C',
      TZ: 'UTC',
      TERM: 'old-term',
      SHELL: '/bin/sh',
    });
  });
});

describe('NodePtyFactory', () => {
  it('spawns the executable directly with bounded defaults and sanitized env', () => {
    const native = fakeNativePty();
    const spawner: NativePtySpawner = { spawn: vi.fn(() => native) };
    const factory = new NodePtyFactory(spawner, {
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      PRIVATE_KEY: 'secret',
    });

    const result = factory.spawn({
      executable: '/usr/bin/tmux',
      args: ['attach-session', '-t', 'webterm-phase-1-main'],
      cwd: '/home/webterm',
      env: {
        HOME: '/home/webterm',
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
      },
    });

    expect(result).toBe(native);
    expect(spawner.spawn).toHaveBeenCalledWith(
      '/usr/bin/tmux',
      ['attach-session', '-t', 'webterm-phase-1-main'],
      {
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
        cwd: '/home/webterm',
        env: {
          PATH: '/usr/bin',
          LANG: 'C.UTF-8',
          HOME: '/home/webterm',
          SHELL: '/bin/bash',
          TERM: 'xterm-256color',
        },
      },
    );
  });

  it('uses validated requested dimensions', () => {
    const spawner: NativePtySpawner = { spawn: vi.fn(() => fakeNativePty()) };
    const factory = new NodePtyFactory(spawner, {});

    factory.spawn(
      { executable: 'tmux', args: [], cwd: '/home', env: {} },
      { cols: 120, rows: 40 },
    );

    expect(spawner.spawn).toHaveBeenCalledWith(
      'tmux',
      [],
      expect.objectContaining({ cols: 120, rows: 40 }),
    );
  });
});

function fakeNativePty(): NativePtyProcess {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  };
}
