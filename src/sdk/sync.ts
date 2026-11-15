// Sync codecs: 1601 SyncCheck and 1514 SyncMissing.
//
// Field numbers follow internal/protocol/sync/sync.proto byte for byte.

import { Writer, decodeFields } from './proto';
import type { MessageItem } from './types';

export interface SyncRange {
  conv_id: string;
  from_seq: string;
  to_seq: string;
}

export interface SyncCheckResult {
  conversation_version: string;
  friend_version: string;
  friend_changed: boolean;
  full_sync_required: boolean;
  truncated: boolean;
  conversation_diff: SyncRange[];
  server_time: string;
}

/** 1601 SyncCheckReq { conversation_version=1; friend_version=2; map<string,int64> max_seqs=3; } */
export const encodeSyncCheckReq = (req: {
  conversationVersion: number;
  friendVersion: number;
  maxSeqs?: Record<string, number>;
}): Uint8Array => {
  const writer = new Writer().int64(1, req.conversationVersion).int64(2, req.friendVersion);
  for (const [key, value] of Object.entries(req.maxSeqs ?? {})) {
    const entry = new Writer().string(1, key).int64(2, value).finish();
    writer.bytes(3, entry);
  }
  return writer.finish();
};

export const decodeSyncCheckRes = (bytes: Uint8Array): SyncCheckResult => {
  const result: SyncCheckResult = {
    conversation_version: '0',
    friend_version: '0',
    friend_changed: false,
    full_sync_required: false,
    truncated: false,
    conversation_diff: [],
    server_time: '0',
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: result.conversation_version = reader.int64(); break;
      case 2: result.friend_version = reader.int64(); break;
      case 3: result.friend_changed = reader.bool(); break;
      case 4: result.full_sync_required = reader.bool(); break;
      case 5: result.truncated = reader.bool(); break;
      case 6: result.conversation_diff.push(decodeSyncRange(reader.bytes())); break;
      case 7: result.server_time = reader.int64(); break;
      default: reader.skip(wire);
    }
  });
  return result;
};

const decodeSyncRange = (bytes: Uint8Array): SyncRange => {
  const range: SyncRange = { conv_id: '', from_seq: '0', to_seq: '0' };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) range.conv_id = reader.string();
    else if (field === 2) range.from_seq = reader.int64();
    else if (field === 3) range.to_seq = reader.int64();
    else reader.skip(wire);
  });
  return range;
};

/** 1514 SyncMissingReq { conversation_id=1; repeated int64 seqs=2; limit=3; } */
export const encodeSyncMissingReq = (req: {
  conversationId: string;
  seqs: number[];
  limit?: number;
}): Uint8Array => {
  const writer = new Writer().string(1, req.conversationId).int32(3, req.limit ?? 100);
  for (const seq of req.seqs) writer.int64(2, seq);
  return writer.finish();
};

export interface SyncMissingResult {
  messages: MessageItem[];
  missing: string[];
}

export const decodeSyncMissingRes = (bytes: Uint8Array): SyncMissingResult => {
  const result: SyncMissingResult = { messages: [], missing: [] };
  decodeFields(bytes, (reader, field, wire) => {
    if (field === 1) result.messages.push(decodeSyncMissingItem(reader.bytes()));
    else if (field === 2) result.missing.push(reader.int64());
    else reader.skip(wire);
  });
  return result;
};

/** SyncMissingItem carries the same fields as a message minus conversation_id. */
const decodeSyncMissingItem = (bytes: Uint8Array): MessageItem => {
  const item: MessageItem = {
    server_msg_id: '', client_msg_id: '', conversation_id: '', seq: '0',
    send_id: '0', recv_id: '0', group_id: '0', msg_type: 1, content: '',
    at_user_ids: [], send_time: '0', status: 0,
  };
  decodeFields(bytes, (reader, field, wire) => {
    switch (field) {
      case 1: item.server_msg_id = reader.string(); break;
      case 2: item.client_msg_id = reader.string(); break;
      case 3: item.seq = reader.int64(); break;
      case 4: item.send_id = reader.int64(); break;
      case 5: item.recv_id = reader.int64(); break;
      case 6: item.group_id = reader.int64(); break;
      case 7: item.msg_type = reader.int32(); break;
      case 8: item.content = reader.string(); break;
      case 9: item.send_time = reader.int64(); break;
      case 10: item.status = reader.int32(); break;
      default: reader.skip(wire);
    }
  });
  return item;
};
