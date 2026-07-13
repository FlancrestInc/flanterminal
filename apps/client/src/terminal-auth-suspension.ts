const MAX_SESSION_IDS = 20;
const MAX_REGISTRATIONS = MAX_SESSION_IDS * 2;

type RegistrationToken = {
  readonly sessionId: string;
  restored: boolean;
  preserveOnUnmount: boolean;
  registered: boolean;
};

export type TerminalAuthLifecycleRegistration = Readonly<{
  restored: boolean;
  unregister: () => void;
}>;

const active = new Map<string, Set<RegistrationToken>>();
const suspended = new Map<string, true>();
let registrationCount = 0;

export function registerTerminalAuthLifecycle(
  sessionId: string,
): TerminalAuthLifecycleRegistration {
  if (registrationCount >= MAX_REGISTRATIONS)
    throw new Error('Unable to register terminal lifecycle.');
  const token: RegistrationToken = {
    sessionId,
    restored: suspended.has(sessionId),
    preserveOnUnmount: false,
    registered: true,
  };
  const registrations = active.get(sessionId) ?? new Set<RegistrationToken>();
  registrations.add(token);
  active.set(sessionId, registrations);
  registrationCount += 1;

  return Object.freeze({
    restored: token.restored,
    unregister: () => unregister(token),
  });
}

export function suspendActiveTerminalAuthLifecycles(): void {
  for (const [sessionId, registrations] of active) {
    rememberSuspension(sessionId);
    for (const token of registrations) {
      token.restored = true;
      token.preserveOnUnmount = true;
    }
  }
}

export function suspendTerminalAuthLifecycle(sessionId: string): void {
  rememberSuspension(sessionId);
  for (const token of active.get(sessionId) ?? []) {
    token.restored = true;
    token.preserveOnUnmount = true;
  }
}

export function clearTerminalAuthSuspension(sessionId: string): void {
  suspended.delete(sessionId);
  for (const token of active.get(sessionId) ?? []) {
    token.restored = false;
    token.preserveOnUnmount = false;
  }
}

export function isTerminalAuthSuspended(sessionId: string): boolean {
  return suspended.has(sessionId);
}

export function terminalAuthSuspensionCountsForTests() {
  return Object.freeze({
    activeIds: active.size,
    registrations: registrationCount,
    suspensions: suspended.size,
  });
}

export function resetTerminalAuthSuspensionsForTests(): void {
  active.clear();
  suspended.clear();
  registrationCount = 0;
}

function unregister(token: RegistrationToken): void {
  if (!token.registered) return;
  token.registered = false;
  registrationCount -= 1;
  const registrations = active.get(token.sessionId);
  registrations?.delete(token);
  if (registrations?.size === 0) active.delete(token.sessionId);
  if (!token.restored || token.preserveOnUnmount) return;
  queueMicrotask(() => {
    if (!active.has(token.sessionId)) suspended.delete(token.sessionId);
  });
}

function rememberSuspension(sessionId: string): void {
  if (suspended.has(sessionId)) return;
  while (suspended.size >= MAX_SESSION_IDS) {
    const oldest = suspended.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    suspended.delete(oldest);
  }
  suspended.set(sessionId, true);
}
