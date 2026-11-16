// Group (and family) opcodes: 1301–1317.
//
// Field numbers follow internal/protocol/group/group_client.proto. group_id is a
// decimal string on the wire; user ids are int64 and are passed as strings so
// snowflake values keep full precision.

import { Writer, decodeFields } from './proto';

export const GROUP_OP = {
  CREATE: 1301,
  DISMISS: 1302,
  QUIT: 1303,
  INVITE: 1304,
  APPLY_JOIN: 1305,
  ANSWER_JOIN: 1306,
  KICK: 1307,
  TRANSFER: 1308,
  UPDATE_INFO: 1309,
  MEMBERS: 1310,
  SET_ADMIN: 1311,
  MUTE_MEMBER: 1312,
  MUTE_ALL: 1313,
  MY_GROUPS: 1314,
  SEARCH: 1315,
  NOTIFY: 1317,
} as const;

export interface GroupSummary {
  group_id: string;
  name: string;
  face_url: string;
  owner_id: string;
  group_type: number;
  member_count: number;
}

export interface GroupInfo {
  group_id: string;
  name: string;
  face_url: string;
  notification: string;
  need_verification: number;
  look_member_info: number;
  apply_member_friend: number;
}

export interface GroupMemberInfo {
  uid: string;
  role: number;
  mute_until: string;
  joined_at: string;
}

const decodeGroupSummary = (bytes: Uint8Array): GroupSummary => {
  const summary: GroupSummary = {
    group_id: '', name: '', face_url: '', owner_id: '', group_type: 0, member_count: 0,
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: summary.group_id = reader.string(); break;
      case 2: summary.name = reader.string(); break;
      case 3: summary.face_url = reader.string(); break;
      case 4: summary.owner_id = reader.int64(); break;
      case 5: summary.group_type = reader.int32(); break;
      case 6: summary.member_count = reader.int32(); break;
      default: reader.skip(wire);
    }
  });
  return summary;
};

/** 1301 CreateGroup */
export const encodeCreateGroupReq = (req: {
  name: string;
  faceUrl?: string;
  groupType?: number;
  memberIds?: string[];
  needVerification?: number;
}): Uint8Array => {
  const writer = new Writer()
    .string(1, req.name)
    .string(2, req.faceUrl ?? '')
    .int32(3, req.groupType ?? 1)
    .int32(5, req.needVerification ?? 0);
  for (const uid of req.memberIds ?? []) writer.int64(4, uid);
  return writer.finish();
};

export const decodeCreateGroupRes = (bytes: Uint8Array): GroupInfo & { member_count: number; max_member: number } => {
  const res = {
    group_id: '', name: '', face_url: '', owner_id: '', group_type: 0,
    max_member: 0, member_count: 0, notification: '', need_verification: 0,
    look_member_info: 0, apply_member_friend: 0,
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: res.group_id = reader.string(); break;
      case 2: res.name = reader.string(); break;
      case 3: res.face_url = reader.string(); break;
      case 4: res.owner_id = reader.int64(); break;
      case 5: res.group_type = reader.int32(); break;
      case 6: res.max_member = reader.int32(); break;
      case 7: res.member_count = reader.int32(); break;
      default: reader.skip(wire);
    }
  });
  return res;
};

/** 1302/1303/1304/1307/1308 all answer with GroupOperationRes { bool ok = 1; } */
export const decodeGroupOperationRes = (bytes: Uint8Array): { ok: boolean } => {
  let ok = false;
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) ok = reader.bool();
    else reader.skip(wire);
  });
  return { ok };
};

export const encodeGroupIdReq = (groupId: string): Uint8Array =>
  new Writer().string(1, groupId).finish();

export const encodeGroupUserReq = (groupId: string, userId: string): Uint8Array =>
  new Writer().string(1, groupId).int64(2, userId).finish();

/** 1304 InviteGroupMembers { string group_id=1; repeated int64 user_ids=2; } */
export const encodeInviteGroupMembersReq = (groupId: string, userIds: string[]): Uint8Array => {
  const writer = new Writer().string(1, groupId);
  for (const uid of userIds) writer.int64(2, uid);
  return writer.finish();
};

/** 1306 AnswerJoin { string group_id=1; int64 user_id=2; bool accept=3; } */
export const encodeAnswerJoinReq = (req: {
  groupId: string;
  userId: string;
  accept: boolean;
}): Uint8Array => new Writer().string(1, req.groupId).int64(2, req.userId).bool(3, req.accept).finish();

/** 1305 ApplyJoin { string group_id=1; string why=2; } */
export const encodeApplyJoinReq = (groupId: string, why: string): Uint8Array =>
  new Writer().string(1, groupId).string(2, why).finish();

/** 1309 UpdateGroup */
export const encodeUpdateGroupReq = (req: {
  groupId: string;
  name?: string;
  faceUrl?: string;
  notification?: string;
  needVerification?: number;
  lookMemberInfo?: number;
  applyMemberFriend?: number;
}): Uint8Array =>
  new Writer()
    .string(1, req.groupId)
    .string(2, req.name ?? '')
    .string(3, req.faceUrl ?? '')
    .string(4, req.notification ?? '')
    .int32(5, req.needVerification ?? 0)
    .int32(6, req.lookMemberInfo ?? 0)
    .int32(7, req.applyMemberFriend ?? 0)
    .finish();

export const decodeUpdateGroupRes = (bytes: Uint8Array): GroupInfo => {
  const res: GroupInfo = {
    group_id: '', name: '', face_url: '', notification: '',
    need_verification: 0, look_member_info: 0, apply_member_friend: 0,
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: res.group_id = reader.string(); break;
      case 2: res.name = reader.string(); break;
      case 3: res.face_url = reader.string(); break;
      case 4: res.notification = reader.string(); break;
      case 5: res.need_verification = reader.int32(); break;
      case 6: res.look_member_info = reader.int32(); break;
      case 7: res.apply_member_friend = reader.int32(); break;
      default: reader.skip(wire);
    }
  });
  return res;
};

/** 1310 GroupMembers { string group_id=1; int32 offset=2; int32 limit=3; } */
export const encodeGroupMembersReq = (req: { groupId: string; offset?: number; limit?: number }): Uint8Array =>
  new Writer()
    .string(1, req.groupId)
    .int32(2, req.offset ?? 0)
    .int32(3, req.limit ?? 200)
    .finish();

export const decodeGroupMembersRes = (bytes: Uint8Array): GroupMemberInfo[] => {
  const members: GroupMemberInfo[] = [];
  decodeFields(bytes, (reader, field, wire) => {
    if (field !== 1) {
      reader.skip(wire);
      return;
    }
    const member: GroupMemberInfo = { uid: '', role: 0, mute_until: '0', joined_at: '0' };
    decodeFields(reader.bytes(), (entry, entryField, entryWire) => {
      switch (entryField) {
        case 1: member.uid = entry.string(); break;
        case 2: member.role = entry.int32(); break;
        case 3: member.mute_until = entry.int64(); break;
        case 4: member.joined_at = entry.int64(); break;
        default: entry.skip(entryWire);
      }
    });
    members.push(member);
  });
  return members;
};

/** 1311 SetAdmin { string group_id=1; int64 user_id=2; bool admin=3; } */
export const encodeSetGroupAdminReq = (req: { groupId: string; userId: string; admin: boolean }): Uint8Array =>
  new Writer().string(1, req.groupId).int64(2, req.userId).bool(3, req.admin).finish();

/** 1312 MuteMember { string group_id=1; int64 user_id=2; int64 until=3; } */
export const encodeMuteMemberReq = (req: { groupId: string; userId: string; until: number }): Uint8Array =>
  new Writer().string(1, req.groupId).int64(2, req.userId).int64(3, req.until).finish();

/** 1313 MuteAll { string group_id=1; int64 until=2; } */
export const encodeMuteAllReq = (groupId: string, until: number): Uint8Array =>
  new Writer().string(1, groupId).int64(2, until).finish();

/** 1315 SearchGroup { string keyword=1; int32 limit=2; } */
export const encodeSearchGroupReq = (keyword: string, limit = 20): Uint8Array =>
  new Writer().string(1, keyword).int32(2, limit).finish();

export const decodeSearchGroupRes = (bytes: Uint8Array): GroupSummary[] => {
  const groups: GroupSummary[] = [];
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) groups.push(decodeGroupSummary(reader.bytes()));
    else reader.skip(wire);
  });
  return groups;
};

/** 1317 GroupNotify { string group_id=1; int32 recv_opt=2; } */
export const encodeGroupNotifyReq = (groupId: string, recvOpt: number): Uint8Array =>
  new Writer().string(1, groupId).int32(2, recvOpt).finish();

/** GroupEvent pushed on op:1904 (internal/protocol/group/group_event.proto). */
export interface GroupEvent {
  group_id: string;
  kind: number;
  actor_id: string;
  target_id: string;
  name: string;
  at: string;
}

export const GROUP_EVENT = {
  MEMBER_JOINED: 1,
  MEMBER_LEFT: 2,
  MEMBER_KICKED: 3,
  UPDATED: 4,
  OWNER_TRANSFERRED: 5,
  ADMIN_CHANGED: 6,
  DISMISSED: 7,
  MUTED: 8,
  APPLY: 9,
} as const;

export const decodeGroupEvent = (bytes: Uint8Array): GroupEvent => {
  const event: GroupEvent = { group_id: '0', kind: 0, actor_id: '0', target_id: '0', name: '', at: '0' };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) event.group_id = reader.int64();
    else if (field === 2) event.kind = reader.int32();
    else if (field === 3) event.actor_id = reader.int64();
    else if (field === 4) event.target_id = reader.int64();
    else if (field === 5) event.name = reader.string();
    else if (field === 6) event.at = reader.int64();
    else reader.skip(wire);
  });
  return event;
};