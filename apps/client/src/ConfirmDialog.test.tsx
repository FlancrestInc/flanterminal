// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import './test/setup.js';

import { ConfirmDialog, type ConfirmDialogHandle } from './ConfirmDialog.js';

describe('ConfirmDialog', () => {
  it('labels destructive confirmation and starts focus on Cancel', () => {
    const ref = createRef<ConfirmDialogHandle>();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        ref={ref}
        open
        title="Terminate session?"
        description="The running shell will stop."
        confirmLabel="Terminate"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Terminate session?',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('cancels on Escape and restores the invoking control', () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Open menu</button>
        <ConfirmDialog
          open={false}
          title="Close tab?"
          description="This stops the shell."
          confirmLabel="Close"
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />
      </>,
    );
    screen.getByRole('button', { name: 'Open menu' }).focus();
    rerender(
      <>
        <button type="button">Open menu</button>
        <ConfirmDialog
          open
          title="Close tab?"
          description="This stops the shell."
          confirmLabel="Close"
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />
      </>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('wraps Tab focus within the modal and recaptures outside focus', () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Terminate' });
    const outside = screen.getByRole('button', { name: 'Underlying control' });

    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    outside.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(cancel).toHaveFocus();
  });

  it.each(['escape', 'cancel', 'confirm'] as const)(
    'restores invoking focus after %s closes the modal',
    (method) => {
      render(<DialogHarness />);
      const trigger = screen.getByRole('button', { name: 'Open dialog' });
      trigger.focus();
      fireEvent.click(trigger);
      if (method === 'escape') {
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      } else {
        fireEvent.click(
          screen.getByRole('button', {
            name: method === 'cancel' ? 'Cancel' : 'Terminate',
          }),
        );
      }
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    },
  );
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <button type="button">Underlying control</button>
      <ConfirmDialog
        open={open}
        title="Terminate session?"
        description="The running shell will stop."
        confirmLabel="Terminate"
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}
