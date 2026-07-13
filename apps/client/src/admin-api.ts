import {
  adminActionSchema,
  apiErrorResponseSchema,
  basePathSchema,
  parseAdminSnapshot,
  parseCleanupResult,
  tabIdSchema,
  type AdminAction,
  type AdminSnapshot,
  type CleanupResult,
  type ApiErrorCode,
} from '@flanterminal/shared';

const SAFE_ERROR = 'Administration request failed.';

export class AdminApiError extends Error {
  constructor(
    readonly code?: ApiErrorCode,
    readonly status?: number,
  ) {
    super(SAFE_ERROR);
    this.name = 'AdminApiError';
  }
}

export interface AdminApi {
  load(signal?: AbortSignal): Promise<AdminSnapshot>;
  sessionAction(
    id: string,
    action: AdminAction,
    signal?: AbortSignal,
  ): Promise<void>;
  cleanup(signal?: AbortSignal): Promise<CleanupResult>;
}

export function createAdminApi(
  basePath: string,
  privateFetch: typeof fetch,
  baseUrl = document.baseURI,
): AdminApi {
  const parsedBasePath = basePathSchema.parse(basePath);
  const prefix = parsedBasePath === '/' ? '/' : `${parsedBasePath}/`;
  const root = new URL(`${prefix.slice(1)}api/admin`, new URL('/', baseUrl));

  const request = async (
    endpoint: URL,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<Response> => {
    try {
      const response = await privateFetch(endpoint, {
        method,
        cache: 'no-store',
        credentials: 'include',
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw await responseError(response);
      return response;
    } catch (error) {
      if (isAbortError(error) || error instanceof AdminApiError) throw error;
      throw new AdminApiError();
    }
  };

  return {
    async load(signal) {
      const response = await request(root, 'GET', signal);
      try {
        return parseAdminSnapshot(await response.json());
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new AdminApiError();
      }
    },
    async sessionAction(id, action, signal) {
      const parsedId = parseLocal(tabIdSchema, id);
      const parsedAction = parseLocal(adminActionSchema, action);
      await request(
        new URL(`${root.href}/sessions/${parsedId}`),
        'POST',
        signal,
        { action: parsedAction },
      );
    },
    async cleanup(signal) {
      const response = await request(
        new URL(`${root.href}/cleanup`),
        'POST',
        signal,
        {},
      );
      try {
        return parseCleanupResult(await response.json());
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new AdminApiError();
      }
    },
  };
}

async function responseError(response: Response): Promise<AdminApiError> {
  try {
    const parsed = apiErrorResponseSchema.safeParse(await response.json());
    return new AdminApiError(
      parsed.success ? parsed.data.error : undefined,
      response.status,
    );
  } catch {
    return new AdminApiError(undefined, response.status);
  }
}

function parseLocal<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AdminApiError();
  return parsed.data;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
