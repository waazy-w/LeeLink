// Generates Gen 1 / Gen 2 (GB/GBC) data from built pret decomps (pokered, pokeyellow, pokegold, pokecrystal).
// Everything comes from the decomp: WRAM/SRAM symbol addresses (.sym), struct sizes, map and landmark
// names, trainer classes / parties (names + levels) and gym leader levels.
//
// usage:
//   node scripts/codegen/gen12-profile.mjs profile <decomp-dir> <game: red|blue|yellow|gold|silver|crystal> <out.json>
//   node scripts/codegen/gen12-profile.mjs tables <pokered-dir> <pokecrystal-dir>
//     (writes packages/shared/src/gen1/{charset-table,species-index}.ts and gen2/charset-table.ts)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, ...args] = process.argv.slice(2);

// ---------------------------------------------------------------- helpers

/** `const_def` / `const` / `const_skip` enumeration, as rgbds evaluates it. */
function enumerate(text, { macro = 'const', start = 0 } = {}) {
  const out = {};
  let v = start;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/;.*/, '').trim();
    let m;
    if ((m = line.match(/^const_def(?:\s+(-?\w+))?/))) v = m[1] ? Number(m[1].replace('$', '0x')) : 0;
    else if (line.startsWith('const_skip')) v += Number(line.split(/\s+/)[1] ?? 1);
    else if ((m = line.match(new RegExp(`^${macro}\\s+(\\w+)`)))) out[m[1]] = v++;
  }
  return out;
}

/** Parses `charmap "X", $NN` lines (English section only: stops after the digits). */
function parseCharmap(text) {
  const table = Array(256).fill('');
  for (const [, ch, hex] of text.matchAll(/charmap\s+"((?:[^"\\]|\\.)*)",\s*\$([0-9a-fA-F]{2})/g)) {
    const code = parseInt(hex, 16);
    const printable = !ch.startsWith('<') || ['<PK>', '<MN>', '<PKMN>', '<PO>', '<KE>', '<POKE>', '<DOT>'].includes(ch);
    if (printable && !table[code]) {
      table[code] = { '<DOT>': '.', '<PK>': 'PK', '<MN>': 'MN', '<PKMN>': 'PKMN', '<PO>': 'PO', '<KE>': 'KE', '<POKE>': 'POKE', '#': 'POKé' }[ch] ?? ch;
    }
    if (code === 0xff && ch === '9') break; // Japanese charmaps follow
  }
  table[0x7f] = ' ';
  table[0x50] = ''; // terminator
  return table;
}

/** Display-cases a GB string or constant ("MT.MOON", "#MON TOWER", "NEW BARK<BSP>TOWN"). */
function pretty(s) {
  const t = s
    .replace(/<BSP>|<LF>|¯/g, ' ')
    .replace(/<PKMN>|#MON/g, 'POKéMON')
    .replace(/#/g, 'POKé')
    .replace(/<[^>]*>/g, '')
    .replace(/@.*$/, '')
    .trim();
  return t
    .split(/(\s+)/)
    .map((w) => {
      if (/^\s+$/.test(w)) return w;
      if (/^(B?\d+F|HQ|PC|TV|TM|II|S\.S\..*)$/.test(w)) return w.replace(/^S\.S\.(\w)(.*)$/, (_, a, b) => `S.S. ${a}${b.toLowerCase()}`);
      return w.toLowerCase().replace(/(^|[.\-'(])([a-zé])/g, (_, p, c) => p + c.toUpperCase()).replace(/'S\b/g, "'s");
    })
    .join('')
    .replace(/\bMt\.(?=\w)/g, 'Mt. ')
    .replace(/\bLt\.(?=\w)/g, 'Lt. ')
    .replace(/\bProf\.(?=\w)/g, 'Prof. ')
    .replace(/\bJr\.(?=\w)/g, 'Jr. ')
    .replace(/Pokémon/g, 'Pokémon')
    .replace(/\bDiglett'S\b/, "Diglett's")
    .replace(/(?<=\S) (Of|The|And) /g, (m) => m.toLowerCase());
}

const WORD_FIX = { MT: 'Mt.', SS: 'S.S.', CO: 'Co.', DEPT: 'Dept.', MR: 'Mr.', MRS: 'Mrs.', POKEMON: 'Pokémon', POKECENTER: 'Pokémon Center', MART: 'Poké Mart', HQ: 'HQ', PC: 'PC', TV: 'TV', SE: 'SE', NE: 'NE', NW: 'NW', SW: 'SW', DAYCARE: 'Day-Care', RADIO: 'Radio' };
const POSSESSIVE_NOUN = /^(HOUSE|LAB|ROOM|GARAGE|OFFICE|TRAINER|SPEECH|FAMILYS|LANDING|GYM)$/;
/** "MT_MOON_B1F" -> "Mt. Moon B1F", "REDS_HOUSE_1F" -> "Red's House 1F". */
function prettyConst(name) {
  const words = name.split('_');
  return words
    .map((w, i) => {
      if (WORD_FIX[w]) return WORD_FIX[w];
      if (/^B?\d+F$/.test(w) || /^\d+$/.test(w)) return w;
      let out = w.charAt(0) + w.slice(1).toLowerCase();
      const next = words[i + 1];
      if (next && POSSESSIVE_NOUN.test(next) && /[^S]S$/.test(w) && w.length > 3) out = out.slice(0, -1) + "'s";
      return out;
    })
    .join(' ')
    .replace(/(?<=\S) (Of|The|And) /g, (m) => m.toLowerCase());
}

const sha1 = (file) => execFileSync('shasum', ['-a', '1', file]).toString().split(' ')[0];

/** Same title rule as packages/shared/src/rom/identify.ts. */
function romHeader(rom) {
  const cgb = (rom[0x143] & 0x80) !== 0;
  const title = String.fromCharCode(...rom.subarray(0x134, 0x134 + (cgb ? 15 : 16))).replace(/\0.*$/s, '').trim();
  return { title, revision: rom[0x14c], cgb };
}

function loadSyms(file) {
  const syms = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{2}):([0-9a-f]{4}) (\S+)$/i);
    if (m && !(m[3] in syms)) syms[m[3]] = { bank: parseInt(m[1], 16), addr: parseInt(m[2], 16) };
  }
  return syms;
}

/**
 * Bus address used by the GB readers (same as gbBusAddress in packages/shared/src/gen1/gb.ts):
 * WRAM banks are linear from 0xC000 (bank n at 0xC000 + n*0x1000, so banks 0/1 keep their real
 * addresses); SRAM bank n is exposed at 0x20000 + n*0x2000.
 */
function busAddress({ bank, addr }) {
  if (addr >= 0xc000 && addr < 0xd000) return addr;
  if (addr >= 0xd000 && addr < 0xe000) return bank <= 1 ? addr : 0xc000 + bank * 0x1000 + (addr - 0xd000);
  if (addr >= 0xa000 && addr < 0xc000) return 0x20000 + bank * 0x2000 + (addr - 0xa000);
  if (addr >= 0xff80) return addr;
  throw new Error(`not a RAM symbol: ${bank}:${addr.toString(16)}`);
}

// ---------------------------------------------------------------- tables

if (mode === 'tables') {
  const [red, crystal] = args;
  const shared = new URL('../../packages/shared/src/', import.meta.url);
  const g1 = parseCharmap(readFileSync(join(red, 'constants/charmap.asm'), 'utf8'));
  const g2 = parseCharmap(readFileSync(join(crystal, 'constants/charmap.asm'), 'utf8'));
  writeFileSync(new URL('gen1/charset-table.ts', shared),
    `// GENERATED by scripts/codegen/gen12-profile.mjs from pret/pokered charmap.asm. Do not edit.\nexport const GEN1_CHARSET: readonly string[] = ${JSON.stringify(g1)};\n`);
  writeFileSync(new URL('gen2/charset-table.ts', shared),
    `// GENERATED by scripts/codegen/gen12-profile.mjs from pret/pokecrystal charmap.asm. Do not edit.\nexport const GEN2_CHARSET: readonly string[] = ${JSON.stringify(g2)};\n`);

  const internal = enumerate(readFileSync(join(red, 'constants/pokemon_constants.asm'), 'utf8'));
  const dex = enumerate(readFileSync(join(red, 'constants/pokedex_constants.asm'), 'utf8'));
  const max = Math.max(...Object.values(internal));
  const table = Array(256).fill(0);
  for (const [name, idx] of Object.entries(internal)) if (dex[`DEX_${name}`]) table[idx] = dex[`DEX_${name}`];
  writeFileSync(new URL('gen1/species-index.ts', shared),
    `// GENERATED by scripts/codegen/gen12-profile.mjs from pret/pokered. Do not edit.\n// Gen 1 internal species index -> national dex number (0 = MissingNo. / glitch).\nexport const GEN1_INTERNAL_TO_NATIONAL: readonly number[] = ${JSON.stringify(table)};\n`);
  console.log('gen1 species mapped', table.filter(Boolean).length, 'max', max, 'rhydon', table[internal.RHYDON], 'mew', table[internal.MEW]);
  process.exit(0);
}

// ---------------------------------------------------------------- profiles

if (mode !== 'profile') throw new Error('usage: gen12-profile.mjs profile|tables ...');
const [dir, game, out] = args;
const gen = ['red', 'blue', 'yellow'].includes(game) ? 1 : 2;
const read = (p) => readFileSync(join(dir, p), 'utf8');
const romPath = join(dir, `poke${game}.gbc`);
const rom = readFileSync(romPath);
const header = romHeader(rom);
const syms = loadSyms(join(dir, `poke${game}.sym`));
const sym = (n) => {
  if (!syms[n]) throw new Error(`missing symbol ${n}`);
  return busAddress(syms[n]);
};
const size = (a, b) => syms[b].addr - syms[a].addr;

// ---- trainers
function gen1Trainers() {
  const classes = enumerate(read('constants/trainer_constants.asm'), { macro: 'trainer_const' });
  const classNames = [...read('data/trainers/names.asm').matchAll(/li "([^"]*)"/g)].map((m) => m[1]);
  const species = enumerate(read('constants/pokemon_constants.asm'));
  const pointers = [...read('data/trainers/parties.asm').matchAll(/^\s*dw (\w+Data)\b/gm)].map((m) => m[1]);
  const text = read('data/trainers/parties.asm');
  const trainers = {};
  const byClass = {};
  pointers.forEach((label, i) => {
    const cls = i + 1;
    const body = text.split(new RegExp(`^${label}:`, 'm'))[1]?.split(/^\w+Data:/m)[0] ?? '';
    let comment = '';
    let n = 0;
    for (const raw of body.split('\n')) {
      const c = raw.match(/^\s*;\s*(.+?)\s*$/);
      if (c) { comment = c[1]; continue; }
      const m = raw.match(/^\s*db\s+(.*)$/);
      if (!m) continue;
      const vals = m[1].replace(/;.*/, '').split(',').map((s) => s.trim()).filter(Boolean);
      let levels = [];
      if (vals[0] === '$FF') {
        for (let k = 1; k + 1 < vals.length; k += 2) levels.push(Number(vals[k]));
      } else {
        const lvl = Number(vals[0]);
        levels = vals.slice(1).filter((v) => v !== '0' && species[v] !== undefined).map(() => lvl);
      }
      n++;
      const clsConst = Object.keys(classes).find((k) => classes[k] === cls) ?? '';
      const base = /^RIVAL\d$/.test(classNames[i]) ? 'Rival' : pretty(classNames[i] ?? clsConst);
      const name = comment && !/unused/i.test(comment) ? `${base} (${comment})` : base;
      const id = (cls << 8) | n;
      trainers[id] = { name, maxLevel: Math.max(0, ...levels) };
      (byClass[clsConst] ??= []).push({ id, name: base, maxLevel: trainers[id].maxLevel });
    }
  });
  const leader = (cls, n = 1) => byClass[cls][n - 1];
  const gyms = [leader('BROCK'), leader('MISTY'), leader('LT_SURGE'), leader('ERIKA'), leader('KOGA'), leader('SABRINA'), leader('BLAINE'), leader('GIOVANNI', 3)];
  const champion = byClass.RIVAL3.reduce((a, b) => (b.maxLevel > a.maxLevel ? b : a));
  const levelCaps = [...gyms, { ...champion, name: 'Champion (Rival)' }].map((l, i) => ({ badge: i + 1, label: l.name, level: l.maxLevel, trainerId: l.id }));
  return { trainers, levelCaps };
}

function gen2Trainers() {
  const consts = read('constants/trainer_constants.asm');
  const classIds = {};
  let cls = 0;
  for (const [, name] of consts.matchAll(/^\s*trainerclass (\w+)/gm)) classIds[name] = cls++;
  const classNames = [...read('data/trainers/class_names.asm').matchAll(/li "([^"]*)"/g)].map((m) => m[1]);
  const groups = [...read('data/trainers/party_pointers.asm').matchAll(/^\s*dw (\w+Group)\b/gm)].map((m) => m[1]);
  const text = read('data/trainers/parties.asm');
  const trainers = {};
  const byClass = {};
  const classConst = Object.fromEntries(Object.entries(classIds).map(([k, v]) => [v, k]));
  groups.forEach((label, i) => {
    const c = i + 1;
    const body = text.split(new RegExp(`^${label}:`, 'm'))[1]?.split(/^\w+Group:/m)[0] ?? '';
    let n = 0;
    for (const [, tname, mons] of body.matchAll(/db "([^"]*)@",\s*TRAINERTYPE_(?:\w+)\n([\s\S]*?)db -1/g)) {
      n++;
      const levels = [...mons.matchAll(/^\s*db\s+(\d+),/gm)].map((m) => +m[1]);
      const cn = pretty(classNames[c - 1] ?? '');
      const tn = tname === '?' ? '' : pretty(tname);
      const name = [cn, tn].filter(Boolean).join(' ');
      const id = (c << 8) | n;
      trainers[id] = { name, maxLevel: Math.max(0, ...levels) };
      (byClass[classConst[c]] ??= []).push({ id, name, maxLevel: trainers[id].maxLevel });
    }
  });
  const first = (k) => byClass[k][0];
  const johto = ['FALKNER', 'BUGSY', 'WHITNEY', 'MORTY', 'CHUCK', 'JASMINE', 'PRYCE', 'CLAIR'].map(first);
  const kanto = ['BROCK', 'MISTY', 'LT_SURGE', 'ERIKA', 'JANINE', 'SABRINA', 'BLAINE', 'BLUE'].map(first).sort((a, b) => a.maxLevel - b.maxLevel);
  const red = first('RED');
  const levelCaps = [...johto, ...kanto, red].map((l, i) => ({ badge: i + 1, label: l.name, level: l.maxLevel, trainerId: l.id }));
  return { trainers, levelCaps };
}

// ---- locations
function gen1Locations() {
  const consts = read('constants/map_constants.asm');
  const maps = [];
  const groupEnd = {};
  for (const raw of consts.split('\n')) {
    const line = raw.replace(/;.*/, '').trim();
    let m;
    if ((m = line.match(/^map_const\s+(\w+)/))) maps.push(m[1]);
    else if ((m = line.match(/^end_indoor_group\s+(\w+)/))) groupEnd[m[1]] = maps.length;
  }
  const firstIndoor = maps.indexOf('REDS_HOUSE_1F');
  const entries = read('data/maps/town_map_entries.asm');
  const nameText = read('data/maps/names.asm');
  const labelName = {};
  for (const [, label, s] of nameText.matchAll(/^(\w+):\s*db "([^"]*)"/gm)) labelName[label] = pretty(s);
  const external = [...entries.matchAll(/^\s*outdoor_map\s+\d+,\s*\d+,\s*(\w+)/gm)].map((m) => labelName[m[1]]);
  const internal = [...entries.matchAll(/^\s*indoor_map\s+(\w+),\s*\d+,\s*\d+,\s*(\w+)/gm)].map((m) => ({ end: groupEnd[m[1]], name: labelName[m[2]] }));
  const locations = {};
  const areas = {};
  maps.forEach((c, id) => {
    if (/^UNUSED_MAP/.test(c)) return;
    const area = id < firstIndoor ? external[id] : internal.find((e) => id < e.end)?.name;
    locations[id] = prettyConst(c);
    if (area) areas[id] = area;
  });
  return { locations, areas };
}

function gen2Locations() {
  // (group, num) -> constant name, from constants/map_constants.asm
  const consts = read('constants/map_constants.asm');
  const constAt = {};
  let group = 0, num = 0;
  for (const raw of consts.split('\n')) {
    const line = raw.replace(/;.*/, '').trim();
    let m;
    if (/^newgroup\b/.test(line)) { group++; num = 0; }
    else if ((m = line.match(/^map_const\s+(\w+)/))) constAt[(group << 8) | ++num] = m[1];
  }
  const landmarkIds = enumerate(read('constants/landmark_constants.asm'));
  const lmText = read('data/maps/landmarks.asm');
  const labelName = {};
  for (const [, label, s] of lmText.matchAll(/^(\w+):\s*db "([^"]*)"/gm)) labelName[label] = pretty(s);
  const landmarkLabels = [...lmText.matchAll(/^\s*landmark\s+-?\d+,\s*-?\d+,\s*(\w+)/gm)].map((m) => m[1]);
  const landmarkName = Object.fromEntries(Object.entries(landmarkIds).map(([k, v]) => [k, labelName[landmarkLabels[v]]]));
  const locations = {};
  const areas = {};
  // data/maps/maps.asm: MapGroupPointers order gives the group, line order within MapGroup_X the number.
  const mapsAsm = read('data/maps/maps.asm');
  const groupLabels = [...mapsAsm.matchAll(/^\s*dw (MapGroup_\w+)/gm)].map((m) => m[1]);
  groupLabels.forEach((label, gi) => {
    const body = mapsAsm.split(new RegExp(`^${label}:`, 'm'))[1].split(/^MapGroup_\w+:/m)[0];
    [...body.matchAll(/^\s*map\s+(\w+),\s*\w+,\s*\w+,\s*(\w+)/gm)].forEach(([, , landmark], ni) => {
      const id = ((gi + 1) << 8) | (ni + 1);
      if (!constAt[id]) throw new Error(`map ${gi + 1}:${ni + 1} has no constant`);
      locations[id] = prettyConst(constAt[id]);
      const area = landmarkName[landmark];
      if (area && area !== '?' && landmark !== 'LANDMARK_SPECIAL') areas[id] = area;
    });
  });
  return { locations, areas };
}

// ---- profile
const names = { red: 'Pokémon Red', blue: 'Pokémon Blue', yellow: 'Pokémon Yellow', gold: 'Pokémon Gold', silver: 'Pokémon Silver', crystal: 'Pokémon Crystal' };
const battleConsts = enumerate(read('constants/battle_constants.asm'));
let profile;
if (gen === 1) {
  const { trainers, levelCaps } = gen1Trainers();
  const { locations, areas } = gen1Locations();
  profile = {
    id: `${game}-us-rev${header.revision}`,
    name: `${names[game]} (US${header.revision ? ` rev ${header.revision}` : ''})`,
    generation: 1,
    platform: header.cgb ? 'gbc' : 'gb',
    engine: 'gen1',
    match: { titles: [header.title], revisions: [header.revision], sha1: [sha1(romPath)] },
    addresses: {
      playerName: sym('wPlayerName'),
      playerId: sym('wPlayerID'),
      partyCount: sym('wPartyCount'),
      partySpecies: sym('wPartySpecies'),
      partyMons: sym('wPartyMons'),
      partyOTs: sym('wPartyMonOT'),
      partyNicknames: sym('wPartyMonNicks'),
      boxCount: sym('wBoxCount'),
      boxSpecies: sym('wBoxSpecies'),
      boxMons: sym('wBoxMons'),
      boxOTs: sym('wBoxMonOT'),
      boxNicknames: sym('wBoxMonNicks'),
      currentBox: sym('wCurrentBoxNum'),
      badges: sym('wObtainedBadges'),
      curMap: sym('wCurMap'),
      statusFlags6: sym('wStatusFlags6'),
      linkState: sym('wLinkState'),
      isInBattle: sym('wIsInBattle'),
      battleType: sym('wBattleType'),
      battleResult: sym('wBattleResult'),
      curOpponent: sym('wCurOpponent'),
      enemyMonSpecies2: sym('wEnemyMonSpecies2'),
      curEnemyLevel: sym('wCurEnemyLevel'),
      trainerClass: sym('wTrainerClass'),
      trainerNo: sym('wTrainerNo'),
      capturedMonSpecies: sym('wCapturedMonSpecies'),
      enemyPartyCount: sym('wEnemyPartyCount'),
      enemyPartySpecies: sym('wEnemyPartySpecies'),
      enemyMons: sym('wEnemyMons'),
      enemyPartyOTs: sym('wEnemyMonOT'),
      enemyPartyNicknames: sym('wEnemyMonNicks'),
      enemyMon: sym('wEnemyMon'),
      enemyMonPartyPos: sym('wEnemyMonPartyPos'),
      playerMonNumber: sym('wPlayerMonNumber'),
    },
    offsets: {
      partyMonSize: size('wPartyMon1', 'wPartyMon2'),
      boxMonSize: size('wBoxMon1', 'wBoxMon2'),
      battleMonSize: size('wEnemyMon', 'wEnemyMonPP') + 4,
      nameLength: size('wPartyMonNicks', 'wPartyMonNicksEnd') / 6,
      boxCapacity: 20,
      gameTimerBit: 0,
      battleTypeOldMan: battleConsts.BATTLE_TYPE_OLD_MAN,
    },
    flags: {},
    locations,
    areas,
    trainers,
    levelCaps,
  };
} else {
  const { trainers, levelCaps } = gen2Trainers();
  const { locations, areas } = gen2Locations();
  const sha = [sha1(romPath)];
  // Crystal 1.1 has an identical RAM layout (ram/wram.asm keeps the same padding under _CRYSTAL11).
  if (game === 'crystal') sha.push(read('roms.sha1').match(/^([0-9a-f]{40}) \*pokecrystal11\.gbc$/m)[1]);
  profile = {
    id: `${game}-us-rev${header.revision}`,
    name: `${names[game]} (US${header.revision ? ` rev ${header.revision}` : ''})`,
    generation: 2,
    platform: 'gbc',
    engine: 'gen2',
    match: { titles: [header.title], revisions: game === 'crystal' ? [0, 1] : [header.revision], sha1: sha },
    addresses: {
      playerName: sym('wPlayerName'),
      playerId: sym('wPlayerID'),
      partyCount: sym('wPartyCount'),
      partySpecies: sym('wPartySpecies'),
      partyMons: sym('wPartyMons'),
      partyOTs: sym('wPartyMonOTs'),
      partyNicknames: sym('wPartyMonNicknames'),
      boxCount: sym('sBoxCount'),
      boxSpecies: sym('sBoxSpecies'),
      boxMons: sym('sBoxMons'),
      boxOTs: sym('sBoxMonOTs'),
      boxNicknames: sym('sBoxMonNicknames'),
      currentBox: sym('wCurBox'),
      johtoBadges: sym('wJohtoBadges'),
      kantoBadges: sym('wKantoBadges'),
      mapGroup: sym('wMapGroup'),
      mapNumber: sym('wMapNumber'),
      gameTimerPaused: sym('wGameTimerPaused'),
      linkMode: sym('wLinkMode'),
      battleMode: sym('wBattleMode'),
      battleType: sym('wBattleType'),
      battleResult: sym('wBattleResult'),
      otherTrainerClass: sym('wOtherTrainerClass'),
      otherTrainerId: sym('wOtherTrainerID'),
      tempWildMonSpecies: sym('wTempWildMonSpecies'),
      wildMon: sym('wWildMon'),
      otPartyCount: sym('wOTPartyCount'),
      otPartySpecies: sym('wOTPartySpecies'),
      otPartyMons: sym('wOTPartyMons'),
      otPartyOTs: sym('wOTPartyMonOTs'),
      otPartyNicknames: sym('wOTPartyMonNicknames'),
      enemyMon: sym('wEnemyMon'),
      curOTMon: sym('wCurOTMon'),
      curBattleMon: sym('wCurBattleMon'),
    },
    offsets: {
      partyMonSize: size('wPartyMon1', 'wPartyMon2'),
      boxMonSize: size('sBoxMon1', 'sBoxMon2'),
      battleMonSize: size('wEnemyMon', 'wEnemyMonBaseStats'),
      nameLength: size('wPartyMonNicknames', 'wPartyMonNicknamesEnd') / 6,
      boxCapacity: 20,
      gameTimerBit: 0,
      hasCaughtData: game === 'crystal' ? 1 : 0,
      battleTypeDebug: battleConsts.BATTLETYPE_DEBUG,
      battleTypeTutorial: battleConsts.BATTLETYPE_TUTORIAL,
    },
    flags: {},
    locations,
    areas,
    trainers,
    levelCaps,
  };
}
writeFileSync(out, JSON.stringify(profile, null, 1) + '\n');
console.log(profile.id, header.title, 'locations', Object.keys(profile.locations).length, 'trainers', Object.keys(profile.trainers).length,
  'caps', profile.levelCaps.map((c) => `${c.label}:${c.level}`).join(', '));
