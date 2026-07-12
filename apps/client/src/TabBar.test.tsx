// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import './test/setup.js';
import { TabBar } from './TabBar.js';

const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '223e4567-e89b-42d3-a456-426614174000';
const tabs = [
  { id: A, displayName: 'Work', desiredState: 'active' as const },
  { id: B, displayName: 'Logs', desiredState: 'stopped' as const },
];

function setup() {
  const handlers = {
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onReorder: vi.fn(),
    onRequestClose: vi.fn(),
  };
  render(
    <TabBar
      tabs={tabs}
      selectedId={A}
      statusFor={(id) => (id === A ? 'connected' : 'stopped')}
      {...handlers}
    />,
  );
  return handlers;
}

describe('TabBar', () => {
  it('selects, creates, and requests close with compact labelled controls', () => {
    const handlers = setup();
    expect(screen.getByRole('tab', { name: 'Work' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'New terminal tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Work' }));

    expect(handlers.onSelect).toHaveBeenCalledWith(B);
    expect(handlers.onCreate).toHaveBeenCalledOnce();
    expect(handlers.onRequestClose).toHaveBeenCalledWith(A);
  });

  it('renames inline on double click and commits with Enter', () => {
    const handlers = setup();
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Work' }));
    const input = screen.getByRole('textbox', { name: 'Rename Work' });
    fireEvent.change(input, { target: { value: 'Production' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onRename).toHaveBeenCalledWith(A, 'Production');
  });

  it('reorders by dragging one immutable tab ID onto another', () => {
    const handlers = setup();
    const work = screen.getByTestId(`tab-${A}`);
    const logs = screen.getByTestId(`tab-${B}`);
    fireEvent.dragStart(work);
    fireEvent.dragOver(logs);
    fireEvent.drop(logs);
    expect(handlers.onReorder).toHaveBeenCalledWith([B, A]);
  });
});
