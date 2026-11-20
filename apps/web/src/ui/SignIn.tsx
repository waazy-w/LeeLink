import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Logo } from './common';

export function SignIn({ title = 'Sign in to play', autoFocus = true }: { title?: string; autoFocus?: boolean }) {
  const { signInGuest, discordEnabled, discordUrl } = useAuth();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string>();
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="panel w-full max-w-sm space-y-4 p-6 animate-pop">
        <Logo className="text-2xl" />
        <h1 className="text-lg font-bold">{title}</h1>
        {discordEnabled && (
          <a className="btn w-full bg-[#5865F2] text-white hover:bg-[#4752c4]" href={discordUrl()}>
            Continue with Discord
          </a>
        )}
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await signInGuest(name);
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          <label className="label">{discordEnabled ? 'Or play as a guest' : 'Your name'}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Trainer name" maxLength={32} autoFocus={autoFocus} />
          <button className="btn-primary w-full" disabled={!name.trim()}>
            Let's go
          </button>
          {err && <div className="text-xs text-rose-300">{err}</div>}
        </form>
      </div>
    </div>
  );
}
