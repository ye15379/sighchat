"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RtcSignalPayload } from "./useMatchSocket";

/** Diagnostic: summarise a MediaStream for logging. */
function getStreamInfo(stream: MediaStream | null | undefined): string {
  if (!stream) return "null";
  const tracks = stream
    .getTracks()
    .map((t) => `${t.kind}:${t.id.slice(0, 8)}:${t.readyState}`);
  return `id=${stream.id.slice(0, 8)} [${tracks.join(", ")}]`;
}

type UseRoomRtcParams = {
  enabled: boolean;
  roomId: string | null;
  sendSignal: (signal: RtcSignalPayload) => void;
  signalQueue: RtcSignalPayload[];
  signalVersion: number;
};

export function useRoomRtc({
  enabled,
  roomId,
  sendSignal,
  signalQueue,
  signalVersion,
}: UseRoomRtcParams) {
  const isDev = process.env.NODE_ENV === "development";
  const [state, setState] = useState<
    "idle" | "starting" | "waiting_peer" | "calling" | "connected" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const clientIdRef = useRef<string>(
    (globalThis.crypto && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`) as string,
  );
  const peerClientIdRef = useRef<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const startedRef = useRef(false);
  const negotiatedRef = useRef(false);
  const processedSignalKeyRef = useRef<string | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const transceiversAddedRef = useRef(false);
  const audioTxRef = useRef<RTCRtpTransceiver | null>(null);
  const videoTxRef = useRef<RTCRtpTransceiver | null>(null);
  const isCallerRef = useRef<boolean | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Serialized drain machinery ──
  // processingRef: mutex — only one drain loop can run at a time.
  // pcReadyVersion: bumped after autoStart creates the PC, so the drain
  //   effect re-fires and finally consumes signals queued during getUserMedia.
  // drainTrigger: bumped at the end of a drain loop if the queue still has
  //   items (signals arrived while we were awaiting SDP ops).
  const processingRef = useRef(false);
  const [pcReadyVersion, setPcReadyVersion] = useState(0);
  const [drainTrigger, setDrainTrigger] = useState(0);

  // Bumped every time ontrack delivers new tracks.  A useEffect watches
  // this counter so binding runs AFTER React commits the DOM — fixing the
  // Safari race where ontrack fires before the remote <video> ref is set.
  const [remoteStreamVersion, setRemoteStreamVersion] = useState(0);

  const [debugLastError, setDebugLastError] = useState<string | null>(null);
  const [pcDebugState, setPcDebugState] = useState<{
    connectionState: RTCPeerConnectionState | "none";
    iceConnectionState: RTCIceConnectionState | "none";
    signalingState: RTCSignalingState | "none";
    iceGatheringState: RTCIceGatheringState | "none";
    remoteTrackReceived: boolean;
    selectedCandidatePair: string | null;
    lastIceCandidateSummary: string;
  }>({
    connectionState: "none",
    iceConnectionState: "none",
    signalingState: "none",
    iceGatheringState: "none",
    remoteTrackReceived: false,
    selectedCandidatePair: null,
    lastIceCandidateSummary: "",
  });

  // ──────────────────────────────────────────────────────────
  // FIX: Stable ref for sendSignal.
  //
  // sendSignal (from useMatchSocket) is NOT wrapped in useCallback,
  // so it receives a new identity on every render of the parent.
  // If we put it directly into dependency arrays of useCallback /
  // useEffect, the entire chain (cleanup → autoStart → main effect)
  // gets a new identity every render, causing:
  //   effect re-runs → cleanup() → resetSessionFlags() →
  //   setPcDebugState({new obj}) → re-render → loop
  //
  // Capturing it in a ref keeps all downstream hooks stable.
  // ──────────────────────────────────────────────────────────
  const sendSignalRef = useRef(sendSignal);
  useEffect(() => {
    sendSignalRef.current = sendSignal;
  });

  const resetSessionFlags = () => {
    processingRef.current = false;
    peerClientIdRef.current = null;
    negotiatedRef.current = false;
    processedSignalKeyRef.current = null;
    pendingIceRef.current = [];
    transceiversAddedRef.current = false;
    audioTxRef.current = null;
    videoTxRef.current = null;
    isCallerRef.current = null;
    // FIX: skip re-render when already in reset state
    setPcDebugState((prev) => {
      if (
        prev.connectionState === "none" &&
        prev.iceConnectionState === "none" &&
        prev.signalingState === "none" &&
        prev.iceGatheringState === "none" &&
        !prev.remoteTrackReceived &&
        prev.selectedCandidatePair === null &&
        prev.lastIceCandidateSummary === ""
      ) {
        return prev;
      }
      return {
        connectionState: "none",
        iceConnectionState: "none",
        signalingState: "none",
        iceGatheringState: "none",
        remoteTrackReceived: false,
        selectedCandidatePair: null,
        lastIceCandidateSummary: "",
      };
    });
    setDebugLastError((prev) => (prev === null ? prev : null));
  };

  const debugLog = useCallback(
    (...args: unknown[]) => {
      if (!isDev) return;
      console.log("[RTC]", ...args);
    },
    [isDev],
  );

  const updatePcDebugState = useCallback(() => {
    const pc = pcRef.current;
    if (!pc) return;
    setPcDebugState((prev) => {
      if (
        prev.connectionState === pc.connectionState &&
        prev.iceConnectionState === pc.iceConnectionState &&
        prev.signalingState === pc.signalingState &&
        prev.iceGatheringState === pc.iceGatheringState
      ) {
        return prev; // no change — skip re-render
      }
      return {
        ...prev,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        iceGatheringState: pc.iceGatheringState,
      };
    });
  }, []);

  /**
   * Build ICE servers for RTCPeerConnection.
   * Reads NEXT_PUBLIC_ICE_SERVERS (JSON array of RTCIceServer).
   * Also supports legacy NEXT_PUBLIC_RTC_ICE_SERVERS_JSON for backward compat.
   * Fallback: two public STUN servers (no TURN).
   */
  const buildIceServers = useCallback((): RTCIceServer[] => {
    const fallback: RTCIceServer[] = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ];
    const raw =
      process.env.NEXT_PUBLIC_ICE_SERVERS ?? process.env.NEXT_PUBLIC_RTC_ICE_SERVERS_JSON;
    if (!raw || typeof raw !== "string" || !raw.trim()) return fallback;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
      return parsed as RTCIceServer[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debugLog("Invalid NEXT_PUBLIC_ICE_SERVERS, fallback to default STUN", msg);
      setDebugLastError(`Invalid ICE env JSON: ${msg}`);
      return fallback;
    }
  }, [debugLog]);

  const updateSelectedCandidatePair = useCallback(async () => {
    if (!isDev) return;
    const pc = pcRef.current;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let selectedPair: RTCStats | null = null;
      const byId = new Map<string, RTCStats>();
      stats.forEach((report) => {
        byId.set(report.id, report);
      });

      stats.forEach((report) => {
        const r = report as RTCStats & {
          type?: string;
          selected?: boolean;
          nominated?: boolean;
          state?: string;
          localCandidateId?: string;
          remoteCandidateId?: string;
        };
        if (r.type === "transport" && "selectedCandidatePairId" in r) {
          const transportPairId = (r as RTCStats & { selectedCandidatePairId?: string })
            .selectedCandidatePairId;
          if (transportPairId && byId.has(transportPairId)) {
            selectedPair = byId.get(transportPairId) ?? null;
          }
        }
      });

      if (!selectedPair) {
        stats.forEach((report) => {
          const r = report as RTCStats & {
            type?: string;
            selected?: boolean;
            nominated?: boolean;
            state?: string;
          };
          if (
            r.type === "candidate-pair" &&
            (r.selected || (r.nominated && r.state === "succeeded"))
          ) {
            selectedPair = report;
          }
        });
      }

      if (!selectedPair) {
        setPcDebugState((prev) =>
          prev.selectedCandidatePair === null ? prev : { ...prev, selectedCandidatePair: null },
        );
        return;
      }

      const pair = selectedPair as RTCStats & {
        localCandidateId?: string;
        remoteCandidateId?: string;
      };
      const local = pair.localCandidateId ? byId.get(pair.localCandidateId) : null;
      const remote = pair.remoteCandidateId ? byId.get(pair.remoteCandidateId) : null;
      const localAny = local as
        | (RTCStats & { candidateType?: string; ip?: string; address?: string })
        | null;
      const remoteAny = remote as
        | (RTCStats & { candidateType?: string; ip?: string; address?: string })
        | null;
      const localType = localAny?.candidateType ?? "unknown";
      const remoteType = remoteAny?.candidateType ?? "unknown";
      const localIp = localAny?.ip ?? localAny?.address ?? "unknown";
      const remoteIp = remoteAny?.ip ?? remoteAny?.address ?? "unknown";
      const next = `${localType}/${localIp} -> ${remoteType}/${remoteIp}`;
      setPcDebugState((prev) =>
        prev.selectedCandidatePair === next ? prev : { ...prev, selectedCandidatePair: next },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDebugLastError(msg);
      debugLog("getStats failed", msg);
    }
  }, [isDev, debugLog]);

  /**
   * Robustly trigger play() with retry + exponential backoff.
   * iOS Safari may reject play() for muted videos without user gesture;
   * retrying after a short delay often succeeds once the track has data.
   */
  const ensureVideoPlaying = useCallback(
    async (video: HTMLVideoElement | null, label: string) => {
      if (!video) return;
      video.playsInline = true;
      try {
        video.setAttribute("webkit-playsinline", "true");
      } catch {
        /* older browsers */
      }
      const delays = [0, 200, 800, 1500];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) {
          await new Promise<void>((r) => setTimeout(r, delays[attempt]));
        }
        if (!video.isConnected || !video.srcObject) {
          debugLog(`[play] ${label} detached or no srcObject, aborting`);
          return;
        }
        try {
          await video.play();
          debugLog(`[play] ${label} OK (attempt ${attempt + 1})`);
          return;
        } catch (err) {
          debugLog(`[play] ${label} attempt ${attempt + 1}/${delays.length} failed`, {
            readyState: video.readyState,
            paused: video.paused,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      debugLog(`[play] ${label} all attempts failed — user gesture may be needed`);
    },
    [debugLog],
  );

  /**
   * Central binding: set remoteVideoRef.current.srcObject to a **filtered**
   * MediaStream containing at most 1 video + 1 audio track.
   *
   * Safari cannot render a <video> whose srcObject has 2 video tracks —
   * it stays at readyState=0 / w=h=0 (black).  This filter is the defence.
   */
  const bindRemoteVideo = useCallback(
    (reason: string) => {
      const video = remoteVideoRef.current;
      const src = remoteStreamRef.current;
      if (!video) {
        debugLog(`[bind] ${reason}: no video el`);
        return;
      }
      if (!src || src.getTracks().length === 0) {
        debugLog(`[bind] ${reason}: no tracks yet`, getStreamInfo(src));
        return;
      }

      // Pick at most 1 video + 1 audio (prefer live).  Prevents Safari
      // 2-video-track blackout.
      const vTrack =
        src.getVideoTracks().find((t) => t.readyState === "live") ??
        src.getVideoTracks()[0];
      const aTrack =
        src.getAudioTracks().find((t) => t.readyState === "live") ??
        src.getAudioTracks()[0];
      const wanted: MediaStreamTrack[] = [];
      if (vTrack) wanted.push(vTrack);
      if (aTrack) wanted.push(aTrack);

      if (wanted.length === 0) {
        debugLog(`[bind] ${reason}: no live tracks after filter`);
        return;
      }

      debugLog(
        `[bind] ${reason}: src vTracks=${src.getVideoTracks().length}`,
        `aTracks=${src.getAudioTracks().length}`,
        `→ render [${wanted.map((t) => `${t.kind}:${t.id.slice(0, 8)}:${t.readyState}`).join(", ")}]`,
      );

      // Avoid replacing srcObject when the element already contains the exact
      // same track set (prevents unnecessary re-decode / flicker).
      const cur = video.srcObject instanceof MediaStream ? video.srcObject : null;
      if (cur) {
        const curIds = new Set(cur.getTracks().map((t) => t.id));
        if (wanted.length === curIds.size && wanted.every((t) => curIds.has(t.id))) {
          void ensureVideoPlaying(video, reason);
          return;
        }
      }

      debugLog(
        `[attach] target=big hasStream=true`,
        `tracksCount=${wanted.length}`,
        `readyState=${video.readyState}`,
      );
      video.srcObject = new MediaStream(wanted);
      video.playsInline = true;
      try {
        video.setAttribute("webkit-playsinline", "true");
      } catch {
        /* */
      }
      void ensureVideoPlaying(video, reason);
    },
    [debugLog, ensureVideoPlaying],
  );

  /**
   * Stable ref callback for the remote <video> element.
   * Using useCallback ensures React never cycles through null/el on re-render
   * (which would cause the brief window where ontrack's rebind is lost).
   */
  const setRemoteVideoEl = useCallback(
    (el: HTMLVideoElement | null) => {
      remoteVideoRef.current = el;
      if (el) {
        el.playsInline = true;
        try {
          el.setAttribute("webkit-playsinline", "true");
        } catch {
          /* */
        }
        const src = remoteStreamRef.current;
        debugLog(
          `[attach] target=big (ref-mount) hasStream=${!!src}`,
          `tracksCount=${src?.getTracks().length ?? 0}`,
          `readyState=${el.readyState}`,
        );
        bindRemoteVideo("ref-mount");
      }
    },
    [bindRemoteVideo, debugLog],
  );

  /** Stable ref callback for the local <video> element. */
  const setLocalVideoEl = useCallback(
    (el: HTMLVideoElement | null) => {
      localVideoRef.current = el;
      if (el) {
        el.playsInline = true;
        try {
          el.setAttribute("webkit-playsinline", "true");
        } catch {
          /* */
        }
        const s = localStreamRef.current;
        if (s) {
          debugLog(
            `[attach] target=small hasStream=true`,
            `tracksCount=${s.getTracks().length}`,
            `readyState=${el.readyState}`,
          );
          el.muted = true;
          el.srcObject = s;
          void ensureVideoPlaying(el, "local-ref-mount");
        }
      }
    },
    [ensureVideoPlaying, debugLog],
  );

  const ensureRecvTransceivers = useCallback(() => {
    const pc = pcRef.current;
    if (!pc || transceiversAddedRef.current) return;
    try {
      pc.addTransceiver("audio", { direction: "sendrecv" });
      pc.addTransceiver("video", { direction: "sendrecv" });
      transceiversAddedRef.current = true;
      debugLog("Added sendrecv transceivers (audio/video)");
    } catch (e) {
      debugLog("Failed to add transceivers", e);
    }
  }, [debugLog]);

  const flushPendingIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription?.type) return;
    const list = pendingIceRef.current;
    pendingIceRef.current = [];
    if (list.length > 0) {
      debugLog("[ice] Flushing pending ICE:", list.length);
    }
    for (const c of list) {
      await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
  }, [debugLog]);

  // FIX: removed sendSignal from deps — uses sendSignalRef.current instead
  const cleanup = useCallback(
    (sendHangup: boolean) => {
      if (sendHangup && roomId) {
        sendSignalRef.current({ kind: "hangup", clientId: clientIdRef.current });
      }

      if (pcRef.current) {
        if (statsTimerRef.current) {
          clearInterval(statsTimerRef.current);
          statsTimerRef.current = null;
        }
        // Detach tracks from transceiver senders before closing
        void audioTxRef.current?.sender.replaceTrack(null).catch(() => {});
        void videoTxRef.current?.sender.replaceTrack(null).catch(() => {});
        audioTxRef.current = null;
        videoTxRef.current = null;
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.onsignalingstatechange = null;
        pcRef.current.onicegatheringstatechange = null;
        pcRef.current.close();
        pcRef.current = null;
      }

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }

      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach((t) => t.stop());
        remoteStreamRef.current = null;
      }

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }

      // [drain] Halt any in-flight drain and discard stale signals
      signalQueue.splice(0);
      startedRef.current = false;
      resetSessionFlags();
      setIsMicMuted(false);
      setIsCameraOff(false);
      setState("idle");
      setError(null);
    },
    [roomId, signalQueue],
  );

  // FIX: removed sendSignal from deps
  const maybeStartNegotiation = useCallback(async () => {
    if (!roomId || !pcRef.current || !peerClientIdRef.current || negotiatedRef.current) {
      return;
    }

    const myRank = `${roomId}:${clientIdRef.current}`;
    const peerRank = `${roomId}:${peerClientIdRef.current}`;
    const iAmCaller = myRank.localeCompare(peerRank) < 0;
    isCallerRef.current = iAmCaller;
    debugLog("Caller election", {
      roomId,
      myClientId: clientIdRef.current,
      peerClientId: peerClientIdRef.current,
      iAmCaller,
    });

    if (!iAmCaller) {
      debugLog("[webrtc] I am callee, waiting for offer from", peerClientIdRef.current);
      setState("waiting_peer");
      return;
    }

    try {
      ensureRecvTransceivers();
      debugLog("[webrtc] I am caller, creating offer");
      const offer = await pcRef.current.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pcRef.current.setLocalDescription(offer);
      debugLog("[webrtc] Sending offer, sdp type=", offer.type);
      sendSignalRef.current({
        kind: "offer",
        sdp: pcRef.current.localDescription ?? offer,
        clientId: clientIdRef.current,
      });
      negotiatedRef.current = true;
      setState("calling");
    } catch (e) {
      console.error("Failed to create offer", e);
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [roomId, ensureRecvTransceivers, debugLog]);

  // FIX: removed sendSignal from deps
  const autoStart = useCallback(async () => {
    if (!enabled || !roomId || startedRef.current) return;
    startedRef.current = true;
    setState("starting");
    setError(null);
    resetSessionFlags();

    try {
      // [RTC] Guard: getUserMedia requires a secure context (HTTPS or localhost).
      // On plain HTTP over LAN, navigator.mediaDevices is undefined and would crash.
      const isBrowser = typeof window !== "undefined";
      const isSecure =
        isBrowser &&
        (globalThis.isSecureContext ||
          window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1");
      if (isBrowser && !isSecure) {
        const msg =
          "getUserMedia requires HTTPS or localhost. " +
          `Current origin: ${window.location.origin}`;
        console.error("[RTC]", msg);
        throw new Error(msg);
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        const msg =
          "navigator.mediaDevices.getUserMedia is unavailable " +
          "(likely insecure context or unsupported browser)";
        console.error("[RTC]", msg);
        throw new Error(msg);
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.muted = true;
        localVideoRef.current.playsInline = true;
        try { localVideoRef.current.setAttribute("webkit-playsinline", "true"); } catch { /* */ }
        localVideoRef.current.srcObject = stream;
        void ensureVideoPlaying(localVideoRef.current, "local");
      }

      // Don't create an empty MediaStream here — binding a 0-track stream to
      // the video element is the root cause of "Chrome remote video black":
      // if ontrack's rebind is missed (ref briefly null during React re-render),
      // the video stays bound to this empty stream forever.
      // ontrack will set remoteStreamRef.current to the browser-provided stream.
      remoteStreamRef.current = null;

      const pc = new RTCPeerConnection({
        iceServers: buildIceServers(),
      });
      pcRef.current = pc;
      updatePcDebugState();

      // Create exactly one transceiver per media kind — no addTrack().
      // addTrack() + addTransceiver() together caused double m-lines
      // → remote peer got 2 video tracks → Safari readyState=0 / black.
      audioTxRef.current = pc.addTransceiver("audio", { direction: "sendrecv" });
      videoTxRef.current = pc.addTransceiver("video", { direction: "sendrecv" });
      transceiversAddedRef.current = true;
      debugLog("Created sendrecv transceivers (audio+video)");

      const audioTrack = stream.getAudioTracks()[0] ?? null;
      const videoTrack = stream.getVideoTracks()[0] ?? null;
      if (audioTrack) await audioTxRef.current.sender.replaceTrack(audioTrack);
      if (videoTrack) await videoTxRef.current.sender.replaceTrack(videoTrack);
      debugLog("Attached local tracks via replaceTrack", {
        audio: audioTrack?.id.slice(0, 8) ?? "none",
        video: videoTrack?.id.slice(0, 8) ?? "none",
      });

      pc.ontrack = (event) => {
        debugLog("ontrack", {
          kind: event.track.kind,
          trackId: event.track.id.slice(0, 8),
          streams: event.streams.length,
        });
        setPcDebugState((prev) =>
          prev.remoteTrackReceived ? prev : { ...prev, remoteTrackReceived: true },
        );
        // Use the browser-provided stream (preferred); otherwise accumulate tracks
        if (event.streams[0]) {
          remoteStreamRef.current = event.streams[0];
        } else {
          if (!remoteStreamRef.current) {
            remoteStreamRef.current = new MediaStream();
          }
          // Dedup by track.id — prevent two ontrack calls from stacking
          // duplicate tracks (which would cause Safari 2-video blackout).
          const already = remoteStreamRef.current
            .getTracks()
            .some((t) => t.id === event.track.id);
          if (!already) {
            remoteStreamRef.current.addTrack(event.track);
          }
        }
        debugLog("[bind] ontrack stream:", getStreamInfo(remoteStreamRef.current));
        bindRemoteVideo("ontrack");
        setRemoteStreamVersion((v) => v + 1);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const c = event.candidate.candidate || "";
          const candidateType = c.match(/ typ ([a-z]+)/)?.[1] ?? "unknown";
          const candidateAddr = c.match(/candidate:\S+ \d+ \w+ \d+ ([^ ]+) \d+/)?.[1] ?? "unknown";
          const candidatePort = c.match(/candidate:\S+ \d+ \w+ \d+ [^ ]+ (\d+)/)?.[1] ?? "?";
          const candidateProtocol = c.match(/candidate:\S+ \d+ (\w+)/)?.[1] ?? "unknown";
          const summary = `${candidateType} ${candidateAddr}:${candidatePort} ${candidateProtocol}`;
          setPcDebugState((prev) =>
            prev.lastIceCandidateSummary === summary
              ? prev
              : { ...prev, lastIceCandidateSummary: summary },
          );
          debugLog("[ice] onicecandidate", { type: candidateType, addr: candidateAddr, raw: c });
          sendSignalRef.current({
            kind: "ice",
            candidate: event.candidate.toJSON(),
            clientId: clientIdRef.current,
          });
        }
      };
      pc.onconnectionstatechange = () => {
        if (!pcRef.current) return;
        updatePcDebugState();
        debugLog("connectionstatechange", pc.connectionState);
        if (pc.connectionState === "connected") {
          setState((prev) => (prev === "idle" || prev === "error" ? prev : "connected"));
          // Safety net: ensure remote video is bound to the correct stream
          bindRemoteVideo("pc-connected");
        }
        if (pc.connectionState === "failed") {
          setState("error");
          setError("WebRTC connection failed");
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (!pcRef.current) return;
        updatePcDebugState();
        debugLog("iceconnectionstatechange", pc.iceConnectionState);
        // Safari may only fire iceConnectionState without connectionState
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          setState((prev) => (prev === "idle" || prev === "error" ? prev : "connected"));
        }
      };
      pc.onsignalingstatechange = () => {
        updatePcDebugState();
        debugLog("signalingstatechange", pc.signalingState);
      };
      pc.onicegatheringstatechange = () => {
        updatePcDebugState();
        debugLog("icegatheringstatechange", pc.iceGatheringState);
      };

      // [pcReady] PC + handlers ready — kick drain for any signals
      // that arrived while getUserMedia was pending.
      setPcReadyVersion((v) => v + 1);
      debugLog("[pcReady] PC created, sending hello, myClientId=", clientIdRef.current);
      sendSignalRef.current({ kind: "hello", clientId: clientIdRef.current });
      await maybeStartNegotiation();
    } catch (e) {
      console.error("Failed to start media", e);
      const errName = e && typeof e === "object" && "name" in e ? String(e.name) : "";
      if (errName === "NotAllowedError") {
        setError("Camera/Mic permission denied");
      } else if (errName === "NotFoundError") {
        setError("No camera/mic device found");
      } else {
        setError(e instanceof Error ? e.message : "Failed to access camera/microphone");
      }
      setState("error");
      startedRef.current = false;
    }
  }, [
    enabled,
    roomId,
    maybeStartNegotiation,
    updatePcDebugState,
    debugLog,
    buildIceServers,
    ensureVideoPlaying,
    bindRemoteVideo,
  ]);

  // Main effect: start/stop RTC based on enabled + roomId
  useEffect(() => {
    if (enabled && roomId) {
      void autoStart();
      return;
    }
    cleanup(false);
  }, [enabled, roomId, autoStart, cleanup]);

  // ── Serialized signal drain ────────────────────────────────────
  //
  // Invariants:
  //   A) Only one drain loop runs at a time (processingRef mutex).
  //   B) If PC is not ready we return WITHOUT consuming the queue;
  //      pcReadyVersion will re-trigger once autoStart completes.
  //   C) FIFO: shift() one signal at a time.
  //   D) If new signals arrive while we're awaiting SDP ops they
  //      accumulate in the queue.  The while-loop picks them up on
  //      the next iteration.  If the loop finishes with leftovers
  //      (edge case), drainTrigger kicks another cycle.
  //
  // Triggers: signalVersion (new WS message)
  //           pcReadyVersion (PC just created after getUserMedia)
  //           drainTrigger   (self-kick after async drain finishes)
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !roomId) return;
    if (processingRef.current) {
      // Another drain loop is in flight — it will pick up new items
      return;
    }
    if (!pcRef.current) {
      // PC not ready yet (getUserMedia pending).  Leave signals in the
      // queue; pcReadyVersion will fire this effect once PC exists.
      if (signalQueue.length > 0) {
        debugLog("[drain] PC not ready, deferring", signalQueue.length, "queued signals");
      }
      return;
    }
    if (signalQueue.length === 0) return;

    processingRef.current = true;
    debugLog("[drain] start, queue length=", signalQueue.length);

    const drain = async () => {
      try {
        while (signalQueue.length > 0) {
          // Re-check PC on every iteration — cleanup() may null it
          const pc = pcRef.current;
          if (!pc) {
            debugLog("[drain] PC gone mid-drain, stopping");
            break;
          }

          const raw = signalQueue.shift()!;

          // Unwrap nested .signal if present (legacy compat)
          const sig: RtcSignalPayload =
            ((raw as unknown as { signal?: RtcSignalPayload })?.signal as
              | RtcSignalPayload
              | undefined) ?? raw;
          if (!sig) continue;

          // Skip self-echo (group_send broadcasts to sender too)
          if (sig.clientId && sig.clientId === clientIdRef.current) continue;

          // Dedup — same payload as the last processed signal
          const signalKey = JSON.stringify(sig);
          if (processedSignalKeyRef.current === signalKey) continue;
          processedSignalKeyRef.current = signalKey;

          try {
            if (sig.clientId && sig.clientId !== clientIdRef.current) {
              peerClientIdRef.current = sig.clientId;
            }

            debugLog("[drain] processing", sig.kind, "from", sig.clientId);

            if (sig.kind === "hello") {
              await maybeStartNegotiation();
              continue;
            }

            if (sig.kind === "offer" && sig.sdp) {
              if (pc.signalingState === "have-local-offer") {
                debugLog("[drain] Ignoring offer — local offer already sent (glare)");
                continue;
              }
              debugLog("[drain] setRemoteDescription(offer)");
              await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
              await flushPendingIce();
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              debugLog("[drain] sending answer");
              sendSignalRef.current({
                kind: "answer",
                sdp: pc.localDescription ?? answer,
                clientId: clientIdRef.current,
              });
              negotiatedRef.current = true;
              continue;
            }

            if (sig.kind === "answer" && sig.sdp) {
              if (pc.signalingState !== "have-local-offer") continue;
              debugLog("[drain] setRemoteDescription(answer)");
              await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
              await flushPendingIce();
              negotiatedRef.current = true;
              setState("connected");
              continue;
            }

            if (sig.kind === "ice" && sig.candidate) {
              if (!pc.remoteDescription?.type) {
                pendingIceRef.current.push(sig.candidate);
                debugLog("[ice] Queued (no remote desc), pending:", pendingIceRef.current.length);
                continue;
              }
              await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch((iceErr) => {
                debugLog("[ice] addIceCandidate failed (ignored)", iceErr);
              });
              continue;
            }

            if (sig.kind === "hangup") {
              cleanup(false);
              break; // cleanup destroys PC, stop draining
            }
          } catch (e) {
            console.error("[RTC][drain] signal handling error", e);
            setError(e instanceof Error ? e.message : String(e));
            setState("error");
          }
        }
      } finally {
        processingRef.current = false;
        debugLog("[drain] end, remaining=", signalQueue.length);
        // If new signals arrived while we were awaiting async SDP ops,
        // kick another drain cycle via microtask so the effect re-fires.
        if (signalQueue.length > 0 && pcRef.current) {
          queueMicrotask(() => setDrainTrigger((v) => v + 1));
        }
      }
    };

    void drain();
  }, [
    signalVersion,
    pcReadyVersion,
    drainTrigger,
    enabled,
    roomId,
    signalQueue,
    maybeStartNegotiation,
    cleanup,
    flushPendingIce,
    debugLog,
  ]);

  // ── Stream ↔ video-element reactive sync ──────────────────────
  // Safari may fire ontrack before the remote <video> ref is committed
  // by React, so the imperative bindRemoteVideo("ontrack") finds
  // remoteVideoRef.current === null and silently skips.  This effect
  // runs AFTER React's commit phase (refs are set) whenever a new
  // track arrives (remoteStreamVersion bumps), guaranteeing the bind.
  useEffect(() => {
    if (!enabled || !roomId) return;
    bindRemoteVideo("stream-effect");
    // Local video safety net (handles remount after autoStart)
    const lv = localVideoRef.current;
    const ls = localStreamRef.current;
    if (lv && ls) {
      const cur = lv.srcObject instanceof MediaStream ? lv.srcObject : null;
      if (cur !== ls) {
        debugLog(
          `[attach] target=small hasStream=true`,
          `tracksCount=${ls.getTracks().length}`,
          `readyState=${lv.readyState}`,
        );
        lv.muted = true;
        lv.srcObject = ls;
        void ensureVideoPlaying(lv, "local-effect");
      }
    }
  }, [remoteStreamVersion, enabled, roomId, bindRemoteVideo, debugLog, ensureVideoPlaying]);

  // DEV: periodic stats polling
  useEffect(() => {
    if (!isDev) return;
    const shouldPoll =
      state === "starting" || state === "waiting_peer" || state === "calling" || state === "connected";
    if (!shouldPoll || !pcRef.current) {
      if (statsTimerRef.current) {
        clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
      return;
    }
    if (!statsTimerRef.current) {
      statsTimerRef.current = setInterval(() => {
        void updateSelectedCandidatePair();
      }, 1000);
    }
    return () => {
      if (statsTimerRef.current) {
        clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
    };
  }, [isDev, state, updateSelectedCandidatePair]);

  const hangup = useCallback(() => {
    cleanup(true);
  }, [cleanup]);

  const reconnect = useCallback(() => {
    cleanup(false);
    if (enabled && roomId) {
      void autoStart();
    }
  }, [cleanup, enabled, roomId, autoStart]);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !isMicMuted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setIsMicMuted(nextMuted);
  }, [isMicMuted]);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextCameraOff = !isCameraOff;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !nextCameraOff;
    });
    setIsCameraOff(nextCameraOff);
  }, [isCameraOff]);

  /** User-gesture-safe: rebind + re-trigger play() on both video elements. */
  const ensureRemotePlay = useCallback(() => {
    void ensureVideoPlaying(localVideoRef.current, "local-gesture");
    bindRemoteVideo("user-gesture");
  }, [ensureVideoPlaying, bindRemoteVideo]);

  return {
    state,
    error,
    isMicMuted,
    isCameraOff,
    localVideoRef, // still needed by SignModule
    setLocalVideoEl,
    setRemoteVideoEl,
    hangup,
    reconnect,
    toggleMic,
    toggleCamera,
    ensureRemotePlay,
    debugInfo:
      isDev
        ? {
            myClientId: clientIdRef.current,
            peerClientId: peerClientIdRef.current,
            isCaller: isCallerRef.current,
            connectionState: pcDebugState.connectionState,
            iceConnectionState: pcDebugState.iceConnectionState,
            signalingState: pcDebugState.signalingState,
            iceGatheringState: pcDebugState.iceGatheringState,
            selectedCandidatePair: pcDebugState.selectedCandidatePair,
            lastIceCandidateSummary: pcDebugState.lastIceCandidateSummary,
            remoteTrackReceived: pcDebugState.remoteTrackReceived,
            lastError: debugLastError ?? error,
          }
        : undefined,
  };
}
