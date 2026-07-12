import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

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
    cancelRef.current?.focus();
    return () => restoreFocusRef.current?.focus();
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
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
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
