import {
  apiErrorResponseSchema,
  createTabBodySchema,
  renameTabBodySchema,
  reorderTabsBodySchema,
  tabCollectionResponseSchema,
  tabIdSchema,
  tabViewSchema,
  type ApiErrorCode,
  type TabCollectionResponse,
  type TabView,
} from '@flanterminal/shared';

const SAFE_ERROR = 'Unable to update terminal tabs.';

export class TabApiError extends Error {
  constructor(readonly code?: ApiErrorCode) {
    super(SAFE_ERROR);
    this.name = 'TabApiError';
  }
}

export interface TabsApi {
  list(): Promise<TabCollectionResponse>;
  create(displayName?: string): Promise<TabView>;
  rename(id: string, displayName: string): Promise<TabView>;
  reorder(
    structureRevision: number,
    ids: readonly string[],
  ): Promise<TabCollectionResponse>;
  close(id: string): Promise<void>;
  health(id: string): Promise<TabView>;
  terminate(id: string): Promise<TabView>;
  recreate(id: string): Promise<TabView>;
  restart(id: string): Promise<TabView>;
  restartBridge(id: string): Promise<TabView>;
}

export function createTabsApi(
  basePath: string,
  fetchImpl: typeof fetch = fetch,
): TabsApi {
  const prefix = basePath === '/' ? '' : basePath;
  const tabsPath = `${prefix}/api/tabs`;

  const json = async <T>(
    path: string,
    method: string,
    schema: { parse(value: unknown): T },
    body?: unknown,
  ): Promise<T> => {
    const response = await request(fetchImpl, path, method, body);
    if (!response.ok) throw await responseError(response);
    try {
      return schema.parse(await response.json());
    } catch {
      throw new TabApiError();
    }
  };

  const lifecycle = async (id: string, action: string) =>
    await json(
      `${tabsPath}/${parseId(id)}/${action}`,
      'POST',
      tabViewSchema,
      {},
    );

  return {
    list: () => json(tabsPath, 'GET', tabCollectionResponseSchema),
    async create(displayName) {
      const body = parseLocal(
        createTabBodySchema,
        displayName === undefined ? {} : { displayName },
      );
      return await json(tabsPath, 'POST', tabViewSchema, body);
    },
    async rename(id, displayName) {
      const body = parseLocal(renameTabBodySchema, { displayName });
      return await json(
        `${tabsPath}/${parseId(id)}`,
        'PATCH',
        tabViewSchema,
        body,
      );
    },
    async reorder(structureRevision, ids) {
      const body = parseLocal(reorderTabsBodySchema, {
        structureRevision,
        ids,
      });
      return await json(
        `${tabsPath}/order`,
        'PUT',
        tabCollectionResponseSchema,
        body,
      );
    },
    async close(id) {
      const response = await request(
        fetchImpl,
        `${tabsPath}/${parseId(id)}`,
        'DELETE',
      );
      if (!response.ok) throw await responseError(response);
    },
    health: async (id) =>
      await json(`${tabsPath}/${parseId(id)}/session`, 'GET', tabViewSchema),
    terminate: (id) => lifecycle(id, 'session/terminate'),
    recreate: (id) => lifecycle(id, 'session/recreate'),
    restart: (id) => lifecycle(id, 'session/restart'),
    restartBridge: (id) => lifecycle(id, 'bridge/restart'),
  };
}

async function request(
  fetchImpl: typeof fetch,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await fetchImpl(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  } catch {
    throw new TabApiError();
  }
}

async function responseError(response: Response): Promise<TabApiError> {
  try {
    const parsed = apiErrorResponseSchema.safeParse(await response.json());
    return new TabApiError(parsed.success ? parsed.data.error : undefined);
  } catch {
    return new TabApiError();
  }
}

function parseId(id: string): string {
  try {
    return tabIdSchema.parse(id);
  } catch {
    throw new TabApiError();
  }
}

function parseLocal<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TabApiError();
  return parsed.data;
}
