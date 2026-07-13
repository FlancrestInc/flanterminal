import {
  apiErrorResponseSchema,
  parseAuthBootstrap,
  parseLoginRequest,
  parsePasswordChangeRequest,
  type ApiErrorCode,
  type AuthBootstrap,
  type LoginRequest,
  type PasswordChangeRequest,
} from '@flanterminal/shared';

const SAFE_ERROR = 'Authentication request failed.';

export class AuthApiError extends Error {
  readonly code: ApiErrorCode | undefined;
  readonly status: number | undefined;

  constructor(code?: ApiErrorCode, status?: number) {
    super(SAFE_ERROR);
    this.name = 'AuthApiError';
    this.code = code;
    this.status = status;
  }
}

export interface AuthApi {
  bootstrap(signal?: AbortSignal): Promise<AuthBootstrap>;
  login(input: LoginRequest, signal?: AbortSignal): Promise<AuthBootstrap>;
  refresh(csrfToken: string, signal?: AbortSignal): Promise<AuthBootstrap>;
  logout(csrfToken: string, signal?: AbortSignal): Promise<void>;
  changePassword(
    csrfToken: string,
    input: PasswordChangeRequest,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type CreateAuthApiOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}>;

export function createAuthApi(options: CreateAuthApiOptions = {}): AuthApi {
  const baseUrl = options.baseUrl ?? document.baseURI;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = (path: string) => new URL(`api/auth/${path}`, baseUrl);

  const request = async (
    path: string,
    method: string,
    signal?: AbortSignal,
    body?: unknown,
    csrfToken?: string,
  ): Promise<Response> => {
    try {
      const headers = new Headers();
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      if (csrfToken !== undefined) headers.set('X-CSRF-Token', csrfToken);
      const hasHeaders = body !== undefined || csrfToken !== undefined;
      const response = await fetchImpl(endpoint(path), {
        cache: 'no-store',
        credentials: 'include',
        method,
        ...(hasHeaders ? { headers } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw await responseError(response);
      return response;
    } catch (error) {
      if (isAbortError(error) || error instanceof AuthApiError) throw error;
      throw new AuthApiError();
    }
  };

  const bootstrapResponse = async (
    path: string,
    method: string,
    signal?: AbortSignal,
    body?: unknown,
    csrfToken?: string,
  ): Promise<AuthBootstrap> => {
    const response = await request(path, method, signal, body, csrfToken);
    try {
      return parseAuthBootstrap(await response.json());
    } catch {
      throw new AuthApiError();
    }
  };

  return {
    bootstrap: (signal) => bootstrapResponse('session', 'GET', signal),
    login: (input, signal) => {
      try {
        return bootstrapResponse(
          'login',
          'POST',
          signal,
          parseLoginRequest(input),
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new AuthApiError();
      }
    },
    refresh: (csrfToken, signal) =>
      bootstrapResponse('refresh', 'POST', signal, {}, csrfToken),
    async logout(csrfToken, signal) {
      await request('logout', 'POST', signal, {}, csrfToken);
    },
    async changePassword(csrfToken, input, signal) {
      let parsed: PasswordChangeRequest;
      try {
        parsed = parsePasswordChangeRequest(input);
      } catch {
        throw new AuthApiError();
      }
      await request('password', 'PUT', signal, parsed, csrfToken);
    },
  };
}

async function responseError(response: Response): Promise<AuthApiError> {
  try {
    const parsed = apiErrorResponseSchema.safeParse(await response.json());
    return new AuthApiError(
      parsed.success ? parsed.data.error : undefined,
      response.status,
    );
  } catch {
    return new AuthApiError(undefined, response.status);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
