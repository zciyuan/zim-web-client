// ZIM frame codec: [len 4B][ver 1B][op 2B][seq 4B][body].
//
// len excludes itself, integers are big endian, ver is 1 and body is the
// Envelope protobuf. Mirrors zimfw/contract/frame.go — if that file changes,
// this one changes with it.

import { decodeEnvelope, encodeEnvelope, type Envelope } from './messages';

export const VERSION = 1;
export const HEADER_SIZE = 11;
const MAX_BODY_SIZE = 64 * 1024;

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Packs one envelope (or a ready body) into a ZIM frame. */
export const encodeFrame = (frame: {
  opcode: number;
  seq: number;
  body?: Uint8Array;
}): Uint8Array => {
  const body = frame.body ?? encodeEnvelope({ opcode: frame.opcode, payload: new Uint8Array(0) });
  if (body.length > MAX_BODY_SIZE) throw new Error('frame body exceeds 64 KiB');

  const out = new Uint8Array(HEADER_SIZE + body.length);
  const dv = view(out);
  dv.setUint32(0, HEADER_SIZE - 4 + body.length);
  out[4] = VERSION;
  dv.setUint16(5, frame.opcode);
  dv.setUint32(7, frame.seq >>> 0);
  out.set(body, HEADER_SIZE);
  return out;
};

/** Convenience: envelope + frame in one call. */
export const encodeRequest = (opcode: number, seq: number, payload: Uint8Array): Uint8Array =>
  encodeFrame({ opcode, seq, body: encodeEnvelope({ opcode, payload }) });

export interface DecodedFrame {
  opcode: number;
  seq: number;
  envelope: Envelope;
}

export const decodeFrame = (bytes: Uint8Array): DecodedFrame => {
  if (bytes.length < HEADER_SIZE) throw new Error('frame shorter than header');
  const dv = view(bytes);
  const length = dv.getUint32(0);
  if (length !== bytes.length - 4) {
    throw new Error(`frame length mismatch: ${length} vs ${bytes.length - 4}`);
  }
  if (bytes[4] !== VERSION) throw new Error(`unsupported frame version ${bytes[4]}`);
  return {
    opcode: dv.getUint16(5),
    seq: dv.getUint32(7),
    envelope: decodeEnvelope(bytes.subarray(HEADER_SIZE)),
  };
};
