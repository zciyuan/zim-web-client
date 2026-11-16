// LiveKit call session wrapper.
//
// Keeps the LiveKit Room out of the React store: the store only tracks the
// signaling phase, this module owns media tracks and rendering.

import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';

export interface CallTrackHandlers {
  /** identity -> attached <video> element (group calls keep one per peer). */
  onRemoteTracks?: (tracks: Map<string, HTMLVideoElement>) => void;
}

/** One in-flight call's media session. */
export class CallSession {
  private room: Room | null = null;
  private handlers: CallTrackHandlers = {};
  private videoTracks = new Map<string, HTMLVideoElement>();

  onTrack(handlers: CallTrackHandlers): void {
    this.handlers = handlers;
  }

  /** Joins the SFU room and publishes mic (and camera for video calls). */
  async connect(url: string, token: string, video: boolean): Promise<void> {
    await this.end();
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant) => {
      const element = track.attach();
      element.autoplay = true;
      element.setAttribute('playsinline', '');
      if (track.kind === Track.Kind.Video) {
        element.className = 'h-full w-full rounded-xl object-cover';
        const identity = participant?.identity ?? '';
        if (identity) this.videoTracks.set(identity, element as HTMLVideoElement);
        this.emitTracks();
      } else {
        element.className = 'hidden';
        element.setAttribute('data-zim-call', '1');
        document.body.appendChild(element);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication, participant) => {
      if (track.kind === Track.Kind.Video) {
        const identity = participant?.identity ?? '';
        if (identity) this.videoTracks.delete(identity);
        this.emitTracks();
      }
      track.detach().forEach((element) => element.remove());
    });

    await room.connect(url, token);
    // Media setup failures must not tear the call down: the signaling phase is
    // already active and the user can unmute/retry from the call sheet.
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch {
      // mic denied or busy
    }
    if (video) {
      try {
        await room.localParticipant.setCameraEnabled(true);
      } catch {
        // camera denied or busy
      }
    }
  }

  private emitTracks(): void {
    this.handlers.onRemoteTracks?.(new Map(this.videoTracks));
  }

  /** Local camera element for the self-view (video calls). */
  async localVideo(): Promise<HTMLVideoElement | null> {
    const publication = this.room?.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = publication?.track;
    if (!track) return null;
    const element = track.attach() as HTMLVideoElement;
    element.muted = true;
    element.autoplay = true;
    element.setAttribute('playsinline', '');
    element.className = 'h-full w-full rounded-xl object-cover';
    return element;
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(enabled);
  }

  async setCamera(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setCameraEnabled(enabled);
  }

  async end(): Promise<void> {
    this.videoTracks.clear();
    this.handlers.onRemoteTracks?.(new Map());
    if (!this.room) return;
    const room = this.room;
    this.room = null;
    room.disconnect();
    document.querySelectorAll('audio[data-zim-call]').forEach((element) => element.remove());
  }
}

/** Process-wide session (one call at a time per tab). */
export const callSession = new CallSession();
