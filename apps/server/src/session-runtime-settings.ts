import {
  parseWorkspaceSettings,
  type WorkspaceSettings,
  type WorkspaceSettingsConstraints,
} from '@flanterminal/shared';

export type SessionRuntimeSettings = Readonly<{
  shell: string;
  historyLimit: number;
}>;

export interface SessionRuntimeSettingsProvider {
  current(): SessionRuntimeSettings;
}

export interface SessionRuntimeSettingsStore {
  snapshot(): WorkspaceSettings;
}

export type StoredSessionRuntimeSettingsProviderOptions = Readonly<{
  store: SessionRuntimeSettingsStore;
  constraints: WorkspaceSettingsConstraints;
  verifiedShells: readonly string[];
}>;

export class StoredSessionRuntimeSettingsProvider implements SessionRuntimeSettingsProvider {
  private readonly verifiedShells: ReadonlySet<string>;

  constructor(
    private readonly options: StoredSessionRuntimeSettingsProviderOptions,
  ) {
    this.verifiedShells = new Set(options.verifiedShells);
  }

  current(): SessionRuntimeSettings {
    try {
      const settings = parseWorkspaceSettings(
        this.options.store.snapshot(),
        this.options.constraints,
      );
      if (!this.verifiedShells.has(settings.defaultShell)) throw new Error();
      return Object.freeze({
        shell: settings.defaultShell,
        historyLimit: settings.tmuxHistoryLimit,
      });
    } catch {
      throw new Error('Invalid runtime settings');
    }
  }
}
