// @vitest-environment jsdom

import type { AdminSnapshot } from '@flanterminal/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import './test/setup.js';
import { AdminApiError, type AdminApi } from './admin-api.js';
import { ADMIN_POLL_INTERVAL_MS, useAdmin } from './useAdmin.js';

const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '223e4567-e89b-42d3-a456-426614174000';

const snapshot = (generatedAt = '2026-07-13T12:00:00.000Z'): AdminSnapshot => ({
  generatedAt,
  uptimeSeconds: 3600,
  memory: { rss: 64_000_000, heapUsed: 24_000_000 },
  totals: { tabs: 2, runningSessions: 2, bridges: 0, webSockets: 0 },
  cleanup: { enabled: true, running: false, lastRunAt: null },
  sessions: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function api(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    load: vi.fn(async () => snapshot()),
    sessionAction: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => ({
      disabled: false,
      examined: 2,
      terminated: 1,
      skipped: 1,
      failed: 0,
      startedAt: '2026-07-13T12:00:00.000Z',
      finishedAt: '2026-07-13T12:00:01.000Z',
    })),
    ...overrides,
  };
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('useAdmin', () => {
  it('loads and polls only while the admin view and document are visible', async () => {
    vi.useFakeTimers();
    const client = api();
    const { result, rerender } = renderHook(
      ({ active }) => useAdmin(client, { active }),
      { initialProps: { active: false } },
    );
    expect(client.load).not.toHaveBeenCalled();

    rerender({ active: true });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(client.load).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toEqual(snapshot());

    await act(async () => vi.advanceTimersByTimeAsync(ADMIN_POLL_INTERVAL_MS));
    expect(client.load).toHaveBeenCalledTimes(2);

    act(() => setVisibility('hidden'));
    await act(async () =>
      vi.advanceTimersByTimeAsync(ADMIN_POLL_INTERVAL_MS * 2),
    );
    expect(client.load).toHaveBeenCalledTimes(2);

    act(() => setVisibility('visible'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(client.load).toHaveBeenCalledTimes(3);
    rerender({ active: false });
    await act(async () => vi.advanceTimersByTimeAsync(ADMIN_POLL_INTERVAL_MS));
    expect(client.load).toHaveBeenCalledTimes(3);
  });

  it('never overlaps snapshot GETs and manual refresh joins the active request', async () => {
    const pending = deferred<AdminSnapshot>();
    const client = api({ load: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(client.load).toHaveBeenCalledOnce());

    let one!: Promise<void>;
    let two!: Promise<void>;
    act(() => {
      one = result.current.refresh();
      two = result.current.refresh();
    });
    expect(client.load).toHaveBeenCalledOnce();
    pending.resolve(snapshot());
    await act(async () => Promise.all([one, two]));
    expect(client.load).toHaveBeenCalledOnce();
  });

  it('aborts on hide/unmount and suppresses a late response from an old epoch', async () => {
    const first = deferred<AdminSnapshot>();
    const second = deferred<AdminSnapshot>();
    const signals: AbortSignal[] = [];
    const client = api({
      load: vi.fn<AdminApi['load']>((signal) => {
        signals.push(signal!);
        return signals.length === 1 ? first.promise : second.promise;
      }),
    });
    const hook = renderHook(({ active }) => useAdmin(client, { active }), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(client.load).toHaveBeenCalledOnce());
    hook.rerender({ active: false });
    expect(signals[0]?.aborted).toBe(true);
    hook.rerender({ active: true });
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(2));
    second.resolve(snapshot('2026-07-13T13:00:00.000Z'));
    await waitFor(() =>
      expect(hook.result.current.snapshot?.generatedAt).toBe(
        '2026-07-13T13:00:00.000Z',
      ),
    );
    first.resolve(snapshot('2026-07-13T11:00:00.000Z'));
    await act(async () => Promise.resolve());
    expect(hook.result.current.snapshot?.generatedAt).toBe(
      '2026-07-13T13:00:00.000Z',
    );
    hook.unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('aborts pending row actions when the administration view closes', async () => {
    const pending = deferred<void>();
    let signal: AbortSignal | undefined;
    const client = api({
      sessionAction: vi.fn((_id, _action, nextSignal) => {
        signal = nextSignal;
        return pending.promise;
      }),
    });
    const hook = renderHook(({ active }) => useAdmin(client, { active }), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    act(() => {
      void hook.result.current.runSessionAction(A, 'restart_bridge');
    });
    await waitFor(() => expect(client.sessionAction).toHaveBeenCalledOnce());
    hook.rerender({ active: false });
    expect(signal?.aborted).toBe(true);
    pending.resolve();
  });

  it('serializes actions for one tab while unrelated rows remain independent', async () => {
    const firstA = deferred<void>();
    const calls: string[] = [];
    const sessionAction = vi.fn<AdminApi['sessionAction']>(
      async (id, action) => {
        calls.push(`${id}:${action}`);
        if (id === A && action === 'terminate') await firstA.promise;
      },
    );
    const client = api({ sessionAction });
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    let terminate!: Promise<void>;
    let recreate!: Promise<void>;
    let bridge!: Promise<void>;
    act(() => {
      terminate = result.current.runSessionAction(A, 'terminate');
      recreate = result.current.runSessionAction(A, 'recreate');
      bridge = result.current.runSessionAction(B, 'restart_bridge');
    });
    await waitFor(() => expect(sessionAction).toHaveBeenCalledTimes(2));
    expect(calls).toEqual([`${A}:terminate`, `${B}:restart_bridge`]);
    expect(result.current.busySessionIds).toEqual(new Set([A]));
    firstA.resolve();
    await act(async () => Promise.all([terminate, recreate, bridge]));
    expect(calls).toEqual([
      `${A}:terminate`,
      `${B}:restart_bridge`,
      `${A}:recreate`,
    ]);
    expect(client.load).toHaveBeenCalledTimes(4);
  });

  it('starts a distinct authoritative GET causally after every completed mutation', async () => {
    const actionA = deferred<void>();
    const actionB = deferred<void>();
    const getA = deferred<AdminSnapshot>();
    const getB = deferred<AdminSnapshot>();
    let loadCount = 0;
    const client = api({
      load: vi.fn(() => {
        loadCount += 1;
        if (loadCount === 1) return Promise.resolve(snapshot());
        if (loadCount === 2) return getA.promise;
        return getB.promise;
      }),
      sessionAction: vi.fn((id) =>
        id === A ? actionA.promise : actionB.promise,
      ),
    });
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.runSessionAction(A, 'restart_bridge');
      second = result.current.runSessionAction(B, 'restart_bridge');
    });
    await waitFor(() => expect(client.sessionAction).toHaveBeenCalledTimes(2));
    actionA.resolve();
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(2));
    actionB.resolve();
    await act(async () => Promise.resolve());
    expect(client.load).toHaveBeenCalledTimes(2);

    getA.resolve(snapshot('2026-07-13T13:00:00.000Z'));
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(3));
    getB.resolve(snapshot('2026-07-13T14:00:00.000Z'));
    await act(async () => Promise.all([first, second]));
    expect(result.current.snapshot?.generatedAt).toBe(
      '2026-07-13T14:00:00.000Z',
    );
  });

  it('invalidates same-session queued work when the view ownership epoch closes', async () => {
    const actionA = deferred<void>();
    let loads = 0;
    const sessionAction = vi.fn<AdminApi['sessionAction']>(
      () => actionA.promise,
    );
    const client = api({
      sessionAction,
      load: vi.fn(async () => {
        loads += 1;
        return snapshot(
          loads === 1 ? '2026-07-13T12:00:00.000Z' : '2026-07-13T15:00:00.000Z',
        );
      }),
    });
    const hook = renderHook(({ active }) => useAdmin(client, { active }), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    act(() => {
      void hook.result.current.runSessionAction(A, 'terminate');
      void hook.result.current.runSessionAction(A, 'recreate');
    });
    await waitFor(() => expect(sessionAction).toHaveBeenCalledOnce());

    hook.rerender({ active: false });
    hook.rerender({ active: true });
    await waitFor(() =>
      expect(hook.result.current.snapshot?.generatedAt).toBe(
        '2026-07-13T15:00:00.000Z',
      ),
    );
    const reopenedSnapshot = hook.result.current.snapshot;
    actionA.resolve();
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    expect(sessionAction).toHaveBeenCalledOnce();
    expect(hook.result.current.snapshot).toBe(reopenedSnapshot);
    expect(hook.result.current.sessionErrors).toEqual({});
    expect(hook.result.current.busySessionIds.size).toBe(0);
  });

  it('invalidates queued work across a hidden and reopened document epoch', async () => {
    const actionA = deferred<void>();
    const sessionAction = vi.fn<AdminApi['sessionAction']>(
      () => actionA.promise,
    );
    const client = api({ sessionAction });
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => {
      void result.current.runSessionAction(A, 'terminate');
      void result.current.runSessionAction(A, 'recreate');
    });
    await waitFor(() => expect(sessionAction).toHaveBeenCalledOnce());

    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(2));
    actionA.resolve();
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    expect(sessionAction).toHaveBeenCalledOnce();
    expect(result.current.sessionErrors).toEqual({});
    expect(result.current.busySessionIds.size).toBe(0);
  });

  it('invalidates queued work after authentication loss before a new view epoch', async () => {
    const actionA = deferred<void>();
    const onAuthenticationRequired = vi.fn();
    let loads = 0;
    const sessionAction = vi.fn<AdminApi['sessionAction']>(
      () => actionA.promise,
    );
    const client = api({
      sessionAction,
      load: vi.fn(async () => {
        loads += 1;
        if (loads === 2)
          throw new AdminApiError('authentication_required', 401);
        return snapshot(`2026-07-13T1${loads}:00:00.000Z`);
      }),
    });
    const hook = renderHook(
      ({ active }) => useAdmin(client, { active, onAuthenticationRequired }),
      { initialProps: { active: true } },
    );
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    act(() => {
      void hook.result.current.runSessionAction(A, 'terminate');
      void hook.result.current.runSessionAction(A, 'recreate');
    });
    await waitFor(() => expect(sessionAction).toHaveBeenCalledOnce());
    await act(async () => hook.result.current.refresh());
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();

    hook.rerender({ active: false });
    hook.rerender({ active: true });
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(3));
    actionA.resolve();
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    expect(sessionAction).toHaveBeenCalledOnce();
    expect(hook.result.current.sessionErrors).toEqual({});
    expect(hook.result.current.busySessionIds.size).toBe(0);
  });

  it('keeps repeated open-close queue invalidation bounded to current work', async () => {
    const pending: Array<ReturnType<typeof deferred<void>>> = [];
    const sessionAction = vi.fn<AdminApi['sessionAction']>(() => {
      const next = deferred<void>();
      pending.push(next);
      return next.promise;
    });
    const client = api({ sessionAction });
    const hook = renderHook(({ active }) => useAdmin(client, { active }), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());

    for (let index = 0; index < 6; index += 1) {
      act(() => {
        void hook.result.current.runSessionAction(A, 'terminate');
        void hook.result.current.runSessionAction(A, 'recreate');
      });
      await waitFor(() =>
        expect(sessionAction).toHaveBeenCalledTimes(index + 1),
      );
      hook.rerender({ active: false });
      hook.rerender({ active: true });
      await waitFor(() => expect(client.load).toHaveBeenCalledTimes(index + 2));
      pending[index]!.resolve();
      await act(async () => Promise.resolve());
      await act(async () => Promise.resolve());
      expect(hook.result.current.busySessionIds.size).toBe(0);
    }

    expect(sessionAction).toHaveBeenCalledTimes(6);
    expect(
      sessionAction.mock.calls.every(([, action]) => action === 'terminate'),
    ).toBe(true);
    expect(hook.result.current.sessionErrors).toEqual({});
  });

  it('refetches authority after a failed action and isolates its bounded row error', async () => {
    let includeRows = true;
    const row = (id: string) => ({
      id,
      displayName: id === A ? 'One' : 'Two',
      tmuxSessionName: `webterm-${id}`,
      desiredState: 'active' as const,
      observedState: 'running' as const,
      createdAt: '2026-07-13T11:00:00.000Z',
      lastActivityAt: '2026-07-13T11:59:00.000Z',
      ageSeconds: 3600,
      connectedWebSockets: 0,
      bridgePid: null,
      cleanupEligible: false,
      lifecycleError: null,
    });
    const client = api({
      load: vi.fn(async () => ({
        ...snapshot(),
        sessions: includeRows ? [row(A), row(B)] : [],
      })),
      sessionAction: vi.fn(async (id) => {
        if (id === A) throw new Error('secret backend detail');
      }),
    });
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    await act(async () =>
      result.current.runSessionAction(A, 'restart_session'),
    );
    expect(result.current.sessionErrors[A]).toBe('Session action failed.');
    expect(result.current.sessionErrors[B]).toBeUndefined();
    expect(client.load).toHaveBeenCalledTimes(2);

    includeRows = false;
    await act(async () => result.current.refresh());
    expect(result.current.sessionErrors[A]).toBeUndefined();
  });

  it('runs cleanup independently and refetches the authoritative snapshot', async () => {
    const client = api();
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => result.current.runCleanup());
    expect(result.current.cleanupResult?.terminated).toBe(1);
    expect(client.load).toHaveBeenCalledTimes(2);
    expect(result.current.cleanupBusy).toBe(false);
  });

  it('does not enqueue post-mutation authority for an aborted cleanup', async () => {
    const client = api({
      cleanup: vi.fn(async () => {
        throw new DOMException('cancelled', 'AbortError');
      }),
    });
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => result.current.runCleanup());
    expect(client.load).toHaveBeenCalledOnce();
    expect(result.current.cleanupError).toBeNull();
  });

  it('clears a prior cleanup result before a new attempt can fail', async () => {
    const second = deferred<never>();
    const cleanup = vi
      .fn<AdminApi['cleanup']>()
      .mockResolvedValueOnce({
        disabled: false,
        examined: 2,
        terminated: 1,
        skipped: 1,
        failed: 0,
        startedAt: '2026-07-13T12:00:00.000Z',
        finishedAt: '2026-07-13T12:00:01.000Z',
      })
      .mockImplementationOnce(() => second.promise);
    const client = api({ cleanup });
    const { result } = renderHook(() => useAdmin(client, { active: true }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => result.current.runCleanup());
    expect(result.current.cleanupResult?.terminated).toBe(1);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runCleanup();
    });
    expect(result.current.cleanupBusy).toBe(true);
    expect(result.current.cleanupResult).toBeNull();
    second.reject(new Error('private cleanup detail'));
    await act(async () => pending);
    expect(result.current.cleanupResult).toBeNull();
    expect(result.current.cleanupError).toBe('Stale session cleanup failed.');
  });

  it('propagates authentication loss, aborts ownership, and exposes no server detail', async () => {
    const onAuthenticationRequired = vi.fn();
    const client = api({
      load: vi.fn(async () => {
        throw new AdminApiError('authentication_required', 401);
      }),
    });
    const { result } = renderHook(() =>
      useAdmin(client, { active: true, onAuthenticationRequired }),
    );
    await waitFor(() =>
      expect(onAuthenticationRequired).toHaveBeenCalledOnce(),
    );
    expect(result.current.error).toBeNull();
    await act(async () => result.current.refresh());
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await act(async () => Promise.resolve());
    expect(client.load).toHaveBeenCalledOnce();
  });
});
