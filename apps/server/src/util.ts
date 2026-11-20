import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const id = (bytes = 9) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');

/** Human-friendly invite code without ambiguous characters. */
export function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(.{4})/, '$1-$2');
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

export async function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req, 256 * 1024);
  try {
    return JSON.parse(buf.toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  const cookie = req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith('ll_token='));
  return cookie ? decodeURIComponent(cookie.slice(9)) : undefined;
}
