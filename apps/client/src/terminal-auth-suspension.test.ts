import { afterEach, describe, expect, it } from 'vitest';

import {
  clearTerminalAuthSuspension,
  registerTerminalAuthLifecycle,
  resetTerminalAuthSuspensionsForTests,
  suspendActiveTerminalAuthLifecycles,
  suspendTerminalAuthLifecycle,
  terminalAuthSuspensionCountsForTests,
} from './terminal-auth-suspension.js';

const A = '123e4567-e89b-42d3-a456-426614174000';

afterEach(() => resetTerminalAuthSuspensionsForTests());

describe('terminal auth suspension registry', () => {
  it('preserves an auth-driven unmount for one restored lifecycle, then clears on disposal', async () => {
    const first = registerTerminalAuthLifecycle(A);
    expect(first.restored).toBe(false);
    suspendActiveTerminalAuthLifecycles();
    first.unregister();
    expect(terminalAuthSuspensionCountsForTests()).toEqual({
      activeIds: 0,
      registrations: 0,
      suspensions: 1,
    });

    const restored = registerTerminalAuthLifecycle(A);
    expect(restored.restored).toBe(true);
    restored.unregister();
    await Promise.resolve();
    expect(terminalAuthSuspensionCountsForTests()).toEqual({
      activeIds: 0,
      registrations: 0,
      suspensions: 0,
    });
  });

  it('does not clear a restored suspension during a StrictMode effect cycle', async () => {
    suspendTerminalAuthLifecycle(A);
    const probe = registerTerminalAuthLifecycle(A);
    probe.unregister();
    const mounted = registerTerminalAuthLifecycle(A);
    await Promise.resolve();
    expect(mounted.restored).toBe(true);
    expect(terminalAuthSuspensionCountsForTests()).toEqual({
      activeIds: 1,
      registrations: 1,
      suspensions: 1,
    });
    mounted.unregister();
    await Promise.resolve();
    expect(terminalAuthSuspensionCountsForTests()).toEqual({
      activeIds: 0,
      registrations: 0,
      suspensions: 0,
    });
  });

  it('bounds retained session IDs to the shared hard maximum of twenty', () => {
    for (let index = 0; index < 25; index += 1) {
      suspendTerminalAuthLifecycle(
        `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
      );
    }
    expect(terminalAuthSuspensionCountsForTests()).toEqual({
      activeIds: 0,
      registrations: 0,
      suspensions: 20,
    });
  });

  it('clears registrations and suspensions across repeated auth epochs and explicit reconnect', async () => {
    for (let epoch = 0; epoch < 4; epoch += 1) {
      const active = registerTerminalAuthLifecycle(A);
      suspendActiveTerminalAuthLifecycles();
      active.unregister();
      const restored = registerTerminalAuthLifecycle(A);
      expect(restored.restored).toBe(true);
      clearTerminalAuthSuspension(A);
      restored.unregister();
      await Promise.resolve();
    }
    expect(terminalAuthSuspensionCountsForTests()).toEqual({
      activeIds: 0,
      registrations: 0,
      suspensions: 0,
    });
  });
});
