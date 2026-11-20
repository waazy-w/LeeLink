import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { RunPlayer, RunSummary } from '@leelink/shared/protocol';
import { Avatar, Logo } from '../ui/common';
import { SignIn } from '../ui/SignIn';
import { RULE_HELP } from '../ui/dashboard/RulesPanel';

export function JoinPage() {
  const { code } = useParams();
  const { user, loading } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState<{ run: RunSummary; players: RunPlayer[] }>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api<{ run: RunSummary; players: RunPlayer[] }>(`/api/invite/${code}`).then(setInfo, (e) => setErr(e.message));
  }, [code]);

  if (loading) return null;
  if (err) return <div className="p-10 text-center text-rose-300">{err}</div>;
  if (!info) return null;
  const already = user && info.players.some((p) => p.user.id === user.id);

  return (
    <div className="mx-auto max-w-lg space-y-5 p-6">
      <Logo className="text-2xl" />
      <div className="panel space-y-4 p-5">
        <div className="text-xs font-bold tracking-widest text-ink-400 uppercase">You're invited to</div>
        <h1 className="text-2xl font-black">{info.run.name}</h1>
        <div className="text-sm text-ink-300">{info.run.gameName ?? 'Any game'}</div>
        <div className="flex flex-wrap gap-2">
          {info.players.map((p) => (
            <span key={p.playerId} className="flex items-center gap-1.5 rounded-full bg-ink-800 py-0.5 pr-3 pl-0.5 text-sm">
              <Avatar name={p.user.name} color={p.color} src={p.user.avatar} size={22} />
              {p.user.name}
            </span>
          ))}
          <span className="text-sm text-ink-500">
            {info.players.length}/{info.run.maxPlayers}
          </span>
        </div>
        <details className="text-xs text-ink-400">
          <summary className="cursor-pointer">Rules</summary>
          <ul className="mt-2 space-y-1">
            {Object.entries(info.run.settings).map(([k, v]) => (
              <li key={k}>
                <b className="text-ink-200">{RULE_HELP[k as keyof typeof RULE_HELP] ?? k}:</b> {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </li>
            ))}
          </ul>
        </details>
        {!user ? null : already ? (
          <button className="btn-primary w-full" onClick={() => nav(`/run/${info.run.id}`)}>
            Open the run
          </button>
        ) : (
          <button
            className="btn-primary w-full"
            onClick={async () => {
              try {
                await api(`/api/invite/${code}/join`, { method: 'POST' });
                nav(`/run/${info.run.id}`);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Join the run
          </button>
        )}
      </div>
      {!user && <SignIn title="Sign in to join" />}
    </div>
  );
}
