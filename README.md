# Lee Link

Play Pokémon **Soul Link** runs with 2–4 friends in the browser. Everyone plays their own copy of a
game; Lee Link reads each game's memory, links encounters per route, kills partners when one
falls, and enforces the run's rules — no spreadsheet.

- **Your ROMs stay on your device.** ROMs are picked locally, cached in IndexedDB, and only their
  SHA-1 hash is shared (so the lobby can confirm everyone has the same game). Saves and run state
  go to the server.
- **Auto-tracking** from emulator memory: party, HP, faints, encounters, catches, battles, map,
  badges. Games without a profile run in **manual mode** with quick buttons.
- **Rules engine** on an append-only event log: undo, disputes with votes, retry tokens, orphans,
  dupes/shiny/type clauses, team sync helper, pacing gates, level caps, revive shards, wipe rules.
- Dashboard, link board, graveyard, activity feed, chat, live screen previews, cloud saves with
  version history, Discord webhook, OBS overlay, recap page and hall of fame.

## Game support

| Games | Engine | Tracking |
|---|---|---|
| FireRed, LeafGreen, Emerald (US) | `gen3` | Full: generated from the pret decomps, tested on recorded memory. |
| Red, Blue, Yellow, Gold, Silver, Crystal (US) + Crystal Clear | `gen1` / `gen2` | Full: generated from the pret decomps; Red tested on recorded memory. |
| Platinum, DP, HGSS, BW, B2W2 + Renegade Platinum, Sacred Gold, Storm Silver, Blaze Black (2), Volt White (2), Vintage White | `gen4` / `gen5` | **Experimental.** Party, faints and catches are automatic (party found by RAM signature scan); set location with the “I'm at” button. |
| Anything else | `manual` | Quick buttons. |

Ruby/Sapphire aren't profiled yet (manual mode).

## Setup

Requires Node 24+ (uses the built-in `node:sqlite`).

```bash
npm install
npm run dev          # server on :8787 + Vite on :5173 (proxying /api and /ws)
npm test             # unit + integration tests (rules engine, decoders, recorded memory, server)
npm run typecheck
```

Open http://localhost:5173, pick a name, create a run, send the invite link.

Optional Discord login: copy `.env.example`, set `PUBLIC_URL`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, and register `${PUBLIC_URL}/api/auth/discord/callback` as a redirect URI.
Guests can always play without Discord.

## Deploy (single cheap host)

The server serves the built web app, the WebSocket rooms and the SQLite database from one process.

```bash
docker build -t leelink .
docker run -p 8787:8787 -v leelink-data:/data -e PUBLIC_URL=https://your.domain leelink
```

Any host that runs one container with a persistent volume works (Fly.io, Railway, a small VPS).
Put it behind HTTPS (needed for WebSockets over `wss://` and clipboard access). No special
cross-origin-isolation headers are required: the emulator cores are single-threaded.

Without Docker: `npm ci && npm run build && DATA_DIR=./data npm start`.

## Architecture

```
apps/web        React + Vite + Tailwind. Emulator view, tracker, dashboard, overlay, profile editor.
apps/server     Node HTTP + WebSocket server, SQLite (node:sqlite). Owns ordering of the event log.
packages/shared Everything pure: memory readers, game profiles, decoders, event detector,
                rules engine, protocol types. Used by both web and server.
cores/          Our own C/C++ frontends for mGBA (GB/GBC/GBA) and melonDS (DS), built to WASM.
```

- **One memory interface** (`packages/shared/src/memory/reader.ts`): cores expose RAM regions as
  zero-copy views; recorded snapshots (`.llsnap`) implement the same interface, so tests run on
  real game memory without an emulator.
- **Profiles are data** (`packages/shared/src/profiles`): addresses, offsets, location names,
  trainers, level caps. Code lives in one reader per generation (`gen1`…`gen4`).
- **Detector** (`tracking/detector.ts`) turns state samples (4 Hz) into tracker events.
- **Engine** (`engine/reducer.ts`) is a pure function from the log to run state. The server and
  every client rebuild state from the same log, so they always agree; undo and disputes are just
  more log entries.

## Adding a game or ROM hack profile

1. **Hack of a supported game**: open *Game profiles → New ROM hack profile*, pick the base game,
   add your ROM (only its hash is kept), and override only what changed, e.g.
   ```json
   { "locations": { "88": "New Pallet" }, "typingGeneration": 6,
     "levelCaps": [{ "badge": 1, "label": "Brock", "level": 12 }] }
   ```
   Save as a draft (this browser) or publish it for everyone.
2. **Finding addresses**: play the game, open the **Debug** tab. It shows the decoded state, a hex
   viewer and a **RAM search** (search a value you can see, change it in-game, narrow down).
   Export a `.llsnap` snapshot to add a test fixture.
3. **A new base game from a decomp**: see `scripts/codegen/gen3-profile.mjs` and
   `scripts/codegen/gen12-profile.mjs`; they pull symbols from the built ELF/.sym, compile the
   decomp headers to get struct offsets, and read location/trainer tables.
4. **Tests**: record fixtures headlessly with `scripts/drive.ts` (GBA), `scripts/drive-gb.ts` or
   `scripts/drive-ds.ts` — they resume from save states, run an input script and write a snapshot —
   then replay them through the reader and `EventDetector` (see `tracking/detector.test.ts`).

## Rebuilding the emulator cores

The built `.wasm` files are committed in `apps/web/public/cores`. To rebuild, install
[emsdk](https://emscripten.org) to `~/emsdk`, plus `cmake` and `ninja`, then:

```bash
npm run build:cores
```

## Licenses

The mGBA core is MPL-2.0 and the melonDS core is **GPL-3.0** (license files in
`apps/web/public/cores/*`). Because the site ships the melonDS core, distribute the project under
GPL-3.0-compatible terms. Lee Link includes no ROMs, BIOS files or game assets; sprites are loaded
from the PokeAPI sprite repository at runtime.
