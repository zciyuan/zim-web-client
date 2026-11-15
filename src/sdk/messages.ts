// Message codecs for the opcodes the client speaks.
//
// Field numbers follow internal/protocol/*.proto byte for byte. Adding a field
// means appending a number here, never reusing one (ZIM-02 §2.4).

import { Writer, decodeFields } from './proto';
import type {
  LoginRes,
  MessageItem,
  OnlineDevice,
  Reaction,
  PullBySeqRes,
  SendRes,
  SyncState,
} from './types';

export const OP = {
  LOGIN: 1001,
  LOGOUT: 1002,
  MY_GROUPS: 1314,
  SEND_SINGLE: 1501,
  SEND_GROUP: 1502,
  QUOTE: 1504,
  READ_RECEIPT: 1505,
  RECALL: 1506,
  ADD_REACTION: 1515,
  REMOVE_REACTION: 1516,
  EDIT: 1507,
  DELETE: 1508,
  PULL_BY_SEQ: 1511,
  SEARCH: 1512,
  SYNC_MISSING: 1514,
  SYNC_CHECK: 1601,
  CALL_INVITE: 1801,
  CALL_ANSWER: 1802,
  CALL_HANGUP: 1803,
  CALL_CANCEL: 1804,
  CALL_STATE: 1807,
  ROOM_TOKEN: 1806,
  PUSH_MSG: 1901,
  PUSH_KICK: 1902,
} as const;

export type Opcode = (typeof OP)[keyof typeof OP];

export interface Envelope {
  opcode: number;
  payload: Uint8Array;
  code: number;
  message: string;
}

/** Envelope { int32 opcode = 1; bytes payload = 2; int32 code = 3; string message = 4; } */
export const encodeEnvelope = (envelope: {
  opcode: number;
  payload?: Uint8Array;
  code?: number;
  message?: string;
}): Uint8Array => {
  const writer = new Writer()
    .int32(1, envelope.opcode)
    .int32(3, envelope.code ?? 0)
    .string(4, envelope.message ?? '');
  if (envelope.payload && envelope.payload.length > 0) writer.bytes(2, envelope.payload);
  return writer.finish();
};

export const decodeEnvelope = (bytes: Uint8Array): Envelope => {
  const envelope: Envelope = { opcode: 0, payload: new Uint8Array(0), code: 0, message: '' };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1:
        envelope.opcode = reader.int32();
        break;
      case 2:
        envelope.payload = reader.bytes();
        break;
      case 3:
        envelope.code = reader.int32();
        break;
      case 4:
        envelope.message = reader.string();
        break;
      default:
        reader.skip(wire);
    }
  });
  return envelope;
};

// ------------------------------------------------------------------ login ---

export const encodeLoginReq = (req: {
  token: string;
  platform: number;
  sdk: string;
  deviceId: string;
  deviceName: string;
}): Uint8Array =>
  new Writer()
    .string(1, req.token)
    .int32(2, req.platform)
    .string(3, req.sdk)
    .string(4, req.deviceId)
    .string(5, req.deviceName)
    .finish();

const decodeSyncState = (bytes: Uint8Array): SyncState => {
  const sync: SyncState = { conversation_version: '0', friend_version: '0', max_seqs: {} };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) {
      sync.conversation_version = reader.int64();
    } else if (field === 2) {
      sync.friend_version = reader.int64();
    } else if (field === 3) {
      let key = '';
      let value = '0';
      decodeFields(reader.bytes(), (entry, entryField, entryWire) => {
        if (entryField === 1) key = entry.string();
        else if (entryField === 2) value = entry.int64();
        else entry.skip(entryWire);
      });
      sync.max_seqs[key] = value;
    } else {
      reader.skip(wire);
    }
  });
  return sync;
};

const decodeOnlineDevice = (bytes: Uint8Array): OnlineDevice => {
  const device: OnlineDevice = { platform: 0, device_name: '' };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) device.platform = reader.int32();
    else if (field === 2) device.device_name = reader.string();
    else reader.skip(wire);
  });
  return device;
};

export const decodeLoginRes = (bytes: Uint8Array): LoginRes => {
  const res: LoginRes = {
    uid: '', nickname: '', avatar: '', server_time: '0', sync: null, online_devices: [],
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1:
        res.uid = reader.string();
        break;
      case 2:
        res.nickname = reader.string();
        break;
      case 3:
        res.avatar = reader.string();
        break;
      case 4:
        res.server_time = reader.int64();
        break;
      case 5:
        res.sync = decodeSyncState(reader.bytes());
        break;
      case 6:
        res.online_devices.push(decodeOnlineDevice(reader.bytes()));
        break;
      default:
        reader.skip(wire);
    }
  });
  return res;
};

// --------------------------------------------------------------- messages ---

/** Reaction { string emoji=1; int32 count=2; bool mine=3; } */
export const decodeReaction = (bytes: Uint8Array): Reaction => {
  const item: Reaction = { emoji: '', count: 0, mine: false };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) item.emoji = reader.string();
    else if (field === 2) item.count = reader.int32();
    else if (field === 3) item.mine = reader.bool();
    else reader.skip(wire);
  });
  return item;
};

export const decodeMessageItem = (bytes: Uint8Array): MessageItem => {  const item: MessageItem = {
    server_msg_id: '', client_msg_id: '', conversation_id: '', seq: '0',
    send_id: '0', recv_id: '0', group_id: '0', msg_type: 1, content: '',
    at_user_ids: [], send_time: '0', status: 0,
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: item.server_msg_id = reader.string(); break;
      case 2: item.client_msg_id = reader.string(); break;
      case 3: item.conversation_id = reader.string(); break;
      case 4: item.seq = reader.int64(); break;
      case 5: item.send_id = reader.int64(); break;
      case 6: item.recv_id = reader.int64(); break;
      case 7: item.group_id = reader.int64(); break;
      case 8: item.msg_type = reader.int32(); break;
      case 9: item.content = reader.string(); break;
      case 10: item.at_user_ids.push(reader.string()); break;
      case 11: item.send_time = reader.int64(); break;
      case 12: item.status = reader.int32(); break;
      case 13: (item.reactions ??= []).push(decodeReaction(reader.bytes())); break;
      default: reader.skip(wire);
    }
  });
  return item;
};

/** SendSingleReq { string client_msg_id=1; int64 recv_id=2; int32 msg_type=3;
 *  string content=4; bool no_offline=5; bool no_notification=6; bool read_receipt=7; } */
export const encodeSendSingleReq = (req: {
  clientMsgId: string;
  recvId: string;
  msgType: number;
  content: string;
  readReceipt?: boolean;
}): Uint8Array =>
  new Writer()
    .string(1, req.clientMsgId)
    .int64(2, req.recvId)
    .int32(3, req.msgType)
    .string(4, req.content)
    .bool(7, req.readReceipt ?? true)
    .finish();

/** SendGroupReq { ... repeated string at_user_ids=5; bool no_offline=6; bool no_notification=7; } */
export const encodeSendGroupReq = (req: {
  clientMsgId: string;
  groupId: string;
  msgType: number;
  content: string;
  atUserIds?: string[];
}): Uint8Array => {
  const writer = new Writer()
    .string(1, req.clientMsgId)
    .int64(2, req.groupId)
    .int32(3, req.msgType)
    .string(4, req.content);
  for (const uid of req.atUserIds ?? []) writer.string(5, uid);
  return writer.finish();
};

export const decodeSendRes = (bytes: Uint8Array): SendRes => {
  const res: SendRes = { server_msg_id: '', seq: '0', send_time: '0', unread_count: '0' };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: res.server_msg_id = reader.string(); break;
      case 2: res.seq = reader.int64(); break;
      case 3: res.send_time = reader.int64(); break;
      case 4: res.unread_count = reader.int64(); break;
      default: reader.skip(wire);
    }
  });
  return res;
};

/** PullBySeqReq { string conversation_id=1; int64 begin_seq=2; int64 end_seq=3; int32 limit=4; } */
export const encodePullBySeqReq = (req: {
  conversationId: string;
  beginSeq: number;
  endSeq: number;
  limit: number;
}): Uint8Array =>
  new Writer()
    .string(1, req.conversationId)
    .int64(2, req.beginSeq)
    .int64(3, req.endSeq)
    .int32(4, req.limit)
    .finish();

export const decodePullBySeqRes = (bytes: Uint8Array): PullBySeqRes => {
  const res: PullBySeqRes = { messages: [], has_more: false };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) res.messages.push(decodeMessageItem(reader.bytes()));
    else if (field === 2) res.has_more = reader.bool();
    else reader.skip(wire);
  });
  return res;
};

export const encodeReadReceiptReq = (req: { conversationId: string; seq: number }): Uint8Array =>
  new Writer().string(1, req.conversationId).int64(2, req.seq).finish();

export const decodeReadReceiptRes = (bytes: Uint8Array): { read_seq: string } => {
  let readSeq = '0';
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) readSeq = reader.int64();
    else reader.skip(wire);
  });
  return { read_seq: readSeq };
};

/** 1504 QuoteMessage { client_msg_id=1; recv_id=2; group_id=3; server_msg_id=4; content=5; } */
export const encodeQuoteReq = (req: {
  clientMsgId: string;
  recvId?: string;
  groupId?: string;
  serverMsgId: string;
  content: string;
}): Uint8Array => {
  const writer = new Writer().string(1, req.clientMsgId);
  if (req.recvId) writer.int64(2, Number(req.recvId));
  if (req.groupId) writer.int64(3, Number(req.groupId));
  return writer.string(4, req.serverMsgId).string(5, req.content).finish();
};

export const decodeQuoteRes = (bytes: Uint8Array): SendRes => {
  const result: SendRes = { server_msg_id: '', seq: '0', send_time: '0', unread_count: '0' };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) result.server_msg_id = reader.string();
    else if (field === 2) result.seq = reader.int64();
    else if (field === 3) result.send_time = reader.int64();
    else reader.skip(wire);
  });
  return result;
};

/** 1506 Recall { string conversation_id=1; string server_msg_id=2; } */
export const encodeRecallReq = (req: { conversationId: string; serverMsgId: string }): Uint8Array =>
  new Writer().string(1, req.conversationId).string(2, req.serverMsgId).finish();

/** 1507 EditMessage { conversation_id=1; server_msg_id=2; content=3; } */
export const encodeEditMessageReq = (req: {
  conversationId: string;
  serverMsgId: string;
  content: string;
}): Uint8Array =>
  new Writer()
    .string(1, req.conversationId)
    .string(2, req.serverMsgId)
    .string(3, req.content)
    .finish();

/** 1508 DeleteMessage { conversation_id=1; server_msg_id=2; } */
export const encodeDeleteMessageReq = (req: { conversationId: string; serverMsgId: string }): Uint8Array =>
  new Writer().string(1, req.conversationId).string(2, req.serverMsgId).finish();

/** 1512 SearchMessage { conversation_id=1; keyword=2; limit=3; } */
export const encodeSearchMessageReq = (req: {
  conversationId: string;
  keyword: string;
  limit?: number;
}): Uint8Array =>
  new Writer()
    .string(1, req.conversationId)
    .string(2, req.keyword)
    .int32(3, req.limit ?? 30)
    .finish();

/** 1515 AddReaction / 1516 RemoveReaction
 *  { conversation_id=1; server_msg_id=2; emoji=3; } */
export const encodeReactionReq = (req: {
  conversationId: string;
  serverMsgId: string;
  emoji: string;
}): Uint8Array =>
  new Writer()
    .string(1, req.conversationId)
    .string(2, req.serverMsgId)
    .string(3, req.emoji)
    .finish();

export const decodeSearchMessageRes = (bytes: Uint8Array): MessageItem[] => {
  const items: MessageItem[] = [];
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) items.push(decodeMessageItem(reader.bytes()));
    else reader.skip(wire);
  });
  return items;
};

/** 1314 MyGroups: empty request, `repeated string group_ids` response.
 *
 * The REST group list returns int64 as a JSON number, which loses precision in
 * JS for snowflake ids. The wire protocol carries them as strings, so exact ids
 * are read here and joined to the REST row by its rounded value. */
export const encodeMyGroupsReq = (): Uint8Array => new Uint8Array(0);

export const decodeMyGroupsRes = (bytes: Uint8Array): { group_ids: string[] } => {
  const res: { group_ids: string[] } = { group_ids: [] };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) res.group_ids.push(reader.string());
    else reader.skip(wire);
  });
  return res;
};

export const decodeOperationRes = (bytes: Uint8Array): { ok: boolean } => {
  let ok = false;
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) ok = reader.bool();
    else reader.skip(wire);
  });
  return { ok };
};

/** 1902 Kick { int32 reason = 1; int32 other_platform = 2; } — tolerant decode. */
export const decodeKickPush = (bytes: Uint8Array): { reason: number; other_platform: number } => {
  const res = { reason: 0, other_platform: 0 };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) res.reason = reader.int32();
    else if (field === 2) res.other_platform = reader.int32();
    else reader.skip(wire);
  });
  return res;
};
