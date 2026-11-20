// Browser end-to-end check: two players, one run, real emulator + tracker in Chromium.
// usage: node scripts/e2e-browser.mjs <rom> [save] [outDir]
// Starts the server (serving apps/web/dist) on a scratch database.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [romPath, savePath, outDir = '/tmp/ll-e2e'] = process.argv.slice(2);
const PORT = 8790;
const base = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'll-data-'));
const server = spawn('npx', ['tsx', 'apps/server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: 'apps/web/dist' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch { /* not up yet */ }
  await sleep(200);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const logs = [];
async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${name}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[${name}] PAGEERROR ${e.message}`));
  await page.goto(base);
  await page.getByPlaceholder('Trainer name').fill(name);
  await page.getByRole('button', { name: "Let's go" }).click();
  await page.getByText('Your runs').waitFor();
  return page;
}

try {
  const ash = await player('Ash');
  const misty = await player('Misty');

  // Ash creates the run through the UI.
  await ash.getByRole('button', { name: '+ New run' }).click();
  await ash.getByPlaceholder('Kanto with the boys').fill('E2E Link');
  await ash.locator('input[type=file]').setInputFiles(romPath);
  await ash.getByText(/Auto-tracking:/).waitFor({ timeout: 15000 });
  await ash.getByRole('button', { name: 'Create run' }).click();
  await ash.waitForURL(/\/run\//);
  const runId = ash.url().split('/run/')[1];
  console.log('run', runId);

  // Seed Ash's cloud save before the emulator boots, then reload so it's picked up.
  if (savePath) {
    const bytes = [...readFileSync(savePath)];
    const r = await ash.evaluate(async ({ runId, bytes }) => {
      const res = await fetch(`/api/runs/${runId}/saves`, { method: 'PUT', headers: { authorization: `Bearer ${localStorage.getItem('leelink.token')}` }, body: new Uint8Array(bytes) });
      return res.status;
    }, { runId, bytes });
    console.log('save upload', r);
    await ash.reload();
  }

  // Misty joins via the invite link and loads her ROM.
  const invite = await ash.evaluate(async (runId) => (await (await fetch(`/api/runs/${runId}`, { headers: { authorization: `Bearer ${localStorage.getItem('leelink.token')}` } })).json()).run.inviteCode, runId);
  await misty.goto(`${base}/join/${invite}`);
  await misty.getByRole('button', { name: 'Join the run' }).click();
  await misty.waitForURL(/\/run\//);
  await misty.locator('input[type=file]').setInputFiles(romPath);

  for (const p of [ash, misty]) {
    await p.getByText('Click to start').waitFor({ timeout: 20000 });
    await p.getByText('Click to start').click();
  }

  // Ash: title screen -> Continue (Enter = Start, X = A).
  await sleep(1500);
  const press = async (page, key, n = 1, gap = 400) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.down(key);
      await sleep(80);
      await page.keyboard.up(key);
      await sleep(gap);
    }
  };
  // Press Start/A until the tracker reports Ash on Route 1 (title -> Continue -> overworld).
  await ash.bringToFront();
  for (let i = 0; i < 40; i++) {
    if (await ash.getByText('Route 1', { exact: true }).count()) break;
    await press(ash, i % 3 === 0 ? 'Enter' : 'KeyX', 1, 1200);
  }
  await press(ash, 'KeyZ', 3, 400);
  await ash.screenshot({ path: join(outDir, 'ash-play.png') });

  // Ash's dashboard should show Charmander (decoded from memory) and Misty should see it too.
  await misty.getByRole('button', { name: 'Team', exact: true }).click();
  await sleep(2000);
  await misty.screenshot({ path: join(outDir, 'misty-team.png') });
  const seen = await misty.getByText(/CHARMANDER|Charmander/).count();
  console.log('misty sees charmander entries:', seen);

  // Walk into grass for a wild encounter on Ash's side (right then up/down).
  await ash.keyboard.down('ArrowRight');
  await sleep(600);
  await ash.keyboard.up('ArrowRight');
  await ash.getByRole('button', { name: 'Links', exact: true }).click();
  for (let i = 0; i < 80; i++) {
    await ash.keyboard.down(i % 2 ? 'ArrowUp' : 'ArrowDown');
    await sleep(280);
    await ash.keyboard.up(i % 2 ? 'ArrowUp' : 'ArrowDown');
    if (await ash.getByText(/in battle…/).count()) break;
  }
  await sleep(1500);
  console.log('ash in battle (pending encounter on link board):', await ash.getByText(/in battle…/).count());
  await ash.screenshot({ path: join(outDir, 'ash-encounter.png') });
  // Run away: battle menu RUN is bottom-right.
  await sleep(4000);
  await press(ash, 'ArrowDown', 1, 300);
  await press(ash, 'ArrowRight', 1, 300);
  await press(ash, 'KeyX', 1, 3000);
  await press(ash, 'KeyX', 2, 1500);
  await ash.getByRole('button', { name: 'Feed', exact: true }).click();
  await sleep(1500);
  await ash.screenshot({ path: join(outDir, 'ash-links.png') });

  // Mobile layout check.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(base);
  await phone.screenshot({ path: join(outDir, 'phone-landing.png') });
} finally {
  console.log('--- browser console errors/warnings ---');
  console.log(logs.slice(0, 40).join('\n') || '(none)');
  await browser.close();
  server.kill();
}
