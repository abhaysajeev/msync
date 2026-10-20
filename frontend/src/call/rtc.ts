// Two-person camera + mic call, peer to peer, signaled over the room socket.
// "Perfect negotiation" (the guest is polite) resolves offer glare and survives reconnects.
import { api } from "../lib/api";
import type { Msg, RoomSocket } from "../lib/socket";

export interface CallView {
  local: MediaStream | null;
  remote: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  peerMic: boolean;
  peerCam: boolean;
  state: RTCPeerConnectionState | "idle";
  error: string | null;
  speaking: boolean; // the peer is talking (for ducking the film)
}

const VIDEO_KBPS = 500;

export class Call {
  private pc: RTCPeerConnection | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private ice: RTCIceServer[] = [];
  private offs: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private analyser: { ctx: AudioContext; node: AnalyserNode; buf: Uint8Array<ArrayBuffer> } | null = null;
  private levelTimer: number | undefined;

  local: MediaStream | null = null;
  remote: MediaStream | null = null;
  micOn = true;
  camOn = true;
  peerMic = true;
  peerCam = true;
  error: string | null = null;
  speaking = false;
  started = false;

  constructor(private socket: RoomSocket, private polite: boolean) {}

  view(): CallView {
    return {
      local: this.local, remote: this.remote, micOn: this.micOn, camOn: this.camOn,
      peerMic: this.peerMic, peerCam: this.peerCam, state: this.pc?.connectionState ?? "idle",
      error: this.error, speaking: this.speaking,
    };
  }

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit() {
    this.listeners.forEach((f) => f());
  }

  /** Must run inside a user gesture (the Join tap): camera permission and iOS audio session. */
  async start(opts: { camera: boolean; mic: boolean }): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Keep iOS in play-and-record from the start, so the film's volume does not jump
    // when the mic opens later (WebKit 236219).
    const nav = navigator as any;
    if (nav.audioSession) {
      try {
        nav.audioSession.type = "play-and-record";
      } catch {
        /* older Safari */
      }
    }
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        video: opts.camera ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false,
        audio: opts.mic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
      });
    } catch (e: any) {
      this.error = e?.name === "NotAllowedError"
        ? "Camera and microphone are blocked. Allow them in the browser's site settings to join the call."
        : "No camera or microphone was found.";
      this.local = null;
    }
    this.micOn = !!this.local?.getAudioTracks().length;
    this.camOn = !!this.local?.getVideoTracks().length;

    try {
      this.ice = (await api.get<{ iceServers: RTCIceServer[] }>("/api/ice")).iceServers;
    } catch {
      this.ice = [{ urls: "stun:stun.l.google.com:19302" }];
    }

    this.offs.push(
      this.socket.on("rtc", (m) => void this.onSignal(m)),
      this.socket.on("media_state", (m) => {
        this.peerMic = !!m.mic;
        this.peerCam = !!m.cam;
        this.emit();
      }),
    );
    this.rebuild();
    this.socket.send({ t: "rtc", data: { hello: true } });
    this.sendMediaState();
    this.emit();
  }

  private rebuild() {
    this.pc?.close();
    this.remote = null;
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: "max-bundle" });
    this.pc = pc;
    this.makingOffer = false;
    this.ignoreOffer = false;

    if (this.local) {
      for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
    } else {
      // receive-only, so the peer's camera still reaches us
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.addTransceiver("video", { direction: "recvonly" });
    }
    this.preferH264(pc);

    pc.ontrack = (ev) => {
      this.remote = ev.streams[0] ?? new MediaStream([ev.track]);
      this.watchLevel();
      this.emit();
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.socket.send({ t: "rtc", data: { candidate: ev.candidate.toJSON() } });
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.socket.send({ t: "rtc", data: { description: pc.localDescription?.toJSON() } });
      } catch (e) {
        console.warn("negotiation failed", e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") void this.capBitrate(pc);
      if (pc.connectionState === "failed") pc.restartIce();
      this.emit();
    };
  }

  private preferH264(pc: RTCPeerConnection) {
    // Safari encodes H.264 in hardware; keep VP8 as the fallback
    const caps = (RTCRtpReceiver as any).getCapabilities?.("video");
    if (!caps) return;
    const h264 = caps.codecs.filter((c: any) => /h264/i.test(c.mimeType));
    const rest = caps.codecs.filter((c: any) => !/h264/i.test(c.mimeType));
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track?.kind === "video" && typeof t.setCodecPreferences === "function") {
        try {
          t.setCodecPreferences([...h264, ...rest]);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async capBitrate(pc: RTCPeerConnection) {
    for (const s of pc.getSenders()) {
      if (s.track?.kind !== "video") continue;
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = VIDEO_KBPS * 1000;
      try {
        await s.setParameters(p);
      } catch {
        /* some browsers refuse before the first frame */
      }
    }
  }

  private async onSignal(m: Msg) {
    const data = m.data ?? {};
    if (data.hello) {
      // the peer just started or restarted: start over on our side too
      this.rebuild();
      this.sendMediaState();
      return;
    }
    const pc = this.pc;
    if (!pc) return;
    try {
      if (data.description) {
        const desc = data.description as RTCSessionDescriptionInit;
        const collision = desc.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === "offer") {
          await pc.setLocalDescription();
          this.socket.send({ t: "rtc", data: { description: pc.localDescription?.toJSON() } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!this.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn("signaling error", e);
    }
  }

  private sendMediaState() {
    this.socket.send({ t: "media_state", mic: this.micOn, cam: this.camOn });
  }

  toggleMic(): void {
    const t = this.local?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    this.micOn = t.enabled;
    this.sendMediaState();
    this.emit();
  }

  toggleCam(): void {
    const t = this.local?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    this.camOn = t.enabled;
    this.sendMediaState();
    this.emit();
  }

  /** iOS may stop the camera while the app is in the background; get a fresh one on return. */
  async refreshCamera(): Promise<void> {
    const old = this.local?.getVideoTracks()[0];
    if (!old || old.readyState === "live" || !this.pc) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } });
      const track = s.getVideoTracks()[0];
      track.enabled = this.camOn;
      const sender = this.pc.getSenders().find((x) => x.track?.kind === "video" || x.track === old);
      await sender?.replaceTrack(track);
      this.local?.removeTrack(old);
      this.local?.addTrack(track);
      this.emit();
    } catch {
      /* stays off */
    }
  }

  /** Watches the peer's voice level so the UI can duck the film while they talk. */
  private watchLevel() {
    if (!this.remote?.getAudioTracks().length) return;
    try {
      this.analyser?.ctx.close();
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(this.remote);
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      src.connect(node);
      this.analyser = { ctx, node, buf: new Uint8Array(new ArrayBuffer(node.fftSize)) };
    } catch {
      return;
    }
    clearInterval(this.levelTimer);
    let loudSince = 0;
    let quietSince = 0;
    this.levelTimer = window.setInterval(() => {
      const a = this.analyser;
      if (!a) return;
      a.node.getByteTimeDomainData(a.buf);
      let sum = 0;
      for (const v of a.buf) sum += (v - 128) * (v - 128);
      const rms = Math.sqrt(sum / a.buf.length) / 128;
      const now = performance.now();
      if (rms > 0.04) {
        loudSince = loudSince || now;
        quietSince = 0;
        if (!this.speaking && now - loudSince > 150) {
          this.speaking = true;
          this.emit();
        }
      } else {
        quietSince = quietSince || now;
        loudSince = 0;
        if (this.speaking && now - quietSince > 700) {
          this.speaking = false;
          this.emit();
        }
      }
    }, 50);
  }

  stop(): void {
    this.offs.forEach((f) => f());
    clearInterval(this.levelTimer);
    this.analyser?.ctx.close();
    this.pc?.close();
    this.local?.getTracks().forEach((t) => t.stop());
    this.pc = null;
    this.started = false;
  }
}
