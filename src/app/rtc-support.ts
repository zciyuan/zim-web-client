// WebRTC capability probe: the call UI degrades with a precise message instead
// of letting LiveKit throw a generic "not supported" error.

export type RtcSupportReason =
  | 'ok'
  | 'insecure-context'
  | 'no-rtc'
  | 'no-transceiver'
  | 'no-mediadevices';

export interface RtcSupport {
  supported: boolean;
  reason: RtcSupportReason;
  /** Ready-to-show explanation (Chinese, matches the app copy). */
  detail: string;
}

export const detectRtcSupport = (): RtcSupport => {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'no-rtc', detail: '当前环境不支持音视频通话' };
  }
  const hasRtc = typeof RTCPeerConnection !== 'undefined';
  const hasTransceiver = typeof RTCRtpTransceiver !== 'undefined';
  const hasAddTrack = hasRtc && typeof RTCPeerConnection.prototype.addTrack === 'function';
  const hasMedia = Boolean(navigator.mediaDevices?.getUserMedia);

  if (!hasRtc) {
    return {
      supported: false,
      reason: 'no-rtc',
      detail: '当前浏览器未启用 WebRTC（RTCPeerConnection 不存在）。'
        + '常见原因：浏览器版本过旧，或安装了阻止 WebRTC 的扩展（uBlock/隐私类插件）。'
        + '请在无痕窗口或关闭相关扩展后重试。',
    };
  }
  if (!hasTransceiver && !hasAddTrack) {
    return {
      supported: false,
      reason: 'no-transceiver',
      detail: '当前浏览器的 WebRTC 实现缺少 RTCRtpTransceiver/addTrack，无法建立音视频连接，请升级浏览器。',
    };
  }
  if (!hasMedia) {
    return {
      supported: false,
      reason: 'no-mediadevices',
      detail: window.isSecureContext
        ? '浏览器未提供媒体设备接口（navigator.mediaDevices）。请检查站点权限，或关闭屏蔽摄像头的扩展。'
        : `通话需要 HTTPS 或 localhost（当前是 ${window.location.origin}），浏览器已在非安全来源下禁用摄像头/麦克风。`
        + '请改用 https:// 或 http://127.0.0.1 访问。',
    };
  }
  return { supported: true, reason: 'ok', detail: '' };
};

/** Maps LiveKit's generic support error onto the same actionable copy. */
export const explainRtcError = (message: string): string => {
  if (/doesn't seem to be supported|webRTC isn't detected/i.test(message)) {
    const support = detectRtcSupport();
    if (!support.supported) return support.detail;
    return '浏览器报告 WebRTC 不可用：请检查是否有扩展/策略禁用了 WebRTC，并尝试无痕窗口。';
  }
  return message;
};
