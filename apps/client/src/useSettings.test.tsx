// @vitest-environment jsdom

import {
  MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  type SettingsResponse,
  type WorkspaceSettings,
} from '@flanterminal/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SettingsApi } from './settings-api.js';
import { SettingsApiError } from './settings-api.js';
import { useSettings } from './useSettings.js';

const base = {
  settings: {
    version: 1,
    fontFamily: 'dejavu-sans-mono',
    fontSize: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    scrollback: 10_000,
    theme: 'midnight-electric',
    cursorStyle: 'block',
    cursorBlink: true,
    bellBehavior: 'visual',
    reconnectBehavior: 'automatic',
    automaticTabCreation: true,
    workspaceShortcuts: 'default',
    defaultShell: '/bin/bash',
    tmuxHistoryLimit: 20_000,
    staleSessionCleanupHours: 0,
    customTerminalPalette: MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  },
  limits: {
    fontFamilies: [
      'jetbrains-mono-nerd',
      'system-monospace',
      'dejavu-sans-mono',
      'noto-sans-mono',
      'liberation-mono',
      'courier',
    ],
    fontSize: { min: 8, max: 32, step: 1 },
    lineHeight: { min: 1, max: 2, step: 0.05 },
    letterSpacing: { min: 0, max: 4, step: 1 },
    scrollback: { min: 0, max: 100_000, step: 1 },
    themes: [
      'dark',
      'light',
      'ubuntu',
      'midnight-electric',
      'aurora-night',
      'carbon-violet',
      'custom',
    ],
    cursorStyles: ['block', 'underline', 'bar'],
    bellBehaviors: ['none', 'visual', 'sound'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 1_000_000, step: 1 },
    staleSessionCleanupHours: { min: 0, max: 8_760, step: 1 },
  },
  allowedShells: ['/bin/bash'],
} satisfies SettingsResponse;

function api(overrides: Partial<SettingsApi> = {}): SettingsApi {
  return {
    load: vi.fn(async () => base),
    replace: vi.fn(async (settings) => ({ ...base, settings })),
    ...overrides,
  };
}

describe('useSettings', () => {
  it('gates on the server response and persists across remounts without browser storage', async () => {
    const client = api();
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderHook(() => useSettings(client));
    expect(first.result.current.response).toBeNull();
    await waitFor(() => expect(first.result.current.response).toEqual(base));
    first.unmount();
    const second = renderHook(() => useSettings(client));
    await waitFor(() => expect(second.result.current.response).toEqual(base));
    expect(client.load).toHaveBeenCalledTimes(2);
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it('serializes saves and treats each server response as authority', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replace = vi.fn(async (candidate: WorkspaceSettings) => {
      if (candidate.theme === 'light') await first;
      return {
        ...base,
        settings: { ...candidate, fontSize: candidate.fontSize + 1 },
      };
    });
    const client = api({ replace });
    const hook = renderHook(() => useSettings(client));
    await waitFor(() => expect(hook.result.current.response).not.toBeNull());
    let one!: Promise<void>;
    let two!: Promise<void>;
    await act(async () => {
      one = hook.result.current.save({ ...base.settings, theme: 'light' });
      two = hook.result.current.save({ ...base.settings, theme: 'ubuntu' });
      await Promise.resolve();
    });
    expect(replace).toHaveBeenCalledTimes(1);
    release();
    await act(async () => {
      await Promise.all([one, two]);
    });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(hook.result.current.response?.settings).toMatchObject({
      theme: 'ubuntu',
      fontSize: 15,
    });
  });

  it('refetches authoritative state after durability uncertainty and propagates auth loss', async () => {
    const load = vi.fn(async () => base);
    const replace = vi.fn(async () => {
      throw new SettingsApiError('durability_uncertain', 500);
    });
    const onAuthenticationRequired = vi.fn();
    const client = api({ load, replace });
    const hook = renderHook(() =>
      useSettings(client, { onAuthenticationRequired }),
    );
    await waitFor(() => expect(hook.result.current.response).not.toBeNull());
    await act(async () => {
      await hook.result.current.save(base.settings);
    });
    expect(load).toHaveBeenCalledTimes(2);
    replace.mockRejectedValueOnce(
      new SettingsApiError('authentication_required', 401),
    );
    await act(async () => {
      await hook.result.current.save(base.settings);
    });
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();
  });

  it('clears a save error only when its next save starts and keeps it clear on success', async () => {
    const retry = deferred<SettingsResponse>();
    const replace = vi
      .fn<SettingsApi['replace']>()
      .mockRejectedValueOnce(new SettingsApiError('operation_failed', 500))
      .mockImplementationOnce(async () => await retry.promise);
    const client = api({ replace });
    const hook = renderHook(() => useSettings(client));
    await waitFor(() => expect(hook.result.current.response).not.toBeNull());

    await act(async () => {
      await hook.result.current.save(base.settings);
    });
    expect(hook.result.current.error).toBe('Unable to save settings.');

    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.save({
        ...base.settings,
        theme: 'light',
      });
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));
    expect(hook.result.current.error).toBeNull();
    retry.resolve({
      ...base,
      settings: { ...base.settings, theme: 'light' },
    });
    await act(async () => pending);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.response?.settings.theme).toBe('light');
  });

  it('aborts loading and suppresses state publication after unmount', () => {
    let signal: AbortSignal | undefined;
    const client = api({
      load: vi.fn<SettingsApi['load']>((next) => {
        signal = next;
        return new Promise<SettingsResponse>(() => undefined);
      }),
    });
    const hook = renderHook(() => useSettings(client));
    hook.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('aborts an active save and never starts a queued save after unmount', async () => {
    let activeSignal: AbortSignal | undefined;
    const replace = vi.fn<SettingsApi['replace']>((_settings, signal) => {
      activeSignal = signal;
      return new Promise<SettingsResponse>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      });
    });
    const client = api({ replace });
    const hook = renderHook(() => useSettings(client));
    await waitFor(() => expect(hook.result.current.response).not.toBeNull());
    await act(async () => {
      void hook.result.current.save({ ...base.settings, theme: 'light' });
      void hook.result.current.save({ ...base.settings, theme: 'ubuntu' });
      await Promise.resolve();
    });
    expect(replace).toHaveBeenCalledOnce();
    hook.unmount();
    expect(activeSignal?.aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replace).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
