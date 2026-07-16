import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  type WorkspaceSettings,
  type WorkspaceSettingsConstraints,
} from '@flanterminal/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSecureJsonFile } from './secure-json-file.js';
import { SettingsStore } from './settings-store.js';

const defaults: WorkspaceSettings = {
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
  defaultShell: '/bin/bash',
  tmuxHistoryLimit: 50_000,
  staleSessionCleanupHours: 24,
  customTerminalPalette: MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
};

const constraints: WorkspaceSettingsConstraints = {
  limits: {
    fontFamilies: ['jetbrains-mono-nerd', 'system-monospace'],
    fontSize: { min: 10, max: 24, step: 1 },
    lineHeight: { min: 1, max: 1.5, step: 0.05 },
    letterSpacing: { min: 0, max: 2, step: 1 },
    scrollback: { min: 1_000, max: 50_000, step: 1_000 },
    themes: ['dark', 'light'],
    cursorStyles: ['block', 'bar'],
    bellBehaviors: ['none', 'visual'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 100_000, step: 1_000 },
    staleSessionCleanupHours: { min: 0, max: 168, step: 1 },
  },
  allowedShells: ['/bin/bash', '/bin/zsh'],
};

describe.sequential('SettingsStore real filesystem', () => {
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'flanterminal-settings-store-'));
    await chmod(dataDir, 0o700);
  });

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  it('persists exact settings securely and loads them on restart', async () => {
    const first = createStore(dataDir);
    await first.initialize();
    expect(first.snapshot()).toEqual(defaults);
    expect(first.durabilityReady()).toBe(true);

    const updated: WorkspaceSettings = {
      ...defaults,
      theme: 'light',
      cursorStyle: 'bar',
      defaultShell: '/bin/zsh',
    };
    await expect(first.replace(updated)).resolves.toEqual({
      state: 'committed',
    });

    const restarted = createStore(dataDir);
    await restarted.initialize();
    const snapshot = restarted.snapshot();
    expect(snapshot).toEqual(updated);
    expect(snapshot).not.toBe(updated);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(restarted.durabilityReady()).toBe(true);

    const names = await readdir(dataDir);
    expect(names).toEqual(['settings.json']);
    const stat = await lstat(join(dataDir, 'settings.json'));
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o7777).toBe(0o600);
  });

  it('rewrites a valid legacy settings document with the canonical palette', async () => {
    const legacy = structuredClone(defaults) as Record<string, unknown>;
    delete legacy.customTerminalPalette;
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify(legacy), {
      mode: 0o600,
    });

    const first = createStore(dataDir);
    await first.initialize();
    expect(first.snapshot()).toEqual(defaults);

    expect(
      JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')),
    ).toEqual(defaults);

    const restarted = createStore(dataDir);
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(defaults);
  });
});

function createStore(dataDir: string): SettingsStore {
  return new SettingsStore({
    dataDir,
    defaults,
    constraints,
    secureFile: createSecureJsonFile(),
  });
}
