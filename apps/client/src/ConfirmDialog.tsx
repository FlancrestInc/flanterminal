import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

export interface ConfirmDialogHandle {
  focusCancel(): void;
}

export type ConfirmDialogProps = Readonly<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}>;

export const ConfirmDialog = forwardRef<
  ConfirmDialogHandle,
  ConfirmDialogProps
>(function ConfirmDialog(
  { open, title, description, confirmLabel, onCancel, onConfirm },
  ref,
) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({ focusCancel: () => cancelRef.current?.focus() }),
    [],
  );

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (
        dialog !== null &&
        event.target instanceof Node &&
        !dialog.contains(event.target)
      )
        firstFocusable(dialog)?.focus();
    };
    document.addEventListener('focusin', containFocus);
    cancelRef.current?.focus();
    return () => {
      document.removeEventListener('focusin', containFocus);
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  if (!open) return null;
  const titleId = 'confirm-dialog-title';
  const descriptionId = 'confirm-dialog-description';
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Tab') {
            trapTabKey(event, dialogRef.current);
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger-button" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
});

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => {
      if (
        element.hidden ||
        element.getAttribute('aria-hidden') === 'true' ||
        element.closest('[hidden], [aria-hidden="true"]') !== null
      )
        return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    },
  );
}

function firstFocusable(dialog: HTMLElement): HTMLElement | undefined {
  return focusableElements(dialog)[0];
}

function trapTabKey(
  event: ReactKeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
): void {
  if (dialog === null) return;
  const focusable = focusableElements(dialog);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const current = document.activeElement;
  if (event.shiftKey && (current === first || !dialog.contains(current))) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (current === last || !dialog.contains(current))
  ) {
    event.preventDefault();
    first.focus();
  }
}
