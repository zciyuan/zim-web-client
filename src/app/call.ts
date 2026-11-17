// LiveKit call session wrapper.
//
// Keeps the LiveKit Room out of the React store: the store only tracks the
// signaling phase, this module owns media tracks and rendering.

import { Room, RoomEvent, Track, VideoPresets, type RemoteTrack } from 'livekit-client';

export interface CallTrackHandlers {
  /** identities of participants currently speaking (active speaker detection). */
  onSpeakers?: (uids: string[]) => void;
  /** identity -> attached <video> element (group calls keep one per peer). */
  onRemoteTracks?: (tracks: Map<string, HTMLVideoElement>) => void;
  /** a remote participant left the room (1:1 calls end here). */
  onParticipantJoined?: (identity: string) => void;
  onParticipantLeft?: (identity: string) => void;
  /** the room dropped for good (media/connection lost). */
  onDisconnected?: () => void;
}

/** One in-flight call's media session. */
export class CallSession {
  private room: Room | null = null;
  private handlers: CallTrackHandlers = {};
  private videoTracks = new Map<string, HTMLVideoElement>();
  private speakers: string[] = [];
  private localVideoEl: HTMLVideoElement | null = null;
  private mediaErrors: string[] = [];

  /**
   * Registers (or updates) handlers. Media already flowing is replayed, because
   * the call sheet mounts *after* connect(): tracks subscribed in between would
   * otherwise never reach the UI.
   */
  onTrack(handlers: CallTrackHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
    this.emitTracks();
    if (this.handlers.onSpeakers) this.handlers.onSpeakers(this.speakers);
  }

  /** Joins the SFU room and publishes mic (and camera for video calls). */
  async connect(url: string, token: string, video: boolean): Promise<void> {
    await this.end();
    // 360p capture keeps phones (and software-rendered desktops) responsive; the
    // SFU still forwards whatever the sender publishes.
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
    });
    this.room = room;

    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (import.meta.env.DEV) console.debug('[zim] local track published', publication.source, publication.trackSid);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (import.meta.env.DEV) console.debug('[zim] local track unpublished', publication.source);
    });
    room.on(RoomEvent.ConnectionStateChanged, (connectionState) => {
      if (import.meta.env.DEV) console.debug('[zim] room state', connectionState);
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant) => {
      const element = track.attach();
      element.autoplay = true;
      element.setAttribute('playsinline', '');
      if (track.kind === Track.Kind.Video) {
        element.className = 'h-full w-full rounded-xl object-cover';
        const identity = participant?.identity ?? '';
        if (identity) this.videoTracks.set(identity, element as HTMLVideoElement);
        void element.play().catch(() => undefined);
        this.emitTracks();
      } else {
        element.className = 'hidden';
        element.setAttribute('data-zim-call', '1');
        document.body.appendChild(element);
        void element.play().catch(() => undefined);
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

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      this.handlers.onParticipantJoined?.(participant.identity);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.handlers.onParticipantLeft?.(participant.identity);
    });
    room.on(RoomEvent.Disconnected, () => {
      this.handlers.onDisconnected?.();
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this.speakers = speakers.map((participant) => participant.identity).filter(Boolean);
      this.handlers.onSpeakers?.(this.speakers);
    });

    // Publishing right after connect() can race the peer connection setup
    // ("pcManager is not ready"): this.publish retries instead of giving up.
    // Publish exactly once — a second concurrent negotiation times out.
    await room.connect(url, token);
    await this.publish(room, video);
  }

  /**
   * Publishes mic (+ camera) in a single negotiation. Publishing the tracks in
   * two separate calls races the SDP exchange: the SFU then receives RTP for an
   * SSRC it never learned ("Incoming unhandled RTP ssrc") and subscribers stay
   * empty, which looks like "the call connects but there is no audio/video".
   */
  private async publish(room: Room, video: boolean): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (this.room !== room) return;
      if (import.meta.env.DEV) console.debug('[zim] publish attempt', attempt, 'video=' + video);
      try {
        if (!room.localParticipant.isMicrophoneEnabled) {
          await room.localParticipant.setMicrophoneEnabled(true);
        }
        if (video && !room.localParticipant.isCameraEnabled) {
          await room.localParticipant.setCameraEnabled(true);
        }
        return;
      } catch (err) {
        const text = String(err);
        if (!/pcManager is not ready|not connected|not ready/i.test(text) || attempt === 11) {
          this.mediaErrors.push(`publish: ${text}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private emitTracks(): void {
    if (!this.handlers.onRemoteTracks) return;
    this.handlers.onRemoteTracks(new Map(this.videoTracks));
  }

  /** Local camera element for the self-view (video calls). */
  async localVideo(): Promise<HTMLVideoElement | null> {
    if (this.localVideoEl) return this.localVideoEl;
    // The camera publication may still be negotiating when the sheet mounts.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const track = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (track) {
        const element = track.attach() as HTMLVideoElement;
        element.muted = true;
        element.autoplay = true;
        element.setAttribute('playsinline', '');
        element.className = 'h-full w-full rounded-xl object-cover';
        void element.play().catch(() => undefined);
        this.localVideoEl = element;
        return element;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(enabled);
  }

  async setCamera(enabled: boolean): Promise<void> {
    if (enabled) this.localVideoEl = null;
    await this.room?.localParticipant.setCameraEnabled(enabled);
  }

  /** Dev-only snapshot for the e2e/probe harness. */
  debug(): {
    room: boolean;
    localTracks: string[];
    remoteTracks: string[];
    videoTracks: string[];
    errors: string[];
    participants: string[];
  } {
    const room = this.room;
    const local = room ? (room.localParticipant as unknown as { trackPublications?: Map<string, { source: string; track?: { kind?: string } }> }) : null;
    return {
      room: Boolean(room),
      localTracks: local?.trackPublications ? [...local.trackPublications.values()].map((item) => `${item.source}:${item.track?.kind ?? '-'}`) : [],
      remoteTracks: room
        ? [...room.remoteParticipants.values()].flatMap((participant) => [
          ...participant.trackPublications.values(),
        ].map((item) => `${participant.identity}:${item.source}:${item.track?.kind ?? '-'}`))
        : [],
      videoTracks: [...this.videoTracks.keys()],
      errors: [...this.mediaErrors],
      participants: room ? [...room.remoteParticipants.keys()] : [],
    };
  }

  async end(): Promise<void> {
    this.videoTracks.clear();
    this.mediaErrors = [];
    this.localVideoEl = null;
    this.speakers = [];
    this.emitTracks();
    if (!this.room) return;
    const room = this.room;
    this.room = null;
    room.disconnect();
    document.querySelectorAll('audio[data-zim-call]').forEach((element) => element.remove());
  }
}

/** Process-wide session (one call at a time per tab). */
export const callSession = new CallSession();
