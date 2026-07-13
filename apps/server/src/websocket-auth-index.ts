import {
  AUTHENTICATION_REQUIRED,
  AUTHENTICATION_REQUIRED_REASON,
} from '@flanterminal/shared';

import type { Disposable } from './pty.js';

export type ApplicationSessionAuthority = Readonly<{
  applicationSessionId: string;
  generation: number;
  expiresAt: number;
}>;

export interface AuthIndexSocket {
  readonly OPEN: number;
  readonly readyState: number;
  close(code: number, reason: string): void;
  terminate(): void;
  onClose(listener: () => void): Disposable;
  onError(listener: () => void): Disposable;
}

export interface WebSocketAuthSource {
  isActive(authority: ApplicationSessionAuthority): boolean;
  sweepExpired(): void;
  onRevoked(listener: (applicationSessionId: string) => void): () => void;
}

export type WebSocketAuthIndexOptions = Readonly<{
  auth: WebSocketAuthSource;
  maxApplicationSessions: number;
  maxSockets: number;
}>;

type Registration = {
  authority: ApplicationSessionAuthority;
  terminalTabId: string;
  socket: AuthIndexSocket;
  disposables: Disposable[];
};

const HARD_MAX_APPLICATION_SESSIONS = 256;
const HARD_MAX_SOCKETS = 1_024;

export class WebSocketAuthIndex {
  readonly #auth: WebSocketAuthSource;
  readonly #maxSessions: number;
  readonly #maxSockets: number;
  readonly #bySession = new Map<string, Set<Registration>>();
  readonly #bySocket = new Map<AuthIndexSocket, Registration>();
  readonly #tabCounts = new Map<string, number>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(options: WebSocketAuthIndexOptions) {
    if (
      !Number.isInteger(options.maxApplicationSessions) ||
      options.maxApplicationSessions < 1 ||
      options.maxApplicationSessions > HARD_MAX_APPLICATION_SESSIONS ||
      !Number.isInteger(options.maxSockets) ||
      options.maxSockets < 1 ||
      options.maxSockets > HARD_MAX_SOCKETS
    )
      throw new Error('Invalid websocket authentication capacity');
    this.#auth = options.auth;
    this.#maxSessions = options.maxApplicationSessions;
    this.#maxSockets = options.maxSockets;
    this.#unsubscribe = options.auth.onRevoked((id) => this.closeSession(id));
  }

  registerIfActive(
    authority: ApplicationSessionAuthority,
    terminalTabId: string,
    socket: AuthIndexSocket,
  ): boolean {
    if (
      this.#disposed ||
      socket.readyState !== socket.OPEN ||
      this.#bySocket.has(socket) ||
      this.#bySocket.size >= this.#maxSockets ||
      !this.#isActive(authority)
    )
      return false;
    let session = this.#bySession.get(authority.applicationSessionId);
    if (session === undefined) {
      if (this.#bySession.size >= this.#maxSessions) return false;
      session = new Set();
      this.#bySession.set(authority.applicationSessionId, session);
    } else {
      const existing = session.values().next().value as
        Registration | undefined;
      if (existing?.authority.generation !== authority.generation) return false;
    }
    const registration: Registration = {
      authority,
      terminalTabId,
      socket,
      disposables: [],
    };
    try {
      registration.disposables.push(
        socket.onClose(() => this.unregister(socket)),
        socket.onError(() => this.unregister(socket)),
      );
    } catch {
      disposeAll(registration.disposables);
      if (session.size === 0)
        this.#bySession.delete(authority.applicationSessionId);
      return false;
    }
    if (socket.readyState !== socket.OPEN || !this.#isActive(authority)) {
      disposeAll(registration.disposables);
      if (session.size === 0)
        this.#bySession.delete(authority.applicationSessionId);
      return false;
    }
    session.add(registration);
    this.#bySocket.set(socket, registration);
    this.#tabCounts.set(
      terminalTabId,
      (this.#tabCounts.get(terminalTabId) ?? 0) + 1,
    );
    return true;
  }

  isActive(authority: ApplicationSessionAuthority): boolean {
    return !this.#disposed && this.#isActive(authority);
  }

  unregister(socket: AuthIndexSocket): void {
    const registration = this.#bySocket.get(socket);
    if (registration === undefined) return;
    this.#bySocket.delete(socket);
    const session = this.#bySession.get(
      registration.authority.applicationSessionId,
    );
    session?.delete(registration);
    if (session?.size === 0)
      this.#bySession.delete(registration.authority.applicationSessionId);
    const count = (this.#tabCounts.get(registration.terminalTabId) ?? 1) - 1;
    if (count === 0) this.#tabCounts.delete(registration.terminalTabId);
    else this.#tabCounts.set(registration.terminalTabId, count);
    disposeAll(registration.disposables);
  }

  closeSession(applicationSessionId: string): void {
    const registrations = [
      ...(this.#bySession.get(applicationSessionId) ?? []),
    ];
    for (const registration of registrations) {
      this.closeAuthenticationRequired(registration.socket);
    }
  }

  closeAuthenticationRequired(socket: AuthIndexSocket): boolean {
    const secured = secureAuthenticationClosure(socket);
    if (secured) this.unregister(socket);
    return secured;
  }

  sweepExpired(): void {
    try {
      this.#auth.sweepExpired();
    } catch {
      // A failed sweep cannot bypass the per-capture active recheck below.
    }
    for (const registration of [...this.#bySocket.values()]) {
      if (!this.#isActive(registration.authority)) {
        this.closeAuthenticationRequired(registration.socket);
      }
    }
  }

  connectedCount(): number {
    return this.#bySocket.size;
  }

  countForTab(terminalTabId: string): number {
    return this.#tabCounts.get(terminalTabId) ?? 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#unsubscribe();
    } catch {
      // Disposal remains idempotent even if a dependency misbehaves.
    }
    for (const socket of [...this.#bySocket.keys()]) {
      this.closeAuthenticationRequired(socket);
    }
  }

  #isActive(authority: ApplicationSessionAuthority): boolean {
    try {
      return this.#auth.isActive(authority);
    } catch {
      return false;
    }
  }
}

function secureAuthenticationClosure(socket: AuthIndexSocket): boolean {
  if (socket.readyState !== socket.OPEN) return true;
  try {
    socket.close(AUTHENTICATION_REQUIRED, AUTHENTICATION_REQUIRED_REASON);
  } catch {
    // Termination below is the guaranteed fallback.
  }
  if (socket.readyState !== socket.OPEN) return true;
  try {
    socket.terminate();
  } catch {
    // Callers retain registration while the socket is still observably OPEN.
  }
  return socket.readyState !== socket.OPEN;
}

function disposeAll(disposables: Disposable[]): void {
  for (const disposable of disposables.splice(0)) {
    try {
      disposable.dispose();
    } catch {
      // Continue removing all listeners.
    }
  }
}
