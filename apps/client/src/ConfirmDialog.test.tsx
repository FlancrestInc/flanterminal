// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
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
});
