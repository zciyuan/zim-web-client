// RTC signaling codecs (op:1801-1807).
//
// Field numbers follow internal/protocol/rtc/rtc_client.proto byte for byte.

import { Writer, decodeFields } from './proto';

export interface CallInviteResult {
  call_id: string;
  room: string;
  expire_at: string;
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
  /** 1 user / 2 group */
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
  const result: CallInviteResult = { call_id: '', room: '', expire_at: '0' };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) result.call_id = reader.string();
    else if (field === 2) result.room = reader.string();
    else if (field === 3) result.expire_at = reader.int64();
    else reader.skip(wire);
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

/** 1804 CallCancelReq { call_id=1; reason=2; } */
export const encodeCallCancelReq = (req: { callId: string; reason: number }): Uint8Array =>
  new Writer().string(1, req.callId).int32(2, req.reason).finish();

/** 1806 RoomTokenReq { call_id=1; } -> RoomTokenRes { call_id=1; room=2; token=3; sfu_url=4; expire_at=5; } */
export const encodeRoomTokenReq = (req: { callId: string }): Uint8Array =>
  new Writer().string(1, req.callId).finish();

export interface RoomTokenResult {
  call_id: string;
  room: string;
  token: string;
  sfu_url: string;
  expire_at: string;
}

export const decodeRoomTokenRes = (bytes: Uint8Array): RoomTokenResult => {
  const result: RoomTokenResult = { call_id: '', room: '', token: '', sfu_url: '', expire_at: '0' };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) result.call_id = reader.string();
    else if (field === 2) result.room = reader.string();
    else if (field === 3) result.token = reader.string();
    else if (field === 4) result.sfu_url = reader.string();
    else if (field === 5) result.expire_at = reader.int64();
    else reader.skip(wire);
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
