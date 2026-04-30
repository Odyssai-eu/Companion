import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, type AuthRole, type AuthUser } from "~/lib/api";

type AuthState = {
  user: AuthUser | null;
  /** Convenience: the current user's role, or null when no user is loaded. */
  role: AuthRole | null;
  /** Convenience: whether the current user is active. Defaults to true when
   *  the field isn't surfaced (older sessions). */
  active: boolean;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.me();
      setUser(user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const { user } = await api.login({ email, password });
      setUser(user);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);

  const signup = useCallback(
    async (email: string, password: string, name?: string) => {
      setError(null);
      try {
        const { user } = await api.signup({ email, password, name });
        setUser(user);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value: AuthState = {
    user,
    role: user?.role ?? null,
    active: user?.active ?? true,
    loading,
    error,
    login,
    signup,
    logout,
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
