import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ThemeMode = 'system' | 'dark' | 'light';

interface ThemeState {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  initTheme: () => void;
}

const STORAGE_KEY = 'noetic-ui-theme';

const getSystemPrefersDark = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const applyTheme = (isDark: boolean): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  // Update meta theme-color for mobile browsers
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', isDark ? '#0f172a' : '#f8fafc');
  }
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      isDark: getSystemPrefersDark(),

      setMode: (mode) => {
        const isDark = mode === 'dark' || (mode === 'system' && getSystemPrefersDark());
        set({
          mode,
          isDark,
        });
        applyTheme(isDark);
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
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        mode: state.mode,
      }),
    },
  ),
);
