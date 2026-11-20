import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { openDb } from './db';
import { Store } from './store';
import { Rooms } from './rooms';
import { createHttpHandler } from './http';

export function createApp(opts: { dbPath: string; staticDir?: string }) {
  const store = new Store(openDb(opts.dbPath));
  const rooms = new Rooms(store);
  const server = createServer(createHttpHandler(store, rooms, opts.staticDir));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => rooms.attach(ws));
  });
  // Keep idle connections alive through proxies.
  const interval = setInterval(() => wss.clients.forEach((ws) => ws.ping()), 30_000);
  server.on('close', () => clearInterval(interval));
  return { server, store, rooms };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const dbPath = resolve(process.env.DATA_DIR ?? 'data', 'leelink.db');
  const staticDir = resolve(process.env.STATIC_DIR ?? new URL('../../web/dist', import.meta.url).pathname);
  const { server } = createApp({ dbPath, staticDir: existsSync(staticDir) ? staticDir : undefined });
  server.listen(port, () => console.log(`Lee Link server on http://localhost:${port} (db ${dbPath})`));
}
