// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TabApiError, type TabsApi } from './tabs-api.js';
import { useTabs } from './useTabs.js';

const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '223e4567-e89b-42d3-a456-426614174000';
const C = '323e4567-e89b-42d3-a456-426614174000';

function tab(
  id: string,
  position: number,
  desiredState: 'active' | 'stopped' = 'active',
) {
  return {
    id,
    displayName: `Terminal ${position + 1}`,
    position,
    createdAt: '2026-07-11T00:00:00.000Z',
    lastActivityAt: '2026-07-11T00:00:00.000Z',
    desiredState,
    session: {
      state:
        desiredState === 'active' ? ('running' as const) : ('stopped' as const),
      attached: false,
      bridgePid: null,
    },
  };
}

function api(initial = { structureRevision: 1, tabs: [tab(A, 0), tab(B, 1)] }) {
  let collection = initial;
  const client: TabsApi = {
    list: vi.fn(async () => collection),
    create: vi.fn(async () => tab(C, collection.tabs.length)),
    rename: vi.fn(async (id, name) => ({
      ...collection.tabs.find((item) => item.id === id)!,
      displayName: name,
    })),
    reorder: vi.fn(async (revision: number, ids: readonly string[]) => ({
      structureRevision: revision + 1,
      tabs: ids.map((id, position) => ({
        ...collection.tabs.find((item) => item.id === id)!,
        position,
      })),
    })),
    close: vi.fn(async () => undefined),
    health: vi.fn(async (id) =>
      collection.tabs.find((item) => item.id === id)!,
    ),
    terminate: vi.fn(async (id) => ({
      ...collection.tabs.find((item) => item.id === id)!,
      desiredState: 'stopped' as const,
    })),
    recreate: vi.fn(async (id) =>
      collection.tabs.find((item) => item.id === id)!,
    ),
    restart: vi.fn(async (id) =>
      collection.tabs.find((item) => item.id === id)!,
    ),
    restartBridge: vi.fn(async (id) =>
      collection.tabs.find((item) => item.id === id)!,
    ),
  };
  return {
    client,
    setCollection(next: typeof collection) {
      collection = next;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function settleLoad() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useTabs', () => {
  it('loads an authoritative collection and visits only the selected active tab', async () => {
    const { client } = api();
    const { result } = renderHook(() => useTabs(client));

    await settleLoad();
    expect(result.current.tabs.map(({ id }) => id)).toEqual([A, B]);
    expect(result.current.selectedId).toBe(A);
    expect([...result.current.visitedIds]).toEqual([A]);

    act(() => result.current.select(B));
    expect(result.current.selectedId).toBe(B);
    expect([...result.current.visitedIds]).toEqual([A, B]);
  });

  it('does not visit a selected stopped tab', async () => {
    const { client } = api({
      structureRevision: 1,
      tabs: [tab(A, 0, 'stopped')],
    });
    const { result } = renderHook(() => useTabs(client));
    await settleLoad();

    expect(result.current.selectedId).toBe(A);
    expect([...result.current.visitedIds]).toEqual([]);
  });

  it('creates and selects a new tab, then chooses a neighbor after close', async () => {
    const { client } = api();
    const { result } = renderHook(() => useTabs(client));
    await settleLoad();

    await act(async () => result.current.create('Shell'));
    expect(result.current.selectedId).toBe(C);
    expect(result.current.tabs.map(({ id }) => id)).toEqual([A, B, C]);

    await act(async () => result.current.close(C));
    expect(result.current.selectedId).toBe(B);
    expect(result.current.tabs.map(({ id }) => id)).toEqual([A, B]);
    expect(result.current.visitedIds.has(C)).toBe(false);
  });

  it('applies rename and reorder responses as the authority', async () => {
    const { client } = api();
    const { result } = renderHook(() => useTabs(client));
    await settleLoad();

    await act(async () => result.current.rename(A, 'Work'));
    expect(result.current.tabs[0]?.displayName).toBe('Work');
    await act(async () => result.current.reorder([B, A]));
    expect(client.reorder).toHaveBeenCalledWith(2, [B, A]);
    expect(result.current.tabs.map(({ id }) => id)).toEqual([B, A]);
    expect(result.current.structureRevision).toBe(3);
  });

  it('reloads the authoritative collection after an order conflict', async () => {
    const state = api();
    vi.mocked(state.client.reorder).mockRejectedValueOnce(
      new TabApiError('order_conflict'),
    );
    state.setCollection({ structureRevision: 5, tabs: [tab(B, 0), tab(A, 1)] });
    const { result } = renderHook(() => useTabs(state.client));
    await settleLoad();

    await act(async () => result.current.reorder([A, B]));
    expect(state.client.list).toHaveBeenCalledTimes(2);
    expect(result.current.tabs.map(({ id }) => id)).toEqual([B, A]);
    expect(result.current.error).toBe(
      'Tab order changed. Reloaded the latest order.',
    );
  });

  it('polls only while visible and refreshes when visibility returns', async () => {
    const state = api();
    const { result } = renderHook(() =>
      useTabs(state.client, { pollIntervalMs: 1_000 }),
    );
    await settleLoad();
    expect(state.client.list).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(state.client.list).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settleLoad();
    expect(state.client.list).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
  });
});
