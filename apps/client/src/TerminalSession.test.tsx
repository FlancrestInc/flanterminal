// @vitest-environment jsdom

import type { ClientConfig, WorkspaceSettings } from '@flanterminal/shared';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import './test/setup.js';
import type { TerminalHandle } from './Terminal.js';
import type { TerminalSocketController } from './useTerminalSocket.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const config = {
  basePath: '/terminal',
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 8,
} satisfies ClientConfig;
const settings = {
  version: 1,
  fontFamily: 'jetbrains-mono-nerd',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  scrollback: 5_000,
  theme: 'dark',
  cursorStyle: 'block',
  cursorBlink: true,
  bellBehavior: 'visual',
  reconnectBehavior: 'automatic',
  automaticTabCreation: true,
  workspaceShortcuts: 'default',
  defaultShell: '/bin/bash',
  tmuxHistoryLimit: 20_000,
  staleSessionCleanupHours: 0,
} satisfies WorkspaceSettings;
const socket: TerminalSocketController = {
  status: 'connected',
  error: null,
  reconnect: vi.fn(),
  disconnect: vi.fn(),
  sendInput: vi.fn(() => true),
  sendResize: vi.fn(() => true),
  subscribeOutput: vi.fn(() => vi.fn()),
};
const useSocket = vi.hoisted(() => vi.fn(() => socket));
const terminalCommands = vi.hoisted(() => ({ focus: vi.fn(), clear: vi.fn() }));

vi.mock('./useTerminalSocket.js', () => ({ useTerminalSocket: useSocket }));
vi.mock('./Terminal.js', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    Terminal: forwardRef<TerminalHandle>(function MockTerminal(_props, ref) {
      useImperativeHandle(ref, () => terminalCommands, []);
      return <div aria-label="Terminal surface" />;
    }),
  };
});

import {
  TerminalSession,
  type TerminalSessionHandle,
} from './TerminalSession.js';
import { AuthenticationRequiredContext } from './useAuth.js';

describe('TerminalSession', () => {
  it('binds the immutable tab ID and exposes local client controls', () => {
    const ref = createRef<TerminalSessionHandle>();
    const onStatus = vi.fn();
    const onSessionChanged = vi.fn();
    render(
      <TerminalSession
        ref={ref}
        config={config}
        settings={settings}
        tabId={ID}
        onStatus={onStatus}
        onSessionChanged={onSessionChanged}
      />,
    );

    expect(useSocket).toHaveBeenCalledWith(
      config,
      ID,
      expect.objectContaining({
        reconnectBehavior: 'automatic',
        onSessionStopped: expect.any(Function),
        onSessionRestarting: expect.any(Function),
      }),
    );
    expect(onStatus).toHaveBeenCalledWith(ID, 'connected', null);
    act(() => ref.current?.reconnect());
    act(() => ref.current?.detach());
    act(() => ref.current?.clear());
    act(() => ref.current?.focus());
    expect(socket.reconnect).toHaveBeenCalledOnce();
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(terminalCommands.clear).toHaveBeenCalledOnce();
    expect(terminalCommands.focus).toHaveBeenCalledOnce();
  });

  it('routes socket authentication loss to the owning auth epoch', () => {
    const onAuthenticationRequired = vi.fn();
    render(
      <AuthenticationRequiredContext.Provider value={onAuthenticationRequired}>
        <TerminalSession
          config={config}
          settings={settings}
          tabId={ID}
          onStatus={vi.fn()}
          onSessionChanged={vi.fn()}
        />
      </AuthenticationRequiredContext.Provider>,
    );

    expect(useSocket).toHaveBeenLastCalledWith(
      config,
      ID,
      expect.objectContaining({ onAuthenticationRequired }),
    );
  });
});
