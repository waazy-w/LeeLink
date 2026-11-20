import type { FeedItem } from '@leelink/shared/engine/types';

const COLORS: Partial<Record<FeedItem['kind'], number>> = { death: 0xe11d48, badge: 0xfbbf24, wipe: 0x7f1d1d, link: 0x38bdf8 };
const ICONS: Partial<Record<FeedItem['kind'], string>> = { death: '💀', badge: '🏅', wipe: '☠️', link: '🔗' };

/** Posts run events to a Discord webhook. Failures are logged, never thrown (they must not break the run). */
export async function notifyDiscord(url: string, runName: string, items: FeedItem[], ended?: string) {
  if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(url)) return;
  const embeds = items.slice(0, 9).map((f) => ({
    description: `${ICONS[f.kind] ?? ''} ${f.text}`,
    color: COLORS[f.kind],
    timestamp: new Date(f.at).toISOString(),
  }));
  if (ended) {
    embeds.push({
      description: ended === 'won' ? `🏆 **${runName}** is complete! Welcome to the hall of fame.` : `🪦 **${runName}** has ended (${ended}).`,
      color: ended === 'won' ? 0x22c55e : 0x6b7280,
      timestamp: new Date().toISOString(),
    });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `Lee Link · ${runName}`.slice(0, 80), embeds }),
    });
    if (!res.ok) console.warn(`discord webhook ${res.status}`);
  } catch (err) {
    console.warn('discord webhook failed', (err as Error).message);
  }
}

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function discordConfig(): DiscordConfig | undefined {
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL } = process.env;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !PUBLIC_URL) return undefined;
  return { clientId: DISCORD_CLIENT_ID, clientSecret: DISCORD_CLIENT_SECRET, redirectUri: `${PUBLIC_URL.replace(/\/$/, '')}/api/auth/discord/callback` };
}

export function discordAuthorizeUrl(cfg: DiscordConfig, state: string) {
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: 'identify', state, prompt: 'none' });
  return `https://discord.com/oauth2/authorize?${q}`;
}

export async function discordExchange(cfg: DiscordConfig, code: string): Promise<{ id: string; name: string; avatar?: string }> {
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }),
  });
  if (!tokenRes.ok) throw new Error(`discord token exchange failed (${tokenRes.status})`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const meRes = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${access_token}` } });
  if (!meRes.ok) throw new Error(`discord profile fetch failed (${meRes.status})`);
  const me = (await meRes.json()) as { id: string; username: string; global_name?: string; avatar?: string };
  return {
    id: me.id,
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : undefined,
  };
}
