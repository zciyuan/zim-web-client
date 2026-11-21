// Microphone acquisition shared by the call flow and voice messages.
//
// `getUserMedia({ audio: true })` asks the browser for its *default* input, and
// Chromium remembers that device from the last successful capture. A USB headset
// that was re-plugged (new device id), or a saved pick that no longer exists,
// makes the default request fail with NotFoundError even though Windows still
// lists a working microphone. A remote desktop session without microphone
// redirection is the opposite case: the browser enumerates no input at all, so
// nothing can be opened. Both end up as "没有麦克风" for the user, but the fix is
// different, which is why the probe below keeps the enumerated count and retries
// every input before giving up.

export interface AudioInputResult {
  ok: boolean;
  /** Live stream when `ok`: the caller owns it and must stop its tracks. */
  stream: MediaStream | null;
  /** deviceId of the input that was actually opened ('' when none). */
  deviceId: string;
  label: string;
  /** How many `audioinput` devices the browser can enumerate. */
  inputs: number;
  /** First rejection of the default input, kept for diagnostics. */
  error: unknown;
  /** The default input failed and an enumerated device was opened instead. */
  recovered: boolean;
}

/** Result of the pre-call permission check (mic + optional camera). */
export interface MediaAccessResult {
  ok: boolean;
  /** Whether the call can capture video (false = degrade to voice). */
  video: boolean;
  /** Microphone Chrome actually opened; LiveKit publishes this same device. */
  deviceId: string;
  label: string;
  inputs: number;
  error: unknown;
  recovered: boolean;
  /** Video was requested but the camera could not be opened. */
  cameraFailed: boolean;
}

/** Stops every track of a probe stream (the call opens its own capture). */
export const releaseStream = (stream: MediaStream | null): void => {
  stream?.getTracks().forEach((track) => track.stop());
};

const audioDeviceId = (stream: MediaStream): string => stream.getAudioTracks()[0]?.getSettings().deviceId ?? '';

const enumerateAudioInputs = async (): Promise<MediaDeviceInfo[]> => {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  } catch {
    return [];
  }
};

const open = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('navigator.mediaDevices 不可用');
  }
  return navigator.mediaDevices.getUserMedia(constraints);
};

/**
 * Opens a microphone: the browser default first, then every enumerated input.
 * The returned stream stays live; callers that only probe must release it.
 */
export const openAudioInput = async (): Promise<AudioInputResult> => {
  const inputsNow = await enumerateAudioInputs();
  try {
    const stream = await open({ audio: true });
    return {
      ok: true,
      stream,
      deviceId: audioDeviceId(stream),
      label: stream.getAudioTracks()[0]?.label ?? '',
      inputs: inputsNow.length,
      error: null,
      recovered: false,
    };
  } catch (error) {
    // Remembered default gone (USB headset re-plugged) or the system exposes a
    // usable input the default never reaches: try each enumerated device.
    for (const input of inputsNow) {
      if (!input.deviceId) continue;
      try {
        const stream = await open({ audio: { deviceId: { exact: input.deviceId } } });
        return {
          ok: true,
          stream,
          deviceId: audioDeviceId(stream) || input.deviceId,
          label: stream.getAudioTracks()[0]?.label || input.label,
          inputs: inputsNow.length,
          error,
          recovered: true,
        };
      } catch {
        // Try the next input.
      }
    }
    return {
      ok: false,
      stream: null,
      deviceId: '',
      label: '',
      inputs: inputsNow.length,
      error,
      recovered: false,
    };
  }
};

/**
 * Pre-call probe: microphone plus the camera a video call needs. A camera-only
 * failure degrades the call to voice instead of failing it, and a microphone
 * that only opens through its explicit deviceId keeps the video request intact.
 */
export const acquireMediaAccess = async (video: boolean): Promise<MediaAccessResult> => {
  const failure = (error: unknown, inputs: number): MediaAccessResult => ({
    ok: false,
    video: false,
    deviceId: '',
    label: '',
    inputs,
    error,
    recovered: false,
    cameraFailed: false,
  });
  if (!navigator.mediaDevices?.getUserMedia) {
    return failure(new Error('navigator.mediaDevices 不可用'), 0);
  }
  if (video) {
    try {
      const stream = await open({ audio: true, video: true });
      const deviceId = audioDeviceId(stream);
      releaseStream(stream);
      return {
        ok: true,
        video: true,
        deviceId,
        label: '',
        inputs: (await enumerateAudioInputs()).length,
        error: null,
        recovered: false,
        cameraFailed: false,
      };
    } catch {
      // Either the camera or the default microphone: the probe below decides.
    }
  }
  const mic = await openAudioInput();
  if (!mic.ok || !mic.stream) {
    return failure(mic.error, mic.inputs);
  }
  releaseStream(mic.stream);
  if (!video) {
    return {
      ok: true,
      video: false,
      deviceId: mic.deviceId,
      label: mic.label,
      inputs: mic.inputs,
      error: mic.error,
      recovered: mic.recovered,
      cameraFailed: false,
    };
  }
  // A working microphone was found: retry the video request with it so a stale
  // default device does not silently downgrade a video call.
  try {
    const stream = await open({
      audio: mic.deviceId ? { deviceId: { exact: mic.deviceId } } : true,
      video: true,
    });
    const deviceId = audioDeviceId(stream) || mic.deviceId;
    releaseStream(stream);
    return {
      ok: true,
      video: true,
      deviceId,
      label: mic.label,
      inputs: mic.inputs,
      error: mic.error,
      recovered: mic.recovered,
      cameraFailed: false,
    };
  } catch {
    return {
      ok: true,
      video: false,
      deviceId: mic.deviceId,
      label: mic.label,
      inputs: mic.inputs,
      error: mic.error,
      recovered: mic.recovered,
      cameraFailed: true,
    };
  }
};

/**
 * Actionable copy for a failed microphone attempt. `inputs === 0` means the
 * device never reached the browser (remote desktop without microphone
 * redirection, or the OS privacy switch for desktop apps), which the user fixes
 * elsewhere instead of retrying the browser prompt.
 */
export const describeAudioInputFailure = (result: Pick<AudioInputResult, 'inputs' | 'error'>): string => {
  const name = (result.error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝：请在地址栏的站点设置里允许后重试';
  }
  if (result.inputs === 0) {
    return '浏览器没有检测到任何麦克风：远程桌面需在客户端勾选“从这台计算机录制”，或系统隐私设置未允许桌面应用使用麦克风';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被其他应用占用，关闭后重试';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return `检测到 ${result.inputs} 个麦克风但都无法打开，请在系统声音设置里确认后重试`;
  }
  return '无法访问麦克风，请检查系统权限';
};
