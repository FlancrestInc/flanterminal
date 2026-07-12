// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import './test/setup.js';
import { SessionMenu } from './SessionMenu.js';

function setup(desiredState: 'active' | 'stopped' = 'active') {
  const actions = {
    onReconnect: vi.fn(),
    onDetach: vi.fn(),
    onClear: vi.fn(),
    onRestartClient: vi.fn(),
    onRestartBridge: vi.fn(),
    onRestartSession: vi.fn(),
    onTerminate: vi.fn(),
    onRecreate: vi.fn(),
    onMoveLeft: vi.fn(),
    onMoveRight: vi.fn(),
  };
  render(
    <SessionMenu
      desiredState={desiredState}
      sessionState={desiredState === 'active' ? 'running' : 'stopped'}
      canMoveLeft
      canMoveRight={false}
      {...actions}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
  return actions;
}

describe('SessionMenu', () => {
  it('offers client, bridge, session, and ordering commands for active tabs', () => {
    const actions = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reconnect' }));
    expect(actions.onReconnect).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Terminate session' }),
    );
    expect(actions.onTerminate).toHaveBeenCalledOnce();
  });

  it('shows recreate instead of connection commands for a stopped tab', () => {
    const actions = setup('stopped');
    expect(
      screen.queryByRole('menuitem', { name: 'Reconnect' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Recreate session' }));
    expect(actions.onRecreate).toHaveBeenCalledOnce();
  });
});
