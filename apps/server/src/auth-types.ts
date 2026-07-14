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
export type LocalSetupAttempt = Readonly<{
  password: string;
  address: string;
}>;
export type LocalLoginFailure =
  'authentication_failed' | 'rate_limited' | 'setup_required';
export type LocalSetupFailure = 'already_initialized' | 'rate_limited';
export type AuthFailure = LocalLoginFailure | LocalSetupFailure;
export type AuthBootstrapResult<Failure extends AuthFailure = AuthFailure> =
  Readonly<{
    bootstrap: AuthBootstrap;
    cookieValue?: string;
    failure?: Failure;
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
export type AuthenticatedSessionAuthority = AuthenticatedSession &
  Readonly<{ generation: number }>;
export type RevocationReason =
  'capacity' | 'idle' | 'absolute' | 'upstream' | 'logout' | 'password_changed';
