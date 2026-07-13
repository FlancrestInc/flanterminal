import type {
  WorkspaceSettings,
  WorkspaceSettingsConstraints,
} from '@flanterminal/shared';
import { describe, expect, it, vi } from 'vitest';

import { StoredSessionRuntimeSettingsProvider } from './session-runtime-settings.js';

const settings: WorkspaceSettings = {
  version: 1,
  fontFamily: 'jetbrains-mono-nerd',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  scrollback: 10_000,
  theme: 'dark',
  cursorStyle: 'block',
  cursorBlink: true,
  bellBehavior: 'visual',
  reconnectBehavior: 'automatic',
  automaticTabCreation: true,
  workspaceShortcuts: 'default',
  defaultShell: '/bin/zsh',
  tmuxHistoryLimit: 40_000,
  staleSessionCleanupHours: 0,
};

const constraints: WorkspaceSettingsConstraints = {
  limits: {
    fontFamilies: ['jetbrains-mono-nerd', 'system-monospace'],
    fontSize: { min: 8, max: 32, step: 1 },
    lineHeight: { min: 1, max: 2, step: 0.05 },
    letterSpacing: { min: 0, max: 4, step: 1 },
    scrollback: { min: 0, max: 100_000, step: 1 },
    themes: ['dark', 'light', 'ubuntu'],
    cursorStyles: ['block', 'underline', 'bar'],
    bellBehaviors: ['none', 'visual', 'sound'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 100_000, step: 1_000 },
    staleSessionCleanupHours: { min: 0, max: 168, step: 1 },
  },
  allowedShells: ['/bin/bash', '/bin/zsh'],
};

describe('StoredSessionRuntimeSettingsProvider', () => {
  it('returns one immutable operational snapshot from the authoritative store', () => {
    const store = { snapshot: vi.fn(() => settings) };
    const provider = new StoredSessionRuntimeSettingsProvider({
      store,
      constraints,
      verifiedShells: ['/bin/bash', '/bin/zsh'],
    });

    const current = provider.current();

    expect(current).toEqual({ shell: '/bin/zsh', historyLimit: 40_000 });
    expect(Object.isFrozen(current)).toBe(true);
    expect(store.snapshot).toHaveBeenCalledOnce();
  });

  it.each([
    ['not allowlisted', { defaultShell: '/bin/fish' }, ['/bin/fish']],
    ['not verified', { defaultShell: '/bin/zsh' }, ['/bin/bash']],
    ['outside history constraints', { tmuxHistoryLimit: 40_500 }, ['/bin/zsh']],
  ] as const)(
    'rejects a shell/history snapshot that is %s',
    (_case, changed, verifiedShells) => {
      const provider = new StoredSessionRuntimeSettingsProvider({
        store: { snapshot: () => ({ ...settings, ...changed }) },
        constraints,
        verifiedShells,
      });

      expect(() => provider.current()).toThrow(/^Invalid runtime settings$/);
    },
  );

  it('owns an immutable copy of deployment constraints', () => {
    const callerConstraints = structuredClone(constraints);
    const provider = new StoredSessionRuntimeSettingsProvider({
      store: {
        snapshot: () => ({
          ...settings,
          defaultShell: '/bin/fish',
          tmuxHistoryLimit: 500_000,
        }),
      },
      constraints: callerConstraints,
      verifiedShells: ['/bin/fish'],
    });
    (callerConstraints.allowedShells as string[]).push('/bin/fish');
    (callerConstraints.limits.tmuxHistoryLimit as { max: number }).max =
      500_000;

    expect(() => provider.current()).toThrow(/^Invalid runtime settings$/);
  });
});
