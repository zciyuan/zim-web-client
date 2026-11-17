// RTC signaling codecs (op:1801-1807).
//
// Field numbers follow internal/protocol/rtc/rtc_client.proto byte for byte.
// Normal group calls (target_type=2) are persistent rooms: 1801 returns a join
// token directly, state comes from 1805, joining uses 1806 and leaving 1803.

import { Reader, Writer, decodeFields } from './proto';

/** Reads a `repeated int64` that protobuf may encode packed or unpacked. */
const readInt64List = (reader: Reader, wire: number): string[] => {
  if (wire === 0) return [reader.int64()];
  const packed = new Reader(reader.bytes());
  const out: string[] = [];
  while (!packed.done) out.push(packed.int64());
  return out;
};

export interface CallInviteResult {
  call_id: string;
  room: string;
  expire_at: string;
  /** Group rooms only: the initiator joins the SFU immediately. */
  token: string;
  sfu_url: string;
  media: number;
  target_type: number;
  participants: string[];
}

export interface CallAnswerPush {
  call_id: string;
  phase: number; // 1 ringing / 2 answered / 3 busy
  from_uid: string;
  from_nickname: string;
  from_avatar: string;
  media: number;
  room: string;
  token: string;
  sfu_url: string;
  target_type: number;
}

/** 1801 CallInviteReq { call_id=1; CallTarget target=2; media=3; extra=4; } */
export const encodeCallInviteReq = (req: {
  callId: string;
  /** 1 user / 2 group / 3 family */
  targetType: number;
  targetId: string;
  media: number;
  extra?: string;
}): Uint8Array => {
  const target = new Writer().int32(1, req.targetType).int64(2, Number(req.targetId)).finish();
  return new Writer()
    .string(1, req.callId)
    .bytes(2, target)
    .int32(3, req.media)
    .string(4, req.extra ?? '')
    .finish();
};

export const decodeCallInviteRes = (bytes: Uint8Array): CallInviteResult => {
  const result: CallInviteResult = {
    call_id: '', room: '', expire_at: '0', token: '', sfu_url: '', media: 1,
    target_type: 1, participants: [],
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: result.call_id = reader.string(); break;
      case 2: result.room = reader.string(); break;
      case 3: result.expire_at = reader.int64(); break;
      case 4: result.token = reader.string(); break;
      case 5: result.sfu_url = reader.string(); break;
      case 6: result.media = reader.int32(); break;
      case 7: result.target_type = reader.int32(); break;
      case 8: result.participants.push(...readInt64List(reader, wire)); break;
      default: reader.skip(wire);
    }
  });
  return result;
};

/** 1802 CallAnswerReq { call_id=1; accept=2; } */
export const encodeCallAnswerReq = (req: { callId: string; accept: boolean }): Uint8Array =>
  new Writer().string(1, req.callId).bool(2, req.accept).finish();

/** Decodes both the 1802 response and the server's ringing/answered pushes. */
export const decodeCallAnswer = (bytes: Uint8Array): CallAnswerPush => {
  const result: CallAnswerPush = {
    call_id: '', phase: 0, from_uid: '0', from_nickname: '', from_avatar: '',
    media: 1, room: '', token: '', sfu_url: '', target_type: 1,
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: result.call_id = reader.string(); break;
      case 2: result.phase = reader.int32(); break;
      case 3: result.from_uid = reader.int64(); break;
      case 4: result.from_nickname = reader.string(); break;
      case 5: result.from_avatar = reader.string(); break;
      case 6: result.media = reader.int32(); break;
      case 7: result.room = reader.string(); break;
      case 8: result.token = reader.string(); break;
      case 9: result.sfu_url = reader.string(); break;
      case 10: result.target_type = reader.int32(); break;
      default: reader.skip(wire);
    }
  });
  return result;
};

/** 1803 CallHangupReq { call_id=1; reason=2; duration=3; } */
export const encodeCallHangupReq = (req: { callId: string; reason: number; duration: number }): Uint8Array =>
  new Writer().string(1, req.callId).int32(2, req.reason).int64(3, req.duration).finish();

export interface CallHangupResult {
  call_id: string;
  /** Group rooms: true when this was the last participant and the room ended. */
  ended: boolean;
}

/** 1803 CallHangupRes { call_id=1; ended=2; } */
export const decodeCallHangupRes = (bytes: Uint8Array): CallHangupResult => {
  const result: CallHangupResult = { call_id: '', ended: false };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) result.call_id = reader.string();
    else if (field === 2) result.ended = reader.bool();
    else reader.skip(wire);
  });
  return result;
};

/** 1804 CallCancelReq { call_id=1; reason=2; } */
export const encodeCallCancelReq = (req: { callId: string; reason: number }): Uint8Array =>
  new Writer().string(1, req.callId).int32(2, req.reason).finish();

export interface CallStateResult {
  call_id: string;
  /** 1 idle / 2 ongoing (server side enum) */
  state: number;
  group_id: string;
  active: boolean;
  media: number;
  room: string;
  target_type: number;
  participants: string[];
  started_at: string;
  expire_at: string;
}

/** 1805 CallStateReq { call_id=1; state=2; group_id=3; } (query or push). */
export const encodeCallStateReq = (req: { callId?: string; state?: number; groupId?: string }): Uint8Array =>
  new Writer()
    .string(1, req.callId ?? '')
    .int32(2, req.state ?? 0)
    .int64(3, req.groupId ? Number(req.groupId) : 0)
    .finish();

export const decodeCallStateRes = (bytes: Uint8Array): CallStateResult => {
  const result: CallStateResult = {
    call_id: '', state: 0, group_id: '0', active: false, media: 1, room: '',
    target_type: 2, participants: [], started_at: '0', expire_at: '0',
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: result.call_id = reader.string(); break;
      case 2: result.state = reader.int32(); break;
      case 3: result.group_id = reader.int64(); break;
      case 4: result.active = reader.bool(); break;
      case 5: result.media = reader.int32(); break;
      case 6: result.room = reader.string(); break;
      case 7: result.target_type = reader.int32(); break;
      case 8: result.participants.push(...readInt64List(reader, wire)); break;
      case 9: result.started_at = reader.int64(); break;
      case 10: result.expire_at = reader.int64(); break;
      default: reader.skip(wire);
    }
  });
  return result;
};

/** 1806 RoomTokenReq { call_id=1; group_id=2; } */
export const encodeRoomTokenReq = (req: { callId?: string; groupId?: string }): Uint8Array =>
  new Writer()
    .string(1, req.callId ?? '')
    .int64(2, req.groupId ? Number(req.groupId) : 0)
    .finish();

export interface RoomTokenResult {
  call_id: string;
  room: string;
  token: string;
  sfu_url: string;
  expire_at: string;
  media: number;
  participants: string[];
  target_type: number;
}

/** 1806 RoomTokenRes { call_id=1; room=2; token=3; sfu_url=4; expire_at=5; media=6; participants=7; target_type=8; } */
export const decodeRoomTokenRes = (bytes: Uint8Array): RoomTokenResult => {
  const result: RoomTokenResult = {
    call_id: '', room: '', token: '', sfu_url: '', expire_at: '0', media: 1,
    participants: [], target_type: 1,
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: result.call_id = reader.string(); break;
      case 2: result.room = reader.string(); break;
      case 3: result.token = reader.string(); break;
      case 4: result.sfu_url = reader.string(); break;
      case 5: result.expire_at = reader.int64(); break;
      case 6: result.media = reader.int32(); break;
      case 7: result.participants.push(...readInt64List(reader, wire)); break;
      case 8: result.target_type = reader.int32(); break;
      default: reader.skip(wire);
    }
  });
  return result;
};

/** 1807 ParticipantStateReq { call_id=1; uid=2; muted=3; video_on=4; network=5; } */
export const encodeParticipantStateReq = (req: {
  callId: string;
  uid: string;
  muted: boolean;
  videoOn: boolean;
  network?: number;
}): Uint8Array =>
  new Writer()
    .string(1, req.callId)
    .int64(2, Number(req.uid))
    .bool(3, req.muted)
    .bool(4, req.videoOn)
    .int32(5, req.network ?? 0)
    .finish();
