import type { MemoryReader } from '../memory/reader';
import type { PartySlot } from '../model';
export type { PartySlot } from '../model';
import { decodeGen3Pokemon, GEN3_PARTY_MON_SIZE, VANILLA_GEN3_SPECIES, type Gen3SpeciesMap } from './pokemon';

export interface Gen3PartyAddresses {
  party: number;
  partyCount: number;
}


export function readGen3Party(mem: MemoryReader, addr: Gen3PartyAddresses, speciesMap: Gen3SpeciesMap = VANILLA_GEN3_SPECIES): PartySlot[] {
  const count = Math.min(mem.read8(addr.partyCount), 6);
  const bytes = mem.readBytes(addr.party, GEN3_PARTY_MON_SIZE * 6);
  const slots: PartySlot[] = [];
  for (let i = 0; i < count; i++) {
    const res = decodeGen3Pokemon(bytes.subarray(i * GEN3_PARTY_MON_SIZE, (i + 1) * GEN3_PARTY_MON_SIZE), speciesMap);
    slots.push(res.ok ? { slot: i, mon: res.mon } : { slot: i, error: res.reason });
  }
  return slots;
}
