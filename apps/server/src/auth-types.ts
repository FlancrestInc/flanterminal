import { type AuthBootstrap, type AuthMode } from '@flanterminal/shared';

export type { AuthMode };
export type UpstreamIdentity = Readonly<{
  mode: 'cloudflare-access' | 'trusted-header';
  identityLabel: string;
  expiresAt?: number;
}>;
export type UpstreamAuthentication =
  | Readonly<{ type: 'none' }>
  | Readonly<{ type: 'upstream'; identity: UpstreamIdentity }>;
export type LocalLoginAttempt = Readonly<{
  username: string;
  password: string;
  address: string;
}>;
export type AuthBootstrapResult = Readonly<{
  bootstrap: AuthBootstrap;
  cookieValue?: string;
}>;
export type AuthenticatedSession = Readonly<{
  id: string;
  mode: AuthMode;
  identityLabel: string;
  createdAt: number;
  lastSeen: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  upstreamExpiresAt?: number;
}>;
export type RevocationReason =
  'capacity' | 'idle' | 'absolute' | 'upstream' | 'logout' | 'password_changed';
