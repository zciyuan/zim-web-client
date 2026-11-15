// Wire-level types.
//
// Field names stay snake_case on purpose: they are the JSON/protobuf contract
// from ZIM-02, and renaming them in the client only creates a mapping layer
// where mistakes hide. int64 values are strings everywhere (JS numbers lose
// precision above 2^53 and snowflake ids are ~3.8e17).

/** int64 on the wire, always a decimal string in JS. */
export type Int64String = string;

export interface SyncState {
  conversation_version: Int64String;
  friend_version: Int64String;
  max_seqs: Record<string, Int64String>;
}

export interface OnlineDevice {
  platform: number;
  device_name: string;
}

export interface LoginRes {
  uid: string;
  nickname: string;
  avatar: string;
  server_time: Int64String;
  sync: SyncState | null;
  online_devices: OnlineDevice[];
}

export interface MessageItem {
  server_msg_id: string;
  client_msg_id: string;
  conversation_id: string;
  seq: Int64String;
  send_id: Int64String;
  recv_id: Int64String;
  group_id: Int64String;
  msg_type: number;
  content: string;
  at_user_ids: string[];
  send_time: Int64String;
  status: number;
}

export interface SendRes {
  server_msg_id: string;
  seq: Int64String;
  send_time: Int64String;
  unread_count: Int64String;
}

export interface PullBySeqRes {
  messages: MessageItem[];
  has_more: boolean;
}

/** REST /v1/conversations item. int64 ids arrive as JSON numbers (see ADR-0029). */
export interface Conversation {
  conversation_id: string;
  type: number;
  peer_id: string;
  group_id: string;
  recv_opt: number;
  is_pinned: number;
  last_msg_id?: string;
  last_msg_seq?: number;
  last_msg_at?: number;
  last_msg_brief?: string;
  read_seq?: number;
  max_seq?: number;
  unread?: number;
  updated_at?: number;
}

export interface UserProfile {
  uid: string;
  username?: string;
  nickname?: string;
  avatar?: string;
  updated_at?: number;
}

export interface Friend {
  friend_id: string;
  remark?: string;
  pinned?: number;
  created_at?: number;
  profile?: UserProfile;
}

export interface Group {
  group_id: string;
  name?: string;
  owner_id?: string;
  group_type?: number;
  max_member?: number;
  member_count?: number;
  created_at?: number;
  /** exact (unrounded) gid resolved over the wire protocol */
  display_id?: string;
}

export interface GroupMember {
  group_id?: string;
  user_id: string;
  role?: number;
  mute_until?: Int64String;
  joined_at?: Int64String;
  nickname?: string;
  username?: string;
}

export interface LoginSession {
  uid: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}
