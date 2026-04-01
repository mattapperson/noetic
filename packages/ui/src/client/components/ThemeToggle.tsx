/**
 * Theme toggle component
 * Allows switching between system, light, and dark themes
 */

import type React from 'react';
import { useThemeStore } from '../stores/theme';

export const ThemeToggle: React.FC = () => {
  const { mode, toggleTheme } = useThemeStore();

  const getIcon = () => {
    switch (mode) {
      case 'light':
        return '☀️';
      case 'dark':
        return '🌙';
      case 'system':
        return '🖥️';
    }
  };

  const getLabel = () => {
    switch (mode) {
      case 'light':
        return 'Light';
      case 'dark':
        return 'Dark';
      case 'system':
        return 'System';
    }
  };

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={`Theme: ${getLabel()} (click to toggle)`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 8px',
        fontSize: '12px',
        borderRadius: '4px',
        border: '1px solid var(--noetic-border)',
        backgroundColor: 'var(--noetic-button-bg)',
        color: 'var(--noetic-text)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--noetic-button-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--noetic-button-bg)';
      }}
    >
      <span>{getIcon()}</span>
      <span>{getLabel()}</span>
    </button>
  );
};

export default ThemeToggle;
