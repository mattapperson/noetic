import type React from 'react';
import { useEffect } from 'react';
import { PlaybackBar } from './components/PlaybackBar';
import { useThemeStore } from './stores/theme';

// Three-panel layout components
const LeftSidebar: React.FC = () => {
  return (
    <div className="w-64 h-full border-r border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)] flex flex-col">
      <div className="p-4 border-b border-[var(--noetic-border)]">
        <h1 className="text-lg font-semibold text-[var(--noetic-text)]">Noetic UI</h1>
        <p className="text-xs text-[var(--noetic-text-secondary)]">Agent Debugger</p>
      </div>

      <div className="p-3">
        <input
          type="text"
          placeholder="Search agents..."
          className="w-full px-3 py-2 text-sm rounded-md bg-[var(--noetic-input-bg)] border border-[var(--noetic-border)] text-[var(--noetic-text)] placeholder-[var(--noetic-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--noetic-accent)]"
        />
      </div>

      <div className="flex-1 overflow-auto p-3">
        <p className="text-xs text-[var(--noetic-text-muted)] uppercase tracking-wide mb-2">
          Agents
        </p>
        <div className="space-y-1">
          <div className="p-2 rounded-md hover:bg-[var(--noetic-hover)] cursor-pointer">
            <div className="flex items-center gap-2">
              <span className="text-green-500">●</span>
              <span className="text-sm text-[var(--noetic-text)]">code-review-agent.ts</span>
            </div>
            <p className="text-xs text-[var(--noetic-text-secondary)] ml-5">2 runs</p>
          </div>
          <div className="p-2 rounded-md hover:bg-[var(--noetic-hover)] cursor-pointer">
            <div className="flex items-center gap-2">
              <span className="text-gray-400">●</span>
              <span className="text-sm text-[var(--noetic-text)]">pr-analysis.ts</span>
            </div>
            <p className="text-xs text-[var(--noetic-text-secondary)] ml-5">5 runs</p>
          </div>
        </div>
      </div>

      <div className="p-3 border-t border-[var(--noetic-border)]">
        <button
          type="button"
          onClick={() => useThemeStore.getState().toggleTheme()}
          className="w-full px-3 py-2 text-sm rounded-md bg-[var(--noetic-button-bg)] hover:bg-[var(--noetic-button-hover)] text-[var(--noetic-text)] transition-colors"
        >
          Toggle Theme
        </button>
      </div>
    </div>
  );
};

const CenterCanvas: React.FC = () => {
  const { currentRun } = useExecutionStore();

  return (
    <div className="flex-1 h-full bg-[var(--noetic-canvas-bg)] relative overflow-hidden">
      {currentRun ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-lg font-medium text-[var(--noetic-text)]">Run: {currentRun.id}</p>
            <p className="text-sm text-[var(--noetic-text-secondary)] mt-2">
              Status: {currentRun.status}
            </p>
            <div className="mt-4 p-4 rounded-lg border border-[var(--noetic-border)] bg-[var(--noetic-node-bg)]">
              <p className="text-xs text-[var(--noetic-text-muted)]">
                Node graph will be rendered here
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="text-6xl mb-4">🔮</div>
            <p className="text-lg text-[var(--noetic-text-secondary)]">
              Select an agent to view execution
            </p>
          </div>
        </div>
      )}

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-30"
        style={{
          backgroundImage: `
            radial-gradient(circle, var(--noetic-grid-color) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px',
        }}
      />
    </div>
  );
};

const RightPanel: React.FC = () => {
  return (
    <div className="w-80 h-full border-l border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)] flex flex-col">
      <div className="p-4 border-b border-[var(--noetic-border)]">
        <h2 className="text-sm font-semibold text-[var(--noetic-text)]">Inspector</h2>
        <p className="text-xs text-[var(--noetic-text-secondary)]">Select a step to view details</p>
      </div>
      <div className="flex-1 p-4">
        <p className="text-sm text-[var(--noetic-text-muted)]">Step details will appear here</p>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  const { initTheme } = useThemeStore();

  useEffect(() => {
    initTheme();
  }, [
    initTheme,
  ]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--noetic-bg)]">
      <div className="flex-1 flex overflow-hidden">
        <LeftSidebar />
        <CenterCanvas />
        <RightPanel />
      </div>
      <PlaybackBar nodes={new Map()} />
    </div>
  );
};

export default App;
