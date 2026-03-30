import type React from 'react';

export type TabId = 'session' | 'attempt' | 'events';

interface Tab {
  id: TabId;
  label: string;
}

const TABS: Tab[] = [
  {
    id: 'session',
    label: 'Session',
  },
  {
    id: 'attempt',
    label: 'Attempt',
  },
  {
    id: 'events',
    label: 'Events',
  },
];

interface InspectorTabsProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export const InspectorTabs: React.FC<InspectorTabsProps> = ({ activeTab, onTabChange }) => {
  return (
    <div className="flex items-center gap-1 p-2 border-b border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)]">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onTabChange(tab.id)}
          className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all duration-150 ${
            activeTab === tab.id
              ? 'bg-[var(--noetic-accent)] text-white shadow-sm'
              : 'text-[var(--noetic-text-secondary)] hover:text-[var(--noetic-text)] hover:bg-[var(--noetic-hover)]'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};
