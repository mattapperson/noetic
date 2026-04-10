/**
 * Theme toggle component
 * Select between system, light, and dark themes
 */

import type React from 'react';
import type { ThemeMode } from '../stores/theme';
import { useThemeStore } from '../stores/theme';

export const ThemeToggle: React.FC = () => {
  const { mode, setMode } = useThemeStore();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setMode(e.target.value as ThemeMode);
  };

  return (
    <select
      value={mode}
      onChange={handleChange}
      title="Theme"
      style={{
        padding: '4px 8px',
        fontSize: '12px',
        borderRadius: '4px',
        border: '1px solid var(--noetic-border)',
        backgroundColor: 'var(--noetic-input-bg)',
        color: 'var(--noetic-text)',
        cursor: 'pointer',
      }}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
};

export default ThemeToggle;
