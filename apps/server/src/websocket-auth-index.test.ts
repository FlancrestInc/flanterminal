import { describe, expect, it, vi } from 'vitest';

import {
  WebSocketAuthIndex,
  type ApplicationSessionAuthority,
  type AuthIndexSocket,
} from './websocket-auth-index.js';

const TAB_A = '550e8400-e29b-41d4-a716-446655440000';
const TAB_B = '123e4567-e89b-42d3-a456-426614174000';
const AUTH_A = Object.freeze({
  applicationSessionId: 'app-session-a',
  generation: 1,
  expiresAt: 2_000,
});
const AUTH_B = Object.freeze({
  applicationSessionId: 'app-session-b',
  generation: 2,
  expiresAt: 3_000,
});

describe('WebSocketAuthIndex', () => {
  it('exposes immutable per-tab cleanup counts with transition generations', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 3,
    });
    const socket = new FakeSocket();

    const initial = index.cleanupSnapshot(TAB_A);
    expect(index.registerIfActive(AUTH_A, TAB_A, socket)).toBe(true);
    const connected = index.cleanupSnapshot(TAB_A);
    expect(index.registerIfActive(AUTH_A, TAB_A, socket)).toBe(false);
    expect(index.cleanupSnapshot(TAB_A)).toEqual(connected);

    index.unregister(new FakeSocket());
    expect(index.cleanupSnapshot(TAB_A)).toEqual(connected);
    index.unregister(socket);
    const disconnected = index.cleanupSnapshot(TAB_A);

    expect(initial).toEqual({ generation: 0, count: 0 });
    expect(connected).toEqual({ generation: 1, count: 1 });
    expect(disconnected).toEqual({ generation: 2, count: 0 });
    expect(Object.isFrozen(disconnected)).toBe(true);
  });

  it('does not decrement cleanup visibility when fail-closed disposal cannot close a socket', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 3,
    });
    const socket = new FakeSocket();
    socket.close.mockImplementation(() => {
      throw new Error('contained');
    });
    socket.terminate.mockImplementation(() => {
      throw new Error('contained');
    });
    index.registerIfActive(AUTH_A, TAB_A, socket);
    const before = index.cleanupSnapshot(TAB_A);

    index.dispose();

    expect(index.cleanupSnapshot(TAB_A)).toEqual(before);
    expect(before).toEqual({ generation: 1, count: 1 });
  });

  it('keeps cleanup generations isolated per terminal tab', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 3,
    });
    const tabAInitial = index.cleanupSnapshot(TAB_A);
    const tabBSocket = new FakeSocket();

    expect(index.registerIfActive(AUTH_A, TAB_B, tabBSocket)).toBe(true);
    expect(index.cleanupSnapshot(TAB_A)).toEqual(tabAInitial);
    index.unregister(tabBSocket);
    expect(index.cleanupSnapshot(TAB_A)).toEqual(tabAInitial);

    expect(index.registerIfActive(AUTH_A, TAB_A, new FakeSocket())).toBe(true);
    expect(index.cleanupSnapshot(TAB_A).generation).toBeGreaterThan(
      tabAInitial.generation,
    );
  });

  it('bounds retained cleanup generations across terminal tab churn', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 3,
    });

    for (let tab = 0; tab < 500; tab += 1) {
      const socket = new FakeSocket();
      expect(index.registerIfActive(AUTH_A, `unknown-${tab}`, socket)).toBe(
        true,
      );
      index.unregister(socket);
    }

    expect(index.cleanupTrackingCount()).toBeLessThanOrEqual(64);
  });

  it('registers active authorities atomically and counts only live sockets', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 3,
    });
    const first = new FakeSocket();
    const second = new FakeSocket();

    expect(index.registerIfActive(AUTH_A, TAB_A, first)).toBe(true);
    expect(index.registerIfActive(AUTH_A, TAB_B, second)).toBe(true);
    expect(index.connectedCount()).toBe(2);
    expect(index.countForTab(TAB_A)).toBe(1);
    expect(index.countForTab(TAB_B)).toBe(1);

    first.emit('close');
    first.emit('error');
    expect(index.connectedCount()).toBe(1);
    expect(index.countForTab(TAB_A)).toBe(0);
    expect(first.listenerCount()).toBe(0);

    index.unregister(second);
    index.unregister(second);
    expect(index.connectedCount()).toBe(0);
    expect(second.listenerCount()).toBe(0);
  });

  it('rejects inactive, mismatched-generation, closed, and over-capacity registrations', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 1,
      maxSockets: 1,
    });
    const first = new FakeSocket();
    expect(index.registerIfActive(AUTH_A, TAB_A, first)).toBe(true);
    expect(index.registerIfActive(AUTH_B, TAB_B, new FakeSocket())).toBe(false);

    const replacement = new FakeSocket();
    auth.active = false;
    expect(index.registerIfActive(AUTH_A, TAB_A, replacement)).toBe(false);
    auth.active = true;
    const stale = { ...AUTH_A, generation: 99 };
    auth.isActive.mockImplementation(
      (capture: ApplicationSessionAuthority) => capture === AUTH_A,
    );
    expect(index.registerIfActive(stale, TAB_A, replacement)).toBe(false);
    replacement.readyState = replacement.CLOSED;
    expect(index.registerIfActive(AUTH_A, TAB_A, replacement)).toBe(false);
  });

  it('closes one application session idempotently and never retains revoked tombstones', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 4,
    });
    const first = new FakeSocket();
    const second = new FakeSocket();
    index.registerIfActive(AUTH_A, TAB_A, first);
    index.registerIfActive(AUTH_A, TAB_B, second);
    const beforeRevocation = index.cleanupSnapshot(TAB_A).generation;

    auth.revoke(AUTH_A.applicationSessionId);
    auth.revoke(AUTH_A.applicationSessionId);

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledWith(4003, 'authentication_required');
    expect(index.connectedCount()).toBe(0);
    expect(index.cleanupSnapshot(TAB_A)).toEqual({
      generation: beforeRevocation + 1,
      count: 0,
    });

    auth.active = true;
    expect(index.registerIfActive(AUTH_A, TAB_A, new FakeSocket())).toBe(true);
  });

  it('sweeps expiry, rechecks active generations, and contains callback failures', () => {
    const auth = authSource();
    const expired = new FakeSocket();
    const stale = new FakeSocket();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 4,
    });
    index.registerIfActive(AUTH_A, TAB_A, expired);
    index.registerIfActive(AUTH_B, TAB_B, stale);
    auth.sweepExpired.mockImplementation(() => {
      auth.revoke(AUTH_A.applicationSessionId);
      throw new Error('contained');
    });
    auth.isActive.mockImplementation(
      (authority: ApplicationSessionAuthority) => authority !== AUTH_B,
    );

    expect(() => index.sweepExpired()).not.toThrow();
    expect(expired.close).toHaveBeenCalledWith(4003, 'authentication_required');
    expect(stale.close).toHaveBeenCalledWith(4003, 'authentication_required');
    expect(index.connectedCount()).toBe(0);
  });

  it('owns exactly one disposable revocation subscription and removes listeners on dispose', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 4,
    });
    const socket = new FakeSocket();
    index.registerIfActive(AUTH_A, TAB_A, socket);

    expect(auth.onRevoked).toHaveBeenCalledOnce();
    index.dispose();
    index.dispose();

    expect(auth.unsubscribe).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(4003, 'authentication_required');
    expect(socket.listenerCount()).toBe(0);
    expect(index.connectedCount()).toBe(0);
    expect(index.registerIfActive(AUTH_A, TAB_A, new FakeSocket())).toBe(false);
  });

  it('terminates and unregisters a live socket when authentication close throws', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 4,
    });
    const throwing = new FakeSocket();
    throwing.close.mockImplementation(() => {
      throw new Error('contained close failure');
    });
    index.registerIfActive(AUTH_A, TAB_A, throwing);

    expect(() => index.dispose()).not.toThrow();
    index.dispose();

    expect(throwing.close).toHaveBeenCalledOnce();
    expect(throwing.terminate).toHaveBeenCalledOnce();
    expect(throwing.readyState).toBe(throwing.CLOSED);
    expect(throwing.listenerCount()).toBe(0);
    expect(index.connectedCount()).toBe(0);
    expect(index.countForTab(TAB_A)).toBe(0);
    expect(auth.unsubscribe).toHaveBeenCalledOnce();
  });

  it('retains tracking when both authentication close and termination fail', () => {
    const auth = authSource();
    const index = new WebSocketAuthIndex({
      auth,
      maxApplicationSessions: 2,
      maxSockets: 4,
    });
    const socket = new FakeSocket();
    socket.close.mockImplementation(() => {
      throw new Error('contained close failure');
    });
    socket.terminate.mockImplementation(() => {
      throw new Error('contained termination failure');
    });
    index.registerIfActive(AUTH_A, TAB_A, socket);

    expect(() => index.dispose()).not.toThrow();

    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(socket.OPEN);
    expect(index.connectedCount()).toBe(1);
    expect(index.countForTab(TAB_A)).toBe(1);
    expect(socket.listenerCount()).toBe(2);
    expect(auth.unsubscribe).toHaveBeenCalledOnce();
  });
});

function authSource() {
  let active = true;
  let observer: ((id: string) => void) | undefined;
  const unsubscribe = vi.fn();
  return {
    get active() {
      return active;
    },
    set active(value: boolean) {
      active = value;
    },
    isActive: vi.fn<(authority: ApplicationSessionAuthority) => boolean>(
      () => active,
    ),
    sweepExpired: vi.fn(),
    unsubscribe,
    onRevoked: vi.fn((listener: (id: string) => void) => {
      observer = listener;
      return unsubscribe;
    }),
    revoke(id: string) {
      observer?.(id);
    },
  };
}

class FakeSocket implements AuthIndexSocket {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  close = vi.fn(() => {
    this.readyState = this.CLOSING;
  });
  terminate = vi.fn(() => {
    this.readyState = this.CLOSED;
  });
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();

  onClose(listener: () => void) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }
  onError(listener: () => void) {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }
  emit(event: 'close' | 'error') {
    for (const listener of [
      ...(event === 'close' ? this.closeListeners : this.errorListeners),
    ])
      listener();
  }
  listenerCount() {
    return this.closeListeners.size + this.errorListeners.size;
  }
}
