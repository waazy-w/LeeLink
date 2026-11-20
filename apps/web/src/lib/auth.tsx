import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { UserInfo } from '@leelink/shared/protocol';
import { api, setToken, STATIC, type MeResponse } from './api';

interface AuthState {
  user: UserInfo | null;
  loading: boolean;
  discordEnabled: boolean;
  signInGuest(name: string): Promise<void>;
  rename(name: string): Promise<void>;
  signOut(): Promise<void>;
  discordUrl(next?: string): string;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [discordEnabled, setDiscord] = useState(false);

  const refresh = useCallback(async () => {
    if (STATIC) {
      setLoading(false);
      return;
    }
    try {
      const me = await api<MeResponse>('/api/me');
      setUser(me.user);
      setDiscord(me.discord);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: AuthState = {
    user,
    loading,
    discordEnabled,
    async signInGuest(name) {
      const res = await api<{ user: UserInfo; token: string }>('/api/auth/guest', { body: { name } });
      setToken(res.token);
      setUser(res.user);
    },
    async rename(name) {
      const res = await api<{ user: UserInfo }>('/api/me', { method: 'PATCH', body: { name } });
      setUser(res.user);
    },
    async signOut() {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      setToken(undefined);
      setUser(null);
    },
    discordUrl(next = location.pathname) {
      return `/api/auth/discord?next=${encodeURIComponent(next)}`;
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
