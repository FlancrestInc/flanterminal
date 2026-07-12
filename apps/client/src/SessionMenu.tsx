import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Eraser,
  RefreshCw,
  RotateCcw,
  Trash2,
  Unplug,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

export type SessionMenuProps = Readonly<{
  desiredState: 'active' | 'stopped';
  sessionState: 'running' | 'stopped' | 'unknown';
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onReconnect: () => void;
  onDetach: () => void;
  onClear: () => void;
  onRestartClient: () => void;
  onRestartBridge: () => void;
  onRestartSession: () => void;
  onTerminate: () => void;
  onRecreate: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
}>;

export function SessionMenu(props: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const item = (
    label: string,
    icon: ReactNode,
    action: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        action();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="session-menu">
      <button
        className="icon-button"
        type="button"
        title="Session actions"
        aria-label="Session actions"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={17} aria-hidden="true" />
      </button>
      {open ? (
        <div className="session-menu-popup" role="menu">
          <div className="session-health">Session: {props.sessionState}</div>
          {props.desiredState === 'active' ? (
            <>
              {item(
                'Reconnect',
                <RefreshCw size={14} aria-hidden="true" />,
                props.onReconnect,
              )}
              {item(
                'Detach browser',
                <Unplug size={14} aria-hidden="true" />,
                props.onDetach,
              )}
              {item(
                'Clear scrollback',
                <Eraser size={14} aria-hidden="true" />,
                props.onClear,
              )}
              {item(
                'Restart terminal client',
                <RotateCcw size={14} aria-hidden="true" />,
                props.onRestartClient,
              )}
              {item(
                'Restart bridge',
                <RefreshCw size={14} aria-hidden="true" />,
                props.onRestartBridge,
              )}
              {item(
                'Restart session',
                <RotateCcw size={14} aria-hidden="true" />,
                props.onRestartSession,
              )}
              {item(
                'Terminate session',
                <Trash2 size={14} aria-hidden="true" />,
                props.onTerminate,
              )}
            </>
          ) : (
            item(
              'Recreate session',
              <RotateCcw size={14} aria-hidden="true" />,
              props.onRecreate,
            )
          )}
          <div className="menu-separator" role="separator" />
          {item(
            'Move left',
            <ChevronLeft size={14} aria-hidden="true" />,
            props.onMoveLeft,
            !props.canMoveLeft,
          )}
          {item(
            'Move right',
            <ChevronRight size={14} aria-hidden="true" />,
            props.onMoveRight,
            !props.canMoveRight,
          )}
        </div>
      ) : null}
    </div>
  );
}
