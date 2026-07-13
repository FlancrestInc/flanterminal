export interface WorkspaceBootstrapSettingsStore {
  snapshot(): Readonly<{ automaticTabCreation: boolean }>;
}

export interface WorkspaceBootstrapTabStore {
  ensureInitialTab(): Promise<unknown>;
}

export interface AuthenticatedWorkspaceBootstrap {
  ensureForAuthenticatedSession(): Promise<void>;
}

export type WorkspaceBootstrapOptions = Readonly<{
  settingsStore: WorkspaceBootstrapSettingsStore;
  tabStore: WorkspaceBootstrapTabStore;
}>;

export class WorkspaceBootstrap implements AuthenticatedWorkspaceBootstrap {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkspaceBootstrapOptions) {}

  ensureForAuthenticatedSession(): Promise<void> {
    const operation = async (): Promise<void> => {
      try {
        if (!this.options.settingsStore.snapshot().automaticTabCreation) return;
        await this.options.tabStore.ensureInitialTab();
      } catch {
        throw new Error('Workspace bootstrap failed');
      }
    };
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
