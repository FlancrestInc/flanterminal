// @vitest-environment jsdom

import { FIXED_SESSION_ID, type ClientConfig } from '@flanterminal/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import './test/setup.js';

import type { TerminalSocketController } from './useTerminalSocket.js';

const socket = vi.hoisted(() => ({
  status: 'connected' as TerminalSocketController['status'],
  error: null as string | null,
  reconnect: vi.fn(),
  disconnect: vi.fn(),
  sendInput: vi.fn(() => true),
  sendResize: vi.fn(() => true),
  subscribeOutput: vi.fn(() => vi.fn()),
}));

vi.mock('./useTerminalSocket.js', () => ({
  useTerminalSocket: () => socket,
}));
vi.mock('./Terminal.js', () => ({
  Terminal: () => <div aria-label="Terminal surface" />,
}));

import { App, StartupState } from './App.js';

const config: ClientConfig = {
  basePath: '/terminal',
  sessionId: FIXED_SESSION_ID,
  fontSize: 14,
  scrollback: 5_000,
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 8,
};

beforeEach(() => {
  socket.status = 'connected';
  socket.error = null;
  socket.reconnect.mockClear();
});

describe('App', () => {
  it('renders one compact Terminal workspace without exposing the session id', () => {
    render(<App config={config} />);

    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByLabelText('Terminal surface')).toBeInTheDocument();
    expect(screen.queryByText(FIXED_SESSION_ID)).not.toBeInTheDocument();
  });

  it('offers an icon-only reconnect command and disables it while connecting', () => {
    const { rerender } = render(<App config={config} />);
    const button = screen.getByRole('button', { name: 'Reconnect terminal' });
    expect(button).toHaveAttribute('title', 'Reconnect terminal');
    expect(button).not.toHaveTextContent(/Reconnect/i);
    fireEvent.click(button);
    expect(socket.reconnect).toHaveBeenCalledOnce();

    socket.status = 'reconnecting';
    rerender(<App config={config} />);
    expect(button).toBeDisabled();
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
  });

  it('announces a bounded connection error without rendering protocol details', () => {
    socket.status = 'error';
    socket.error = 'Terminal connection protocol error.';
    render(<App config={config} />);

    expect(screen.getByRole('status')).toHaveTextContent('Connection error');
    expect(screen.queryByText(socket.error)).not.toBeInTheDocument();
  });
});

describe('StartupState', () => {
  it('provides compact accessible loading and safe error states', () => {
    const { rerender } = render(<StartupState state="loading" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading terminal');

    rerender(<StartupState state="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to start terminal.',
    );
  });
});
