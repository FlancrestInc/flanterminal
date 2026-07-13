import type { SettingsResponse, WorkspaceSettings } from '@flanterminal/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { SettingsApiError, type SettingsApi } from './settings-api.js';

const LOAD_ERROR = 'Unable to load settings.';
const SAVE_ERROR = 'Unable to save settings.';
const UNCERTAIN_ERROR =
  'Settings were saved, but durability could not be confirmed.';

export type UseSettingsOptions = Readonly<{
  onAuthenticationRequired?: () => void;
}>;

export interface SettingsController {
  readonly response: SettingsResponse | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly save: (settings: WorkspaceSettings) => Promise<void>;
  readonly retry: () => Promise<void>;
}

export function useSettings(
  api: SettingsApi,
  options: UseSettingsOptions = {},
): SettingsController {
  const onAuthenticationRequired = options.onAuthenticationRequired;
  const [response, setResponse] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadRef = useRef<AbortController | null>(null);
  const saveRef = useRef<AbortController | null>(null);
  const queueRef = useRef(Promise.resolve());

  const load = useCallback(async () => {
    loadRef.current?.abort();
    const controller = new AbortController();
    loadRef.current = controller;
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await api.load(controller.signal);
      if (mountedRef.current && !controller.signal.aborted) setResponse(next);
    } catch (reason) {
      if (isAbortError(reason) || controller.signal.aborted) return;
      if (isAuthLoss(reason)) onAuthenticationRequired?.();
      else if (mountedRef.current) setError(LOAD_ERROR);
    } finally {
      if (loadRef.current === controller) loadRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, [api, onAuthenticationRequired]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadRef.current?.abort();
      saveRef.current?.abort();
    };
  }, [load]);

  const save = useCallback(
    (settings: WorkspaceSettings) => {
      const candidate = structuredClone(settings);
      const operation = async () => {
        if (!mountedRef.current) return;
        const controller = new AbortController();
        saveRef.current = controller;
        if (mountedRef.current) {
          setBusy(true);
          setError(null);
        }
        try {
          const next = await api.replace(candidate, controller.signal);
          if (mountedRef.current && !controller.signal.aborted)
            setResponse(next);
        } catch (reason) {
          if (isAbortError(reason) || controller.signal.aborted) return;
          if (isAuthLoss(reason)) onAuthenticationRequired?.();
          else if (
            reason instanceof SettingsApiError &&
            reason.code === 'durability_uncertain'
          ) {
            if (mountedRef.current) setError(UNCERTAIN_ERROR);
            await load();
            if (mountedRef.current) setError(UNCERTAIN_ERROR);
          } else if (mountedRef.current) setError(SAVE_ERROR);
        } finally {
          if (saveRef.current === controller) saveRef.current = null;
          if (mountedRef.current) setBusy(false);
        }
      };
      const pending = queueRef.current.then(operation, operation);
      queueRef.current = pending.catch(() => undefined);
      return pending;
    },
    [api, load, onAuthenticationRequired],
  );

  return { response, loading, busy, error, save, retry: load };
}

function isAuthLoss(error: unknown): boolean {
  return error instanceof SettingsApiError && error.status === 401;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
