import { create } from 'zustand';

export type ThemeMode = 'system' | 'dark' | 'light';

interface ThemeState {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  initTheme: () => void;
}

const STORAGE_KEY = 'noetic-ui-theme';

const getStoredMode = (): ThemeMode | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return null;
};

const setStoredMode = (mode: ThemeMode): void => {
  if (typeof window === 'undefined') {
    return;
  }
  // Only store if explicitly set to light or dark
  // Don't store 'system' - let it follow system preference
  if (mode === 'light' || mode === 'dark') {
    localStorage.setItem(STORAGE_KEY, mode);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
};

const getSystemPrefersDark = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const getInitialMode = (): ThemeMode => {
  const stored = getStoredMode();
  return stored ?? 'system';
};

const applyTheme = (isDark: boolean): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  if (isDark) {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.remove('dark');
    root.classList.add('light');
  }

  // Update meta theme-color for mobile browsers
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', isDark ? '#0f172a' : '#f8fafc');
  }
};

export const useThemeStore = create<ThemeState>()((set, get) => ({
  mode: getInitialMode(),
  isDark: getSystemPrefersDark(),

  setMode: (mode) => {
    const isDark = mode === 'dark' || (mode === 'system' && getSystemPrefersDark());
    set({
      mode,
      isDark,
    });
    applyTheme(isDark);
    setStoredMode(mode);
  },

  toggleTheme: () => {
    const { mode, isDark } = get();
    let newMode: ThemeMode;
    let newIsDark: boolean;

    if (mode === 'system') {
      // If in system mode, switch to opposite of current system preference
      newMode = isDark ? 'light' : 'dark';
      newIsDark = !isDark;
    } else if (mode === 'dark') {
      newMode = 'light';
      newIsDark = false;
    } else {
      newMode = 'dark';
      newIsDark = true;
    }

    set({
      mode: newMode,
      isDark: newIsDark,
    });
    applyTheme(newIsDark);
    setStoredMode(newMode);
  },

  initTheme: () => {
    const { mode } = get();
    const isDark = mode === 'dark' || (mode === 'system' && getSystemPrefersDark());
    set({
      isDark,
    });
    applyTheme(isDark);

    // Listen for system preference changes
    if (typeof window !== 'undefined') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQuery.addEventListener('change', (e) => {
        if (get().mode === 'system') {
          set({
            isDark: e.matches,
          });
          applyTheme(e.matches);
        }
      });
    }
  },
}));
