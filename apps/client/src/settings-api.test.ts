import {
  MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  type SettingsResponse,
  type WorkspaceSettings,
} from '@flanterminal/shared';
import { describe, expect, it, vi } from 'vitest';

import { createSettingsApi, SettingsApiError } from './settings-api.js';

const settings = {
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
} satisfies WorkspaceSettings;

const response = {
  settings,
  limits: {
    fontFamilies: [
      'jetbrains-mono-nerd',
      'system-monospace',
      'dejavu-sans-mono',
      'noto-sans-mono',
      'liberation-mono',
      'courier',
    ],
    fontSize: { min: 8, max: 24, step: 1 },
    lineHeight: { min: 1, max: 2, step: 0.05 },
    letterSpacing: { min: 0, max: 4, step: 1 },
    scrollback: { min: 0, max: 50_000, step: 1 },
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
    tmuxHistoryLimit: { min: 0, max: 100_000, step: 1 },
    staleSessionCleanupHours: { min: 0, max: 168, step: 1 },
  },
  allowedShells: ['/bin/bash'],
} satisfies SettingsResponse;

describe('createSettingsApi', () => {
  it('loads a strict authoritative document through the private authority', async () => {
    const privateFetch = vi.fn(async () => Response.json(response));
    const api = createSettingsApi(
      '/tools/terminal',
      privateFetch,
      'https://host.example/tools/terminal/',
    );
    await expect(api.load()).resolves.toEqual(response);
    expect(privateFetch).toHaveBeenCalledWith(
      new URL('https://host.example/tools/terminal/api/settings'),
      expect.objectContaining({ cache: 'no-store', credentials: 'include' }),
    );
    expect(Object.isFrozen((await api.load()).settings)).toBe(true);
  });

  it('sends a full replacement as JSON and relies on memory-only CSRF authority', async () => {
    const next = {
      ...response,
      settings: { ...settings, theme: 'light' as const },
    };
    const privateFetch = vi.fn<typeof fetch>(async () => Response.json(next));
    const api = createSettingsApi(
      '/tools/terminal',
      privateFetch,
      'https://host.example/tools/terminal/',
    );
    await expect(api.replace(next.settings)).resolves.toEqual(next);
    const [, init] = privateFetch.mock.calls[0]!;
    expect(init).toMatchObject({
      method: 'PUT',
      cache: 'no-store',
      credentials: 'include',
    });
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/json',
    );
    expect(JSON.parse(String(init?.body))).toEqual({ settings: next.settings });
    expect(new Headers(init?.headers).has('x-csrf-token')).toBe(false);
  });

  it('rejects malformed success and preserves bounded server error codes', async () => {
    const malformed = createSettingsApi(
      '/',
      vi.fn(async () => Response.json({ ...response, private: true })),
      'https://host.example/',
    );
    await expect(malformed.load()).rejects.toBeInstanceOf(SettingsApiError);
    const uncertain = createSettingsApi(
      '/',
      vi.fn(async () =>
        Response.json({ error: 'durability_uncertain' }, { status: 500 }),
      ),
      'https://host.example/',
    );
    await expect(uncertain.replace(settings)).rejects.toMatchObject({
      code: 'durability_uncertain',
      status: 500,
    });
  });
});
