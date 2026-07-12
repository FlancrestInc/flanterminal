import type { TabCollectionResponse, TabView } from '@flanterminal/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { TabApiError, type TabsApi } from './tabs-api.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SAFE_ERROR = 'Unable to update terminal tabs.';

export type UseTabsOptions = Readonly<{ pollIntervalMs?: number }>;

export interface TabsController {
  readonly tabs: readonly TabView[];
  readonly structureRevision: number;
  readonly selectedId: string | null;
  readonly visitedIds: ReadonlySet<string>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly select: (id: string) => void;
  readonly refresh: () => Promise<void>;
  readonly create: (displayName?: string) => Promise<void>;
  readonly rename: (id: string, displayName: string) => Promise<void>;
  readonly reorder: (ids: readonly string[]) => Promise<void>;
  readonly close: (id: string) => Promise<void>;
  readonly health: (id: string) => Promise<boolean>;
  readonly terminate: (id: string) => Promise<boolean>;
  readonly recreate: (id: string) => Promise<boolean>;
  readonly restart: (id: string) => Promise<boolean>;
  readonly restartBridge: (id: string) => Promise<boolean>;
}

export function useTabs(
  api: TabsApi,
  options: UseTabsOptions = {},
): TabsController {
  const [collection, setCollection] = useState<TabCollectionResponse>({
    structureRevision: 0,
    tabs: [],
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const revisionRef = useRef(collection.structureRevision);
  revisionRef.current = collection.structureRevision;

  const applyCollection = useCallback((next: TabCollectionResponse) => {
    setCollection(next);
    setSelectedId((current) =>
      current !== null && next.tabs.some((tab) => tab.id === current)
        ? current
        : (next.tabs[0]?.id ?? null),
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.list();
      if (!mountedRef.current) return;
      applyCollection(next);
      setError(null);
    } catch {
      if (mountedRef.current) setError(SAFE_ERROR);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api, applyCollection]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const selected = collection.tabs.find((tab) => tab.id === selectedId);
    if (selected?.desiredState !== 'active') return;
    setVisitedIds((current) => {
      if (current.has(selected.id)) return current;
      return new Set([...current, selected.id]);
    });
  }, [collection.tabs, selectedId]);

  useEffect(() => {
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        void refresh().finally(schedule);
      }, interval);
    };
    const onVisibility = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'visible')
        void refresh().finally(schedule);
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [options.pollIntervalMs, refresh]);

  const select = useCallback(
    (id: string) => {
      if (collection.tabs.some((tab) => tab.id === id)) setSelectedId(id);
    },
    [collection.tabs],
  );

  const create = useCallback(
    async (displayName?: string) => {
      try {
        const created = await api.create(displayName);
        setCollection((current) => ({
          structureRevision: current.structureRevision + 1,
          tabs: [...current.tabs, created],
        }));
        setSelectedId(created.id);
        setError(null);
      } catch {
        setError(SAFE_ERROR);
      }
    },
    [api],
  );

  const update = useCallback((tab: TabView) => {
    setCollection((current) => ({
      ...current,
      tabs: current.tabs.map((candidate) =>
        candidate.id === tab.id ? tab : candidate,
      ),
    }));
  }, []);

  const rename = useCallback(
    async (id: string, displayName: string) => {
      try {
        update(await api.rename(id, displayName));
        setError(null);
      } catch {
        setError(SAFE_ERROR);
      }
    },
    [api, update],
  );

  const reorder = useCallback(
    async (ids: readonly string[]) => {
      try {
        applyCollection(await api.reorder(revisionRef.current, ids));
        setError(null);
      } catch (reason) {
        if (reason instanceof TabApiError && reason.code === 'order_conflict') {
          await refresh();
          if (mountedRef.current) {
            setError('Tab order changed. Reloaded the latest order.');
          }
          return;
        }
        setError(SAFE_ERROR);
      }
    },
    [api, applyCollection, refresh],
  );

  const close = useCallback(
    async (id: string) => {
      try {
        await api.close(id);
        setCollection((current) => {
          const index = current.tabs.findIndex((tab) => tab.id === id);
          const tabs = current.tabs
            .filter((tab) => tab.id !== id)
            .map((tab, position) => ({ ...tab, position }));
          setSelectedId((selected) =>
            selected === id
              ? (tabs[Math.min(Math.max(index - 1, 0), tabs.length - 1)]?.id ??
                null)
              : selected,
          );
          return { structureRevision: current.structureRevision + 1, tabs };
        });
        setVisitedIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        setError(null);
      } catch {
        setError(SAFE_ERROR);
      }
    },
    [api],
  );

  const runLifecycle = useCallback(
    async (operation: (id: string) => Promise<TabView>, id: string) => {
      try {
        update(await operation(id));
        setError(null);
        return true;
      } catch {
        setError(SAFE_ERROR);
        return false;
      }
    },
    [update],
  );

  return {
    tabs: collection.tabs,
    structureRevision: collection.structureRevision,
    selectedId,
    visitedIds,
    loading,
    error,
    select,
    refresh,
    create,
    rename,
    reorder,
    close,
    health: (id) => runLifecycle(api.health, id),
    terminate: (id) => runLifecycle(api.terminate, id),
    recreate: (id) => runLifecycle(api.recreate, id),
    restart: (id) => runLifecycle(api.restart, id),
    restartBridge: (id) => runLifecycle(api.restartBridge, id),
  };
}
