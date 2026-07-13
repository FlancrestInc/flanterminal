// @vitest-environment jsdom

import type { AdminSnapshot } from '@flanterminal/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import './test/setup.js';
import { AdminView } from './AdminView.js';
import type { AdminController } from './useAdmin.js';

const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '223e4567-e89b-42d3-a456-426614174000';

const populated: AdminSnapshot = {
  generatedAt: '2026-07-13T12:00:00.000Z',
  uptimeSeconds: 3661,
  memory: { rss: 67_108_864, heapUsed: 24_117_248 },
  totals: { tabs: 2, runningSessions: 1, bridges: 1, webSockets: 2 },
  cleanup: {
    enabled: true,
    running: false,
    lastRunAt: '2026-07-13T11:00:00.000Z',
  },
  sessions: [
    {
      id: A,
      displayName: 'Gospel',
      tmuxSessionName: `webterm-${A}`,
      desiredState: 'active',
      observedState: 'running',
      createdAt: '2026-07-13T10:58:59.000Z',
      lastActivityAt: '2026-07-13T11:59:00.000Z',
      ageSeconds: 3661,
      connectedWebSockets: 2,
      bridgePid: 402,
      cleanupEligible: true,
      lifecycleError: 'operation_failed',
    },
    {
      id: B,
      displayName: 'Maintenance',
      tmuxSessionName: `webterm-${B}`,
      desiredState: 'stopped',
      observedState: 'stopped',
      createdAt: '2026-07-13T11:30:00.000Z',
      lastActivityAt: '2026-07-13T11:45:00.000Z',
      ageSeconds: 1800,
      connectedWebSockets: 0,
      bridgePid: null,
      cleanupEligible: false,
      lifecycleError: null,
    },
  ],
};

function controller(overrides: Partial<AdminController> = {}): AdminController {
  return {
    snapshot: populated,
    loading: false,
    error: null,
    sessionErrors: {},
    busySessionIds: new Set(),
    cleanupBusy: false,
    cleanupError: null,
    cleanupResult: null,
    refresh: vi.fn(async () => undefined),
    runSessionAction: vi.fn(async () => undefined),
    runCleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('AdminView', () => {
  it('renders bounded aggregate health and a dense horizontally scrollable table', () => {
    render(<AdminView controller={controller()} onBack={vi.fn()} />);

    expect(
      screen.getByRole('heading', { name: 'Administration' }),
    ).toBeVisible();
    expect(screen.getByText('64.0 MiB RSS')).toBeVisible();
    expect(screen.getByText('23.0 MiB heap')).toBeVisible();
    expect(screen.getByText('1h 1m uptime')).toBeVisible();
    expect(screen.getByText('2 tabs')).toBeVisible();
    expect(screen.getByText('1 running')).toBeVisible();
    expect(screen.getByText('1 bridge')).toBeVisible();
    expect(screen.getByText('2 sockets')).toBeVisible();
    expect(screen.getByText('Gospel')).toBeVisible();
    expect(screen.getByText(A)).toBeVisible();
    expect(screen.getByText(`webterm-${A}`)).toBeVisible();
    expect(screen.getByText('active / running')).toBeVisible();
    expect(screen.getByText('PID 402')).toBeVisible();
    expect(screen.getByText('Eligible')).toBeVisible();
    expect(screen.getByText('operation_failed')).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Terminal sessions' }),
    ).toHaveClass('admin-table-scroll');
  });

  it('confirms destructive row actions but runs bridge restart and recreate directly', () => {
    const state = controller();
    render(<AdminView controller={state} onBack={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Restart bridge for Gospel' }),
    );
    expect(state.runSessionAction).toHaveBeenCalledWith(A, 'restart_bridge');

    fireEvent.click(
      screen.getByRole('button', { name: 'Recreate session for Maintenance' }),
    );
    expect(state.runSessionAction).toHaveBeenCalledWith(B, 'recreate');

    fireEvent.click(
      screen.getByRole('button', { name: 'Terminate session for Gospel' }),
    );
    expect(state.runSessionAction).not.toHaveBeenCalledWith(A, 'terminate');
    fireEvent.click(screen.getByRole('button', { name: 'Terminate session' }));
    expect(state.runSessionAction).toHaveBeenCalledWith(A, 'terminate');

    fireEvent.click(
      screen.getByRole('button', { name: 'Restart session for Gospel' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restart session' }));
    expect(state.runSessionAction).toHaveBeenCalledWith(A, 'restart_session');
  });

  it('confirms multi-session cleanup and disables it when the scheduler is disabled', () => {
    const state = controller();
    const { rerender } = render(
      <AdminView controller={state} onBack={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Run stale session cleanup' }),
    );
    expect(state.runCleanup).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '1 currently eligible',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run cleanup' }));
    expect(state.runCleanup).toHaveBeenCalledOnce();

    rerender(
      <AdminView
        controller={controller({
          snapshot: {
            ...populated,
            cleanup: { ...populated.cleanup, enabled: false },
          },
        })}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Run stale session cleanup' }),
    ).toBeDisabled();
  });

  it('provides focused loading, empty, error, refresh, and return states', () => {
    const onBack = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const { rerender } = render(
      <AdminView
        controller={controller({ snapshot: null, loading: true, refresh })}
        onBack={onBack}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading session health',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to terminal' }));
    expect(onBack).toHaveBeenCalledOnce();

    rerender(
      <AdminView
        controller={controller({
          snapshot: null,
          error: 'Unable to load administration status.',
          refresh,
        })}
        onBack={onBack}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to load administration status.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh administration status' }),
    );
    expect(refresh).toHaveBeenCalledOnce();

    rerender(
      <AdminView
        controller={controller({ snapshot: { ...populated, sessions: [] } })}
        onBack={onBack}
      />,
    );
    expect(screen.getByText('No terminal sessions')).toBeVisible();
  });
});
