import type { AdminAction, AdminSessionRow } from '@flanterminal/shared';
import {
  ArrowLeft,
  Play,
  RefreshCw,
  RotateCcw,
  ServerCog,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from './ConfirmDialog.js';
import type { AdminController } from './useAdmin.js';

export type AdminViewProps = Readonly<{
  controller: AdminController;
  onBack: () => void;
}>;

type Confirmation =
  | Readonly<{
      kind: 'terminate' | 'restart_session';
      id: string;
      name: string;
    }>
  | Readonly<{ kind: 'cleanup'; eligible: number }>;

export function AdminView({ controller, onBack }: AdminViewProps) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const snapshot = controller.snapshot;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const confirm = () => {
    const next = confirmation;
    setConfirmation(null);
    if (next === null) return;
    if (next.kind === 'cleanup') {
      void controller.runCleanup();
      return;
    }
    void controller.runSessionAction(next.id, next.kind);
  };

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <button
          className="icon-button"
          type="button"
          title="Back to terminal"
          aria-label="Back to terminal"
          onClick={onBack}
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <h1 ref={headingRef} tabIndex={-1}>
          Administration
        </h1>
        <div className="admin-header-actions">
          <button
            className="icon-button"
            type="button"
            title="Refresh administration status"
            aria-label="Refresh administration status"
            disabled={controller.loading}
            onClick={() => void controller.refresh()}
          >
            <RefreshCw
              className={controller.loading ? 'is-spinning' : undefined}
              size={16}
              aria-hidden="true"
            />
          </button>
          <button
            className="admin-command"
            type="button"
            disabled={
              snapshot === null ||
              !snapshot.cleanup.enabled ||
              snapshot.cleanup.running ||
              controller.cleanupBusy
            }
            title={
              snapshot?.cleanup.enabled === false
                ? 'Stale session cleanup is disabled in settings'
                : 'Run stale session cleanup'
            }
            aria-label="Run stale session cleanup"
            onClick={() =>
              setConfirmation({
                kind: 'cleanup',
                eligible:
                  snapshot?.sessions.filter((row) => row.cleanupEligible)
                    .length ?? 0,
              })
            }
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>
              {controller.cleanupBusy ? 'Cleaning...' : 'Clean stale'}
            </span>
          </button>
        </div>
      </header>

      <div className="admin-scroll">
        {snapshot === null ? (
          controller.loading ? (
            <div className="admin-state" role="status">
              <span className="startup-indicator" aria-hidden="true" />
              Loading session health
            </div>
          ) : (
            <div className="admin-state admin-state-error" role="alert">
              {controller.error ?? 'Administration status is unavailable.'}
            </div>
          )
        ) : (
          <>
            <section className="admin-summary" aria-label="Application health">
              <time
                dateTime={snapshot.generatedAt}
                aria-label={`Snapshot generated at ${formatCanonicalTime(snapshot.generatedAt)}`}
                title={snapshot.generatedAt}
              >
                {formatCanonicalTime(snapshot.generatedAt)}
              </time>
              <span>{formatDuration(snapshot.uptimeSeconds)} uptime</span>
              <span>{formatBytes(snapshot.memory.rss)} RSS</span>
              <span>{formatBytes(snapshot.memory.heapUsed)} heap</span>
              <span>{snapshot.totals.tabs} tabs</span>
              <span>{snapshot.totals.runningSessions} running</span>
              <span>
                {snapshot.totals.bridges} bridge
                {snapshot.totals.bridges === 1 ? '' : 's'}
              </span>
              <span>{snapshot.totals.webSockets} sockets</span>
              <span>
                Cleanup {snapshot.cleanup.enabled ? 'enabled' : 'disabled'}
                {snapshot.cleanup.running ? ', running' : ''}
              </span>
              <span>
                Last run{' '}
                {snapshot.cleanup.lastRunAt === null
                  ? 'never'
                  : formatTime(snapshot.cleanup.lastRunAt)}
              </span>
            </section>

            {controller.error ? (
              <p className="admin-inline-error" role="alert">
                {controller.error}
              </p>
            ) : null}
            {controller.cleanupError ? (
              <p className="admin-inline-error" role="alert">
                {controller.cleanupError}
              </p>
            ) : null}
            {controller.cleanupResult ? (
              <p className="admin-cleanup-result" role="status">
                Cleanup examined {controller.cleanupResult.examined}, terminated{' '}
                {controller.cleanupResult.terminated}, skipped{' '}
                {controller.cleanupResult.skipped}, failed{' '}
                {controller.cleanupResult.failed}.
              </p>
            ) : null}

            <section
              className="admin-table-scroll"
              role="region"
              aria-label="Terminal sessions"
              tabIndex={0}
            >
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">State</th>
                    <th scope="col">Timing</th>
                    <th scope="col">Connections</th>
                    <th scope="col">Cleanup</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {snapshot.sessions.map((row) => (
                    <SessionRow
                      key={row.id}
                      row={row}
                      busy={controller.busySessionIds.has(row.id)}
                      actionError={controller.sessionErrors[row.id]}
                      onAction={(action) => {
                        if (
                          action === 'terminate' ||
                          action === 'restart_session'
                        ) {
                          setConfirmation({
                            kind: action,
                            id: row.id,
                            name: row.displayName,
                          });
                        } else {
                          void controller.runSessionAction(row.id, action);
                        }
                      }}
                    />
                  ))}
                </tbody>
              </table>
              {snapshot.sessions.length === 0 ? (
                <div className="admin-empty">No terminal sessions</div>
              ) : null}
            </section>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmationTitle(confirmation)}
        description={confirmationDescription(confirmation)}
        confirmLabel={confirmationLabel(confirmation)}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirm}
      />
    </main>
  );
}

function SessionRow({
  row,
  busy,
  actionError,
  onAction,
}: Readonly<{
  row: AdminSessionRow;
  busy: boolean;
  actionError: string | undefined;
  onAction: (action: AdminAction) => void;
}>) {
  const active = row.desiredState === 'active';
  return (
    <tr aria-busy={busy || undefined}>
      <td>
        <strong>{row.displayName}</strong>
        <code>{row.id}</code>
        <code>{row.tmuxSessionName}</code>
      </td>
      <td>
        <span className={`admin-status status-${row.observedState}`}>
          <span aria-hidden="true" />
          {row.desiredState} / {row.observedState}
        </span>
        {row.lifecycleError ? (
          <span className="admin-row-error">{row.lifecycleError}</span>
        ) : null}
        {actionError ? (
          <span className="admin-row-error" role="alert">
            {actionError}
          </span>
        ) : null}
      </td>
      <td>
        <span>{formatDuration(row.ageSeconds)} old</span>
        <time dateTime={row.createdAt} title={row.createdAt}>
          Created {formatTime(row.createdAt)}
        </time>
        <time dateTime={row.lastActivityAt} title={row.lastActivityAt}>
          Active {formatTime(row.lastActivityAt)}
        </time>
      </td>
      <td>
        <span>
          {row.connectedWebSockets} WebSocket
          {row.connectedWebSockets === 1 ? '' : 's'}
        </span>
        <span>
          {row.bridgePid === null ? 'No bridge' : `PID ${row.bridgePid}`}
        </span>
      </td>
      <td>
        <span className={row.cleanupEligible ? 'cleanup-eligible' : undefined}>
          {row.cleanupEligible ? 'Eligible' : 'Not eligible'}
        </span>
      </td>
      <td>
        <div className="admin-row-actions">
          {active ? (
            <>
              <ActionButton
                label={`Restart bridge for ${row.displayName}`}
                disabled={busy}
                onClick={() => onAction('restart_bridge')}
                icon={<ServerCog size={15} aria-hidden="true" />}
              />
              <ActionButton
                label={`Restart session for ${row.displayName}`}
                disabled={busy}
                onClick={() => onAction('restart_session')}
                icon={<RotateCcw size={15} aria-hidden="true" />}
              />
              <ActionButton
                label={`Terminate session for ${row.displayName}`}
                disabled={busy}
                danger
                onClick={() => onAction('terminate')}
                icon={<Trash2 size={15} aria-hidden="true" />}
              />
            </>
          ) : (
            <ActionButton
              label={`Recreate session for ${row.displayName}`}
              disabled={busy}
              onClick={() => onAction('recreate')}
              icon={<Play size={15} aria-hidden="true" />}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

function ActionButton({
  label,
  disabled,
  danger = false,
  onClick,
  icon,
}: Readonly<{
  label: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}>) {
  return (
    <button
      className={`icon-button${danger ? ' danger-icon' : ''}`}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  const bounded = Math.max(0, Math.floor(seconds));
  const days = Math.floor(bounded / 86_400);
  const hours = Math.floor((bounded % 86_400) / 3600);
  const minutes = Math.floor((bounded % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${bounded}s`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function formatCanonicalTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Unavailable';
  return parsed
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function confirmationTitle(value: Confirmation | null): string {
  if (value?.kind === 'cleanup') return 'Run stale cleanup?';
  if (value?.kind === 'restart_session') return 'Restart session?';
  return 'Terminate session?';
}

function confirmationDescription(value: Confirmation | null): string {
  if (value?.kind === 'cleanup')
    return `This can terminate inactive shells. ${value.eligible} currently eligible.`;
  if (value?.kind === 'restart_session')
    return `This terminates and recreates the shell for ${value.name}.`;
  if (value?.kind === 'terminate')
    return `This terminates the running shell for ${value.name}.`;
  return '';
}

function confirmationLabel(value: Confirmation | null): string {
  if (value?.kind === 'cleanup') return 'Run cleanup';
  if (value?.kind === 'restart_session') return 'Restart session';
  return 'Terminate session';
}
