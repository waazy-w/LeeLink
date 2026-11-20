import { useEffect, useState } from 'react';
import { ProfileRegistry } from '@leelink/shared/profiles/registry';
import type { GameProfile } from '@leelink/shared/profiles/types';
import { api, STATIC } from './api';

const LOCAL_KEY = 'leelink.localProfiles';

/** Built-in profiles + community profiles from the server + drafts saved in this browser. */
export const registry = new ProfileRegistry();

export function localProfiles(): GameProfile[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveLocalProfile(p: GameProfile) {
  const all = localProfiles().filter((x) => x.id !== p.id);
  localStorage.setItem(LOCAL_KEY, JSON.stringify([...all, p]));
  registry.add(p);
}

export function deleteLocalProfile(id: string) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(localProfiles().filter((x) => x.id !== id)));
  registry.remove(id);
}

let loaded: Promise<void> | undefined;
export function loadProfiles(): Promise<void> {
  loaded ??= (async () => {
    try {
      if (STATIC) throw new Error('no server');
      const res = await api<{ profiles: GameProfile[] }>('/api/profiles');
      res.profiles.forEach((p) => registry.add(p));
    } catch {
      /* offline: built-ins still work */
    }
    localProfiles().forEach((p) => registry.add(p));
  })();
  return loaded;
}

export function useProfilesLoaded() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void loadProfiles().then(() => setReady(true));
  }, []);
  return ready;
}
