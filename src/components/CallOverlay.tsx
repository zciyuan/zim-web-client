import { useEffect, useRef, useState } from 'react';

import { callSession } from '../app/call';
import { imStore, useIm } from '../app/store';
import { Avatar } from './Avatar';

/** Elapsed seconds of an active call. */
const useElapsed = (startedAt: number, active: boolean): number => {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active || startedAt <= 0) {
      setSeconds(0);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return seconds;
};

const clock = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** Full-screen call sheet: incoming, outgoing and active states. */
export function CallOverlay() {
  const state = useIm();
  const call = state.call;
  const remoteRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(call.startedAt, call.phase === 'active');

  useEffect(() => {
    if (call.phase !== 'active' && call.phase !== 'connecting') return;
    callSession.onTrack({
      onRemoteVideo: (element) => {
        const host = remoteRef.current;
        if (host) {
          host.replaceChildren(element);
          void element.play().catch(() => undefined);
        }
      },
    });
    void callSession.localVideo().then((element) => {
      const host = localRef.current;
      if (host && element) {
        host.replaceChildren(element);
        void element.play().catch(() => undefined);
      }
    });
  }, [call.phase, call.room]);

  if (call.phase === 'idle') return null;
  const video = call.media === 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur">
      <div
        aria-label="通话"
        data-phase={call.phase}
        className="w-[min(560px,94vw)] overflow-hidden rounded-3xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
          <span>{video ? '视频通话' : '语音通话'}</span>
          <span>{call.phase === 'active' ? clock(elapsed) : '等待接通'}</span>
        </div>

        <div className="relative flex h-[300px] items-center justify-center bg-slate-950">
          {video && call.phase === 'active' ? (
            <div ref={remoteRef} className="h-full w-full" />
          ) : (
            <div className="flex flex-col items-center gap-3">
              <Avatar name={call.peerName} seed={call.peerId} size={72} />
              <p className="text-sm font-medium">{call.peerName}</p>
              <p className="text-xs text-slate-400">
                {call.phase === 'incoming'
                  ? '邀请你通话'
                  : call.phase === 'outgoing'
                    ? '正在呼叫…'
                    : call.phase === 'connecting'
                      ? '正在接通…'
                      : '通话中'}
              </p>
            </div>
          )}
          {video && call.phase === 'active' ? (
            <div ref={localRef} className="absolute bottom-3 right-3 h-24 w-32 overflow-hidden rounded-xl border border-slate-700 bg-slate-800" />
          ) : null}
        </div>

        <div className="flex items-center justify-center gap-3 px-4 py-4">
          {call.phase === 'incoming' ? (
            <>
              <button
                type="button"
                onClick={() => void imStore.rejectCall()}
                className="rounded-full bg-rose-600 px-5 py-2 text-sm font-medium text-white"
              >
                拒绝
              </button>
              <button
                type="button"
                onClick={() => void imStore.acceptCall()}
                className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white"
              >
                接听
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void imStore.toggleMute()}
                className={`rounded-full border px-4 py-2 text-xs ${call.muted ? 'border-rose-500 text-rose-400' : 'border-slate-600 text-slate-200'}`}
              >
                {call.muted ? '取消静音' : '静音'}
              </button>
              {video ? (
                <button
                  type="button"
                  onClick={() => void imStore.toggleCamera()}
                  className={`rounded-full border px-4 py-2 text-xs ${call.videoOn ? 'border-slate-600 text-slate-200' : 'border-rose-500 text-rose-400'}`}
                >
                  {call.videoOn ? '关闭摄像头' : '打开摄像头'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void imStore.hangupCall()}
                className="rounded-full bg-rose-600 px-5 py-2 text-sm font-medium text-white"
              >
                {call.phase === 'outgoing' ? '取消' : '挂断'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
