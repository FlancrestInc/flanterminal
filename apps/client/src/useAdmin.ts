import type {
  AdminAction,
  AdminSnapshot,
  CleanupResult,
} from '@flanterminal/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminApiError, type AdminApi } from './admin-api.js';

export const ADMIN_POLL_INTERVAL_MS = 10_000;
const LOAD_ERROR = 'Unable to load administration status.';
const ACTION_ERROR = 'Session action failed.';
const CLEANUP_ERROR = 'Stale session cleanup failed.';

export type UseAdminOptions = Readonly<{
  active: boolean;
  onAuthenticationRequired?: () => void;
}>;

export interface AdminController {
  readonly snapshot: AdminSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly sessionErrors: Readonly<Record<string, string>>;
  readonly busySessionIds: ReadonlySet<string>;
  readonly cleanupBusy: boolean;
  readonly cleanupError: string | null;
  readonly cleanupResult: CleanupResult | null;
  readonly refresh: () => Promise<void>;
  readonly runSessionAction: (id: string, action: AdminAction) => Promise<void>;
  readonly runCleanup: () => Promise<void>;
}

type ActiveRequest = Readonly<{
  controller: AbortController;
  epoch: number;
  promise: Promise<void>;
}>;

type PostMutationTail = Readonly<{
  epoch: number;
  promise: Promise<void>;
}>;

export function useAdmin(
  api: AdminApi,
  options: UseAdminOptions,
): AdminController {
  const { active, onAuthenticationRequired } = options;
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionErrors, setSessionErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [busySessionIds, setBusySessionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(
    null,
  );
  const mountedRef = useRef(true);
  const activeRef = useRef(false);
  const authLostRef = useRef(false);
  const epochRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef<ActiveRequest | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const postMutationTailRef = useRef<PostMutationTail | null>(null);
  const enqueuePostMutationRefreshRef = useRef<
    (epoch: number) => Promise<void>
  >(async () => undefined);
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const actionControllersRef = useRef(new Set<AbortController>());
  const busyCountsRef = useRef(new Map<string, number>());
  const cleanupPromiseRef = useRef<Promise<void> | null>(null);
  const cleanupControllerRef = useRef<AbortController | null>(null);

  const ownsEpoch = useCallback(
    (epoch: number) =>
      mountedRef.current &&
      activeRef.current &&
      !authLostRef.current &&
      epochRef.current === epoch,
    [],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopOwnership = useCallback(() => {
    activeRef.current = false;
    epochRef.current += 1;
    clearTimer();
    requestRef.current?.controller.abort();
    requestRef.current = null;
    for (const controller of actionControllersRef.current) controller.abort();
    actionControllersRef.current.clear();
    queuesRef.current.clear();
    postMutationTailRef.current = null;
    busyCountsRef.current.clear();
    cleanupControllerRef.current?.abort();
    cleanupControllerRef.current = null;
    cleanupPromiseRef.current = null;
    if (mountedRef.current) {
      setBusySessionIds(new Set());
      setCleanupBusy(false);
    }
  }, [clearTimer]);

  const loseAuthentication = useCallback(() => {
    if (authLostRef.current) return;
    authLostRef.current = true;
    stopOwnership();
    onAuthenticationRequired?.();
  }, [onAuthenticationRequired, stopOwnership]);

  const schedule = useCallback(() => {
    clearTimer();
    if (
      !mountedRef.current ||
      !activeRef.current ||
      authLostRef.current ||
      document.visibilityState !== 'visible'
    )
      return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void refreshRef.current();
    }, ADMIN_POLL_INTERVAL_MS);
  }, [clearTimer]);

  const startRefresh = useCallback(
    (epoch: number): Promise<void> => {
      if (!ownsEpoch(epoch) || document.visibilityState !== 'visible')
        return Promise.resolve();
      clearTimer();
      const controller = new AbortController();
      setLoading(true);
      setError(null);
      const promise = (async () => {
        try {
          const next = await api.load(controller.signal);
          if (ownsEpoch(epoch) && !controller.signal.aborted) {
            setSnapshot(next);
            const retainedIds = new Set(next.sessions.map((row) => row.id));
            setSessionErrors((current) => {
              const retained = Object.fromEntries(
                Object.entries(current).filter(([id]) => retainedIds.has(id)),
              );
              return Object.keys(retained).length ===
                Object.keys(current).length
                ? current
                : retained;
            });
          }
        } catch (reason) {
          if (controller.signal.aborted || isAbortError(reason)) return;
          if (isAuthLoss(reason)) loseAuthentication();
          else if (ownsEpoch(epoch)) setError(LOAD_ERROR);
        } finally {
          if (requestRef.current?.controller === controller)
            requestRef.current = null;
          if (ownsEpoch(epoch) && !controller.signal.aborted) {
            setLoading(false);
            schedule();
          }
        }
      })();
      requestRef.current = { controller, epoch, promise };
      return promise;
    },
    [api, clearTimer, loseAuthentication, ownsEpoch, schedule],
  );

  const refresh = useCallback((): Promise<void> => {
    if (
      !mountedRef.current ||
      !activeRef.current ||
      authLostRef.current ||
      document.visibilityState !== 'visible'
    )
      return Promise.resolve();
    const existing = requestRef.current;
    if (existing !== null) return existing.promise;
    const epoch = epochRef.current;
    return startRefresh(epoch);
  }, [startRefresh]);
  refreshRef.current = refresh;

  const forcePostMutationRefresh = useCallback(
    async (epoch: number): Promise<void> => {
      const existing = requestRef.current;
      if (existing !== null) await existing.promise;
      if (!ownsEpoch(epoch)) return;
      await startRefresh(epoch);
    },
    [ownsEpoch, startRefresh],
  );

  const enqueuePostMutationRefresh = useCallback(
    (epoch: number): Promise<void> => {
      if (!ownsEpoch(epoch)) return Promise.resolve();
      const currentTail = postMutationTailRef.current;
      const prior =
        currentTail?.epoch === epoch ? currentTail.promise : Promise.resolve();
      const operation = prior
        .catch(() => undefined)
        .then(async () => forcePostMutationRefresh(epoch));
      const tracked = operation.finally(() => {
        if (postMutationTailRef.current?.promise === tracked)
          postMutationTailRef.current = null;
      });
      postMutationTailRef.current = { epoch, promise: tracked };
      return tracked;
    },
    [forcePostMutationRefresh, ownsEpoch],
  );
  enqueuePostMutationRefreshRef.current = enqueuePostMutationRefresh;

  useEffect(() => {
    mountedRef.current = true;
    if (active && document.visibilityState === 'visible') {
      authLostRef.current = false;
      activeRef.current = true;
      epochRef.current += 1;
      void refreshRef.current();
    } else {
      stopOwnership();
    }

    const visibilityChanged = () => {
      if (!active || document.visibilityState !== 'visible') {
        stopOwnership();
        return;
      }
      if (authLostRef.current) return;
      activeRef.current = true;
      epochRef.current += 1;
      void refreshRef.current();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      stopOwnership();
    };
  }, [active, stopOwnership]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      stopOwnership();
      for (const controller of actionControllersRef.current) controller.abort();
      cleanupControllerRef.current?.abort();
    },
    [stopOwnership],
  );

  const changeBusy = useCallback((id: string, delta: 1 | -1) => {
    const next = (busyCountsRef.current.get(id) ?? 0) + delta;
    if (next <= 0) busyCountsRef.current.delete(id);
    else busyCountsRef.current.set(id, next);
    if (mountedRef.current)
      setBusySessionIds(new Set(busyCountsRef.current.keys()));
  }, []);

  const runSessionAction = useCallback(
    (id: string, action: AdminAction): Promise<void> => {
      const ownershipEpoch = epochRef.current;
      if (!ownsEpoch(ownershipEpoch)) return Promise.resolve();
      changeBusy(id, 1);
      const previous = queuesRef.current.get(id) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          if (!ownsEpoch(ownershipEpoch)) return;
          const controller = new AbortController();
          actionControllersRef.current.add(controller);
          setSessionErrors((current) => {
            if (current[id] === undefined) return current;
            const next = { ...current };
            delete next[id];
            return next;
          });
          let refreshRequired = false;
          try {
            await api.sessionAction(id, action, controller.signal);
            refreshRequired = true;
          } catch (reason) {
            if (controller.signal.aborted || isAbortError(reason)) return;
            if (isAuthLoss(reason)) loseAuthentication();
            else if (ownsEpoch(ownershipEpoch)) {
              refreshRequired = true;
              setSessionErrors((current) => ({
                ...current,
                [id]: ACTION_ERROR,
              }));
            }
          } finally {
            actionControllersRef.current.delete(controller);
            if (
              refreshRequired &&
              !controller.signal.aborted &&
              ownsEpoch(ownershipEpoch)
            )
              await enqueuePostMutationRefreshRef.current(ownershipEpoch);
          }
        });
      const tracked = operation.finally(() => {
        if (ownsEpoch(ownershipEpoch)) changeBusy(id, -1);
        if (queuesRef.current.get(id) === tracked) queuesRef.current.delete(id);
      });
      queuesRef.current.set(id, tracked);
      return tracked;
    },
    [api, changeBusy, loseAuthentication, ownsEpoch],
  );

  const runCleanup = useCallback((): Promise<void> => {
    if (cleanupPromiseRef.current !== null) return cleanupPromiseRef.current;
    const ownershipEpoch = epochRef.current;
    if (!ownsEpoch(ownershipEpoch)) return Promise.resolve();
    const controller = new AbortController();
    cleanupControllerRef.current = controller;
    setCleanupBusy(true);
    setCleanupError(null);
    setCleanupResult(null);
    const operation = (async () => {
      let refreshRequired = false;
      try {
        const result = await api.cleanup(controller.signal);
        refreshRequired = true;
        if (ownsEpoch(ownershipEpoch) && !controller.signal.aborted)
          setCleanupResult(result);
      } catch (reason) {
        if (controller.signal.aborted || isAbortError(reason)) return;
        if (isAuthLoss(reason)) loseAuthentication();
        else if (ownsEpoch(ownershipEpoch)) {
          refreshRequired = true;
          setCleanupError(CLEANUP_ERROR);
        }
      } finally {
        if (
          refreshRequired &&
          ownsEpoch(ownershipEpoch) &&
          !controller.signal.aborted
        )
          await enqueuePostMutationRefreshRef.current(ownershipEpoch);
        if (cleanupControllerRef.current === controller)
          cleanupControllerRef.current = null;
        if (ownsEpoch(ownershipEpoch)) setCleanupBusy(false);
      }
    })().finally(() => {
      if (cleanupPromiseRef.current === operation)
        cleanupPromiseRef.current = null;
    });
    cleanupPromiseRef.current = operation;
    return operation;
  }, [api, loseAuthentication, ownsEpoch]);

  return {
    snapshot,
    loading,
    error,
    sessionErrors,
    busySessionIds,
    cleanupBusy,
    cleanupError,
    cleanupResult,
    refresh,
    runSessionAction,
    runCleanup,
  };
}

function isAuthLoss(error: unknown): boolean {
  return error instanceof AdminApiError && error.status === 401;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
