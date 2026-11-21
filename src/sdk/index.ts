// Public surface of the ZIM web SDK.
//
// The SDK is deliberately UI-agnostic: transport, codecs and REST only. React
// components consume it through src/app/store.ts, which keeps the same core
// reusable by a CLI, a Tauri shell or a test harness.

export * from './types';
export * from './errors';
export * from './proto';
export { OP, decodeMessageItem, decodeKickPush, type Envelope, type Opcode } from './messages';
export { IMClient, buildSocketUrl, type ClientTransport, type ConnectionState, type PushEvent, type KickEvent } from './client';
export {
  buildWebTransportUrl,
  decideTransport,
  parseTransports,
  probeWebTransport,
  webTransportSupported,
  type TransportDecision,
  type TransportOption,
  type TransportType,
} from './transport';
export { IMHttp, type RestOptions } from './rest';
export { directConversationId, groupConversationId, loadTail, loadOlder } from './history';
