import {
  apiErrorResponseSchema,
  basePathSchema,
  parseWorkspaceSettingsResponse,
  type ApiErrorCode,
  type SettingsResponse,
  type WorkspaceSettings,
} from '@flanterminal/shared';

const SAFE_ERROR = 'Settings request failed.';

export class SettingsApiError extends Error {
  constructor(
    readonly code?: ApiErrorCode,
    readonly status?: number,
  ) {
    super(SAFE_ERROR);
    this.name = 'SettingsApiError';
  }
}

export interface SettingsApi {
  load(signal?: AbortSignal): Promise<SettingsResponse>;
  replace(
    settings: WorkspaceSettings,
    signal?: AbortSignal,
  ): Promise<SettingsResponse>;
}

export function createSettingsApi(
  basePath: string,
  privateFetch: typeof fetch,
  baseUrl = document.baseURI,
): SettingsApi {
  const parsedBasePath = basePathSchema.parse(basePath);
  const prefix = parsedBasePath === '/' ? '/' : `${parsedBasePath}/`;
  const endpoint = new URL(
    `${prefix.slice(1)}api/settings`,
    new URL('/', baseUrl),
  );

  const request = async (
    method: 'GET' | 'PUT',
    signal?: AbortSignal,
    settings?: WorkspaceSettings,
  ): Promise<SettingsResponse> => {
    try {
      const response = await privateFetch(endpoint, {
        method,
        cache: 'no-store',
        credentials: 'include',
        ...(settings === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings }),
            }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw await responseError(response);
      return parseWorkspaceSettingsResponse(await response.json());
    } catch (error) {
      if (isAbortError(error) || error instanceof SettingsApiError) throw error;
      throw new SettingsApiError();
    }
  };

  return {
    load: (signal) => request('GET', signal),
    replace: (settings, signal) => request('PUT', signal, settings),
  };
}

async function responseError(response: Response): Promise<SettingsApiError> {
  try {
    const parsed = apiErrorResponseSchema.safeParse(await response.json());
    return new SettingsApiError(
      parsed.success ? parsed.data.error : undefined,
      response.status,
    );
  } catch {
    return new SettingsApiError(undefined, response.status);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
