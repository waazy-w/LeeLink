// Generates a Gen 3 game profile JSON from a built pret decomp (pokefirered / pokeemerald).
// Everything comes from the decomp: symbol addresses (ELF), struct offsets (compiled from the
// headers), flags, location names, trainer names and gym leader levels.
//
// usage: node scripts/codegen/gen3-profile.mjs <decomp-dir> <game: firered|leafgreen|emerald> <out.json>
// requires: emsdk (emcc, llvm-nm) at ~/emsdk
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [dir, game, out] = process.argv.slice(2);
const isFrlg = game === 'firered' || game === 'leafgreen';
const elf = join(dir, `poke${game}.elf`);
const rom = readFileSync(join(dir, `poke${game}.gba`));
const EMSDK = process.env.EMSDK ?? `${process.env.HOME}/emsdk`;
const read = (p) => readFileSync(join(dir, p), 'utf8');
const sha1 = execFileSync('shasum', ['-a', '1', join(dir, `poke${game}.gba`)]).toString().split(' ')[0];

// ---- symbols
const syms = {};
for (const line of execFileSync(`${EMSDK}/upstream/bin/llvm-nm`, [elf], { maxBuffer: 1 << 28 }).toString().split('\n')) {
  const [addr, , name] = line.trim().split(/\s+/);
  if (name) syms[name] = parseInt(addr, 16);
}
const sym = (n) => {
  if (syms[n] === undefined) throw new Error(`missing symbol ${n}`);
  return syms[n];
};

// ---- struct offsets via the decomp headers compiled for a 32-bit target
const tmp = mkdtempSync(join(tmpdir(), 'll-offs-'));
writeFileSync(join(tmp, 'offs.c'), `
#include "global.h"
#include "main.h"
#include "pokemon_storage_system.h"
int printf(const char*, ...);
#define O(s,f) printf("\\"%s.%s\\": %u,\\n", #s, #f, (unsigned) __builtin_offsetof(struct s, f))
int main(void) {
  printf("{\\n");
  O(SaveBlock1,location); O(SaveBlock1,flags); O(SaveBlock1,vars); O(SaveBlock1,money);
  O(SaveBlock2,playerName); O(SaveBlock2,playerTrainerId); O(SaveBlock2,encryptionKey);
  O(Main,callback1); O(Main,callback2);
  O(MapHeader,regionMapSectionId);
  O(PokemonStorage,currentBox); O(PokemonStorage,boxes); O(PokemonStorage,boxNames);
  printf("\\"_\\": 0}\\n");
  return 0;
}`);
const defs = ['-DMODERN=1', '-DENGLISH=1', ...(isFrlg ? ['-DFIRERED=1'] : [])];
execFileSync(`${EMSDK}/upstream/emscripten/emcc`, ['-w', `-iquote${dir}/include`, `-iquote${dir}`, `-iquote${dir}/gflib`, ...defs, join(tmp, 'offs.c'), '-o', join(tmp, 'offs.js')], {
  env: { ...process.env, EMSDK_PYTHON: process.env.EMSDK_PYTHON ?? '/opt/homebrew/bin/python3.12' },
});
const offs = JSON.parse(execFileSync('node', [join(tmp, 'offs.js')]).toString());

// ---- gMain.inBattle bitfield position (bit order of the 0x439 byte in main.h)
const mainH = read('include/main.h');
const bitfields = [...mainH.matchAll(/\/\*0x439\*\/\s*u8\s+(\w+):1;/g)].map((m) => m[1]);
const inBattleBit = bitfields.indexOf('inBattle');
if (inBattleBit < 0) throw new Error('inBattle bitfield not found');

// ---- constants
const defines = (text) => {
  const out = {};
  for (const [, n, v] of text.matchAll(/#define\s+(\w+)\s+(0x[0-9A-Fa-f]+|\d+)\b/g)) out[n] = Number(v);
  return out;
};
const flagsH = read('include/constants/flags.h');
const sysBase = isFrlg ? 0x800 : 0x860;
const badgeBase = Number(flagsH.match(/#define FLAG_BADGE01_GET\s+\((?:SYS_FLAGS|SYSTEM_FLAGS) \+ (0x[0-9A-F]+)\)/i)[1]) + sysBase;
const badges = Array.from({ length: 8 }, (_, i) => badgeBase + i);

// ---- locations (map sections)
const titleCase = (s) =>
  s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bS\.s\./i, 'S.S.').replace(/\bMt\b/, 'Mt').replace(/'S\b/g, "'s");
const mapsecs = JSON.parse(read('src/data/region_map/region_map_sections.json')).map_sections;
const locations = {};
mapsecs.forEach((m, i) => {
  if (m.name) locations[i] = titleCase(m.name.replace(/\{[^}]*\}/g, ''));
});

// ---- trainers: names + party levels, gym leaders for level caps
const opp = defines(read('include/constants/opponents.h'));
const trainerClassConsts = defines(read('include/constants/trainers.h'));
const classNames = {};
for (const [, c, name] of read('src/data/text/trainer_class_names.h').matchAll(/\[(TRAINER_CLASS_\w+)\]\s*=\s*_\("([^"]*)"\)/g)) classNames[c] = name;
const partiesText = read('src/data/trainer_parties.h');
const partyLevels = {};
for (const [, name, body] of partiesText.matchAll(/(sParty_\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
  partyLevels[name] = [...body.matchAll(/\.lvl\s*=\s*(\d+)/g)].map((m) => +m[1]);
}
const trainers = {};
const leaders = [];
for (const [, id, body] of read('src/data/trainers.h').matchAll(/\[(TRAINER_\w+)\]\s*=\s*\{([\s\S]*?)\n    \},/g)) {
  const num = opp[id];
  if (num === undefined || num === 0) continue;
  const cls = body.match(/\.trainerClass\s*=\s*(TRAINER_CLASS_\w+)/)?.[1];
  const tname = body.match(/\.trainerName\s*=\s*_\("([^"]*)"\)/)?.[1] ?? '';
  const party = body.match(/\((sParty_\w+)\)/)?.[1];
  const levels = partyLevels[party] ?? [];
  const label = titleCase([classNames[cls] ?? '', tname].filter(Boolean).join(' ').replace(/\{[^}]*\}/g, '')).trim();
  trainers[num] = { name: label, maxLevel: Math.max(0, ...levels) };
  if (/LEADER/.test(cls ?? '') && !/AQUA|MAGMA/.test(cls)) leaders.push({ id, num, name: label, maxLevel: Math.max(0, ...levels) });
}

// Gym order -> level cap: first rematch-free entry per leader name, in badge order.
const GYM_ORDER = isFrlg
  ? ['BROCK', 'MISTY', 'LT_SURGE', 'ERIKA', 'KOGA', 'SABRINA', 'BLAINE', 'GIOVANNI']
  : ['ROXANNE_1', 'BRAWLY_1', 'WATTSON_1', 'FLANNERY_1', 'NORMAN_1', 'WINONA_1', 'TATE_AND_LIZA_1', 'JUAN_1'];
const levelCaps = GYM_ORDER.map((n, i) => {
  const l = leaders.find((x) => x.id === `TRAINER_LEADER_${n}`) ?? leaders.find((x) => x.id.includes(n));
  return { badge: i + 1, label: l?.name ?? n, level: l?.maxLevel ?? 0, trainerId: l?.num };
});

const header = { title: String.fromCharCode(...rom.subarray(0xa0, 0xac)).replace(/\0+$/, ''), code: String.fromCharCode(...rom.subarray(0xac, 0xb0)), rev: rom[0xbc] };
const names = { firered: 'Pokémon FireRed', leafgreen: 'Pokémon LeafGreen', emerald: 'Pokémon Emerald' };

const profile = {
  $schema: '../schema.json',
  id: `${game}-${header.code.toLowerCase()}-rev${header.rev}`,
  name: `${names[game]} (US${header.rev ? ` rev ${header.rev}` : ''})`,
  generation: 3,
  platform: 'gba',
  engine: 'gen3',
  match: { gameCodes: [header.code], revisions: [header.rev], sha1: [sha1] },
  addresses: {
    party: sym('gPlayerParty'),
    partyCount: sym('gPlayerPartyCount'),
    enemyParty: sym('gEnemyParty'),
    enemyPartyCount: sym('gEnemyPartyCount'),
    saveBlock1Ptr: sym('gSaveBlock1Ptr'),
    saveBlock2Ptr: sym('gSaveBlock2Ptr'),
    storagePtr: sym('gPokemonStoragePtr'),
    main: sym('gMain'),
    mapHeader: sym('gMapHeader'),
    battleTypeFlags: sym('gBattleTypeFlags'),
    battleOutcome: sym('gBattleOutcome'),
    trainerOpponentA: sym('gTrainerBattleOpponent_A'),
    battleMons: sym('gBattleMons'),
    battlerPartyIndexes: sym('gBattlerPartyIndexes'),
    battlersCount: sym('gBattlersCount'),
  },
  offsets: {
    sb1Location: offs['SaveBlock1.location'],
    sb1Flags: offs['SaveBlock1.flags'],
    sb1Vars: offs['SaveBlock1.vars'],
    sb1Money: offs['SaveBlock1.money'],
    sb2PlayerName: offs['SaveBlock2.playerName'],
    sb2TrainerId: offs['SaveBlock2.playerTrainerId'],
    sb2EncryptionKey: offs['SaveBlock2.encryptionKey'],
    mainCallback2: offs['Main.callback2'],
    mainInBattle: 0x439,
    mainInBattleMask: 1 << inBattleBit,
    mapHeaderMapsec: offs['MapHeader.regionMapSectionId'],
    storageCurrentBox: offs['PokemonStorage.currentBox'],
    storageBoxes: offs['PokemonStorage.boxes'],
    storageBoxCount: 14,
    storageBoxSize: 30,
  },
  code: {
    // Main loop callbacks: lets the reader tell title/menus apart from real gameplay.
    CB2_Overworld: sym('CB2_Overworld'),
    BattleMainCB2: sym('BattleMainCB2'),
  },
  flags: { badges, trainerFlagsStart: 0x500 },
  /** Encryption of money/items exists in FRLG/E; party data is unaffected. */
  locations,
  trainers,
  levelCaps,
};
writeFileSync(out, JSON.stringify(profile, null, 1) + '\n');
console.log(profile.id, 'locations', Object.keys(locations).length, 'trainers', Object.keys(trainers).length, 'caps', levelCaps.map((c) => `${c.label}:${c.level}`).join(', '));
