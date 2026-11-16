import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Role, type SessionInfo } from './api';

interface AuthState {
  loading: boolean;
  session: SessionInfo | null;
  role: Role;
}

const AuthContext = createContext<AuthState>({ loading: true, session: null, role: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ loading: true, session: null, role: null });

  useEffect(() => {
    let cancelled = false;
    const load = async (session: SessionInfo | null) => {
      let role: Role = null;
      if (session) {
        try {
          role = await api.myRole();
        } catch {
          role = null;
        }
      }
      if (!cancelled) setState({ loading: false, session, role });
    };
    void api.getSession().then(load);
    const off = api.onAuthChange((s) => {
      setState((prev) => (prev.session?.userId === s?.userId && !prev.loading ? prev : { ...prev, loading: true }));
      void load(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
