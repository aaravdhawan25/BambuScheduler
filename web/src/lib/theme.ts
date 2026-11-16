import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'theme';
const listeners = new Set<() => void>();
let current: Theme = readTheme();

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#121519' : '#f9fafb');
}

export function setTheme(t: Theme) {
  current = t;
  applyTheme(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: theme just won't persist */
  }
  listeners.forEach((l) => l());
}

/** Dark by default; light is opt-in and remembered on this device. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return [theme, setTheme];
}
