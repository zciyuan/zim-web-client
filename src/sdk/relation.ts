// Friend relation write codecs (op:1201/1202/1204/1208).
//
// Field numbers follow internal/protocol/relation/friend.proto byte for byte.

import { Writer, decodeFields } from './proto';

/** 1201 AddFriend { int64 friend_id=1; string why=2; } */
export const encodeAddFriendReq = (req: { friendId: string; why?: string }): Uint8Array =>
  new Writer().int64(1, Number(req.friendId)).string(2, req.why ?? '').finish();

/** 1202 AnswerFriend { int64 friend_id=1; bool accept=2; } */
export const encodeAnswerFriendReq = (req: { friendId: string; accept: boolean }): Uint8Array =>
  new Writer().int64(1, Number(req.friendId)).bool(2, req.accept).finish();

/** 1204 DeleteFriend { int64 friend_id=1; } */
export const encodeDeleteFriendReq = (req: { friendId: string }): Uint8Array =>
  new Writer().int64(1, Number(req.friendId)).finish();

/** 1208 AddBlack { int64 uid=1; bool remove=2; } */
export const encodeAddBlackReq = (req: { uid: string; remove?: boolean }): Uint8Array =>
  new Writer().int64(1, Number(req.uid)).bool(2, req.remove ?? false).finish();

/** Shared response { bool ok = 1; } */
export const decodeRelationOperationRes = (bytes: Uint8Array): { ok: boolean } => {
  let ok = false;
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) ok = reader.bool();
    else reader.skip(wire);
  });
  return { ok };
};
