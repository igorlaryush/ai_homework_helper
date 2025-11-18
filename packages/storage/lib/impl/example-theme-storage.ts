import { createStorage, StorageEnum } from '../base/index.js';
import type { ThemeStateType, ThemeStorageType } from '../base/index.js';

const getSystemPrefersLight = (): boolean => {
  try {
    // window is not available in service workers/background
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return !window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
};

const storage = createStorage<ThemeStateType>(
  'theme-storage-key',
  {
    theme: 'system',
    isLight: getSystemPrefersLight(),
  },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const exampleThemeStorage: ThemeStorageType = {
  ...storage,
  toggle: async () => {
    await storage.set(currentState => {
      // Toggle explicitly between light and dark; leaving 'system' only for default/explicit choice
      const baseTheme =
        currentState.theme === 'system' ? (getSystemPrefersLight() ? 'light' : 'dark') : currentState.theme;
      const newTheme = baseTheme === 'light' ? 'dark' : 'light';

      return {
        theme: newTheme,
        isLight: newTheme === 'light',
      };
    });
  },
};

// Best-effort: keep 'system' mode in sync with OS/Browser color scheme in UI contexts
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const applySystem = () => {
    void storage.set(prev => {
      if (prev.theme !== 'system') return prev;
      const nextIsLight = !mql.matches;
      if (prev.isLight === nextIsLight) return prev;
      return { theme: 'system', isLight: nextIsLight };
    });
  };
  if ('addEventListener' in mql) {
    mql.addEventListener('change', applySystem);
  } else {
    // Safari/old Chromium fallback
    (mql as any).addListener?.(applySystem);
  }
  // Initialize once on load
  void (async () => {
    const current = await storage.get();
    if (current.theme === 'system') {
      const nextIsLight = !mql.matches;
      if (current.isLight !== nextIsLight) {
        await storage.set({ theme: 'system', isLight: nextIsLight });
      }
    }
  })();
}
