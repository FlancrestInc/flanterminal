import { Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';

export type TabBarItem = Readonly<{
  id: string;
  displayName: string;
  desiredState: 'active' | 'stopped';
}>;

export type TabBarProps = Readonly<{
  tabs: readonly TabBarItem[];
  selectedId: string | null;
  statusFor: (id: string) => string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, displayName: string) => void;
  onReorder: (ids: readonly string[]) => void;
  onRequestClose: (id: string) => void;
}>;

export function TabBar({
  tabs,
  selectedId,
  statusFor,
  onSelect,
  onCreate,
  onRename,
  onReorder,
  onRequestClose,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const draggedId = useRef<string | null>(null);

  const beginRename = (tab: TabBarItem) => {
    setEditingId(tab.id);
    setDraft(tab.displayName);
  };
  const commitRename = (tab: TabBarItem) => {
    setEditingId(null);
    if (draft !== tab.displayName) onRename(tab.id, draft);
  };

  return (
    <div className="tab-bar">
      <div className="tab-strip" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={
              tab.id === selectedId ? 'terminal-tab is-active' : 'terminal-tab'
            }
            data-testid={`tab-${tab.id}`}
            draggable={editingId !== tab.id}
            onDragStart={() => {
              draggedId.current = tab.id;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const source = draggedId.current;
              draggedId.current = null;
              if (source === null || source === tab.id) return;
              const ids = tabs.map(({ id }) => id);
              const sourceIndex = ids.indexOf(source);
              const targetIndex = ids.indexOf(tab.id);
              if (sourceIndex < 0 || targetIndex < 0) return;
              ids.splice(sourceIndex, 1);
              ids.splice(targetIndex, 0, source);
              onReorder(ids);
            }}
          >
            <span
              className={`tab-status status-${statusFor(tab.id)}`}
              aria-hidden="true"
            />
            {editingId === tab.id ? (
              <input
                className="tab-rename-input"
                aria-label={`Rename ${tab.displayName}`}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commitRename(tab)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename(tab);
                  if (event.key === 'Escape') setEditingId(null);
                }}
              />
            ) : (
              <button
                className="tab-select"
                type="button"
                role="tab"
                aria-selected={tab.id === selectedId}
                tabIndex={tab.id === selectedId ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => beginRename(tab)}
              >
                <span className="tab-label">{tab.displayName}</span>
              </button>
            )}
            <button
              className="tab-close"
              type="button"
              title={`Close ${tab.displayName}`}
              aria-label={`Close ${tab.displayName}`}
              onClick={() => onRequestClose(tab.id)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button
        className="icon-button new-tab-button"
        type="button"
        title="New terminal tab"
        aria-label="New terminal tab"
        onClick={onCreate}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
