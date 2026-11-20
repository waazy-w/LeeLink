import { useEffect, useRef, useState } from 'react';
import type { RunCtx } from './ctx';
import { timeAgo } from '../common';

const REACTIONS = ['🔥', '😭', '💀', '🎉', '😱', '🙏', 'GG'];

export function Chat({ ctx }: { ctx: RunCtx }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const msgs = ctx.snap.chat;
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [msgs.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pb-2">
        {msgs.map((m) =>
          m.kind === 'reaction' ? (
            <div key={m.id} className="text-center text-xs text-ink-400">
              <span style={{ color: ctx.color(m.playerId) }}>{ctx.name(m.playerId)}</span> <span className="text-lg">{m.text}</span>
            </div>
          ) : (
            <div key={m.id} className={`flex flex-col ${m.playerId === ctx.me ? 'items-end' : 'items-start'}`}>
              <div className="text-[10px] text-ink-500">
                <span style={{ color: ctx.color(m.playerId) }}>{ctx.name(m.playerId)}</span> · {timeAgo(m.at)}
              </div>
              <div className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ${m.playerId === ctx.me ? 'bg-link-b/20' : 'bg-ink-800'}`}>{m.text}</div>
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <div className="flex gap-1 pb-2">
        {REACTIONS.map((r) => (
          <button key={r} className="rounded-lg bg-ink-800 px-2 py-1 text-sm hover:bg-ink-700" onClick={() => ctx.conn.react(r)}>
            {r}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          ctx.conn.chat(text.trim());
          setText('');
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something…" maxLength={500} />
        <button className="btn-secondary">Send</button>
      </form>
    </div>
  );
}
