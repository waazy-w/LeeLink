import { decodeGbString, encodeGbString } from '../gen1/charset';
import { GEN2_CHARSET } from './charset-table';

/** Decodes a Gen 2 (English) string, stopping at the 0x50 terminator. */
export const decodeGen2String = (bytes: Uint8Array) => decodeGbString(bytes, GEN2_CHARSET);
/** Encodes to the Gen 2 charset, terminated and padded with 0x50. Used by tests and fixture builders. */
export const encodeGen2String = (text: string, length: number) => encodeGbString(text, length, GEN2_CHARSET);
