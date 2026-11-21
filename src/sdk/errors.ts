// Client-facing error surface: ZIM codes (ZIM-02 §5) plus transport failures.
//
// The UI shows the friendly text and keeps the raw code visible, so a support
// engineer can map it straight back to zimfw/contract/errs/codes.go.

const MESSAGES = new Map<number, string>([
  [100001, '用户名或密码错误'],
  [100002, '登录态无效，请重新登录'],
  [100003, '账号已在其他设备登录'],
  [100004, '账号已被禁用'],
  [100005, '登录设备数超限'],
  [110001, '用户不存在'],
  [110002, '昵称不合法'],
  [120001, '已经是好友'],
  [120002, '好友申请不存在或已处理'],
  [120003, '对方已将你拉黑'],
  [130001, '群不存在'],
  [130002, '你不是群成员'],
  [130003, '没有群权限'],
  [130004, '群成员已满'],
  [130005, '群主不能退群'],
  [130006, '你已被禁言'],
  [140001, '会话不存在'],
  [150001, '消息内容为空'],
  [150002, '消息内容超长'],
  [150003, '消息命中敏感词'],
  [150004, '撤回超时'],
  [150005, '不是消息发送者'],
  [150006, '消息重复，已按原消息处理'],
  [160001, '同步版本过旧，需要全量同步'],
  [180001, '对方不在线'],
  [180002, '对方已拒绝'],
  [180003, '通话已结束'],
  [180004, '通话不存在'],
  [180005, '邀请已超时，对方未接听'],
  [180008, '通话人数已满'],
  [180009, '通话凭据已失效，请重试'],
  [180011, '对方正在通话中'],
  [190001, '对方不在线'],
  [800003, '批量操作超过 500 条'],
  [900001, '触发限流，请稍后再试'],
  [900002, '服务繁忙，请稍后再试'],
  [900003, '服务内部错误'],
]);

/** Error carrying a ZIM business code (0 means "no code"). */
export class ImError extends Error {
  readonly code: number;
  readonly detail: string;

  constructor(code: number, message?: string, cause?: unknown) {
    super(MESSAGES.get(code) ?? message ?? `请求失败（${code || '未知错误'}）`);
    this.name = 'ImError';
    this.code = code || 0;
    this.detail = message ?? '';
    if (cause !== undefined) this.cause = cause;
  }

  /** Text that is safe to render, with the raw code appended for support. */
  get display(): string {
    return this.code ? `${this.message}（${this.code}）` : this.message;
  }
}

/** Wraps any failure so every rejection shares one shape. */
export const wrapError = (err: unknown): ImError => {
  if (err instanceof ImError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ImError(0, message, err);
};
