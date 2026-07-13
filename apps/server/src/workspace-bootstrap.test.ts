import { describe, expect, it, vi } from 'vitest';

import { WorkspaceBootstrap } from './workspace-bootstrap.js';

describe('WorkspaceBootstrap', () => {
  it('creates the initial tab only when the current server setting enables it', async () => {
    const ensureInitialTab = vi.fn(async () => undefined);
    const enabled = new WorkspaceBootstrap({
      settingsStore: { snapshot: () => ({ automaticTabCreation: true }) },
      tabStore: { ensureInitialTab },
    });

    await enabled.ensureForAuthenticatedSession();
    expect(ensureInitialTab).toHaveBeenCalledOnce();

    const disabled = new WorkspaceBootstrap({
      settingsStore: { snapshot: () => ({ automaticTabCreation: false }) },
      tabStore: { ensureInitialTab },
    });
    await disabled.ensureForAuthenticatedSession();
    expect(ensureInitialTab).toHaveBeenCalledOnce();
  });

  it('serializes concurrent authenticated bootstrap requests', async () => {
    let active = 0;
    let maximum = 0;
    const ensureInitialTab = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
    });
    const bootstrap = new WorkspaceBootstrap({
      settingsStore: { snapshot: () => ({ automaticTabCreation: true }) },
      tabStore: { ensureInitialTab },
    });

    await Promise.all([
      bootstrap.ensureForAuthenticatedSession(),
      bootstrap.ensureForAuthenticatedSession(),
    ]);

    expect(maximum).toBe(1);
    expect(ensureInitialTab).toHaveBeenCalledTimes(2);
  });

  it('propagates bounded failures and permits a later retry', async () => {
    const ensureInitialTab = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('private storage failure'))
      .mockResolvedValueOnce();
    const bootstrap = new WorkspaceBootstrap({
      settingsStore: { snapshot: () => ({ automaticTabCreation: true }) },
      tabStore: { ensureInitialTab },
    });

    await expect(bootstrap.ensureForAuthenticatedSession()).rejects.toThrow(
      /^Workspace bootstrap failed$/,
    );
    await expect(
      bootstrap.ensureForAuthenticatedSession(),
    ).resolves.toBeUndefined();
    expect(ensureInitialTab).toHaveBeenCalledTimes(2);
  });
});
