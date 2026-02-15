"use client";

import { useEffect, useState } from "react";

type VideoCallPanelProps = {
  /** Stable ref callback for the local <video> element. */
  setLocalVideoEl: (el: HTMLVideoElement | null) => void;
  /** Stable ref callback for the remote <video> element. */
  setRemoteVideoEl: (el: HTMLVideoElement | null) => void;
  rtcState: string;
  rtcError?: string | null;
  onHangup: () => void;
  onReconnect: () => void;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  isMicMuted: boolean;
  isCameraOff: boolean;
  inRoom: boolean;
  onEnsurePlay?: () => void;
  rtcDebug?: {
    myClientId: string;
    peerClientId: string | null;
    isCaller: boolean | null;
    connectionState: string;
    iceConnectionState: string;
    signalingState: string;
    iceGatheringState: string;
    selectedCandidatePair: string | null;
    lastIceCandidateSummary: string;
    remoteTrackReceived: boolean;
    lastError: string | null;
  };
};

export function VideoCallPanel({
  setLocalVideoEl,
  setRemoteVideoEl,
  rtcState,
  rtcError,
  onHangup,
  onReconnect,
  onToggleMic,
  onToggleCamera,
  isMicMuted,
  isCameraOff,
  inRoom,
  onEnsurePlay,
  rtcDebug,
}: VideoCallPanelProps) {
  const [remoteMuted, setRemoteMuted] = useState(true);
  const [debugMyClientId, setDebugMyClientId] = useState<string>("");
  const [debugPeerClientId, setDebugPeerClientId] = useState<string>("");
  const isDev = process.env.NODE_ENV === "development";

  useEffect(() => {
    setDebugMyClientId(rtcDebug?.myClientId ?? "");
    setDebugPeerClientId(rtcDebug?.peerClientId ?? "");
  }, [rtcDebug?.myClientId, rtcDebug?.peerClientId]);

  return (
    <section
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: 12,
        marginBottom: 16,
        backgroundColor: "#f9fafb",
      }}
    >
      <div style={{ marginBottom: 8, fontSize: 14 }}>
        Video: <strong>{inRoom ? "Auto" : "Idle"}</strong> ({rtcState})
        {rtcError ? (
          <span style={{ marginLeft: 8, color: "#dc2626" }}>
            {rtcError}
            {rtcError === "Camera/Mic permission denied"
              ? " - allow camera/mic permission in browser."
              : rtcError === "No camera/mic device found"
              ? " - please connect camera/mic device."
              : ""}
          </span>
        ) : null}
      </div>

      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#111827",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <video
          ref={setRemoteVideoEl}
          autoPlay
          muted={remoteMuted}
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        {!inRoom && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#d1d5db",
              fontSize: 14,
            }}
          >
            Waiting for peer video...
          </div>
        )}
        <video
          ref={setLocalVideoEl}
          autoPlay
          muted
          playsInline
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            width: 160,
            height: 90,
            background: "#000",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.2)",
            objectFit: "cover",
          }}
        />
      </div>

      {inRoom && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <button
            type="button"
            onClick={onHangup}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#6b7280",
              color: "white",
              cursor: "pointer",
            }}
          >
            Hang Up
          </button>
          <button
            type="button"
            onClick={() => {
              onReconnect();
              onEnsurePlay?.();
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#0ea5e9",
              color: "white",
              cursor: "pointer",
            }}
          >
            Reconnect
          </button>
          <button
            type="button"
            onClick={() => {
              setRemoteMuted((v) => !v);
              onEnsurePlay?.();
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#1d4ed8",
              color: "white",
              cursor: "pointer",
            }}
          >
            {remoteMuted ? "Tap to Unmute" : "Mute Remote"}
          </button>
          <button
            type="button"
            onClick={onToggleMic}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#374151",
              color: "white",
              cursor: "pointer",
            }}
          >
            {isMicMuted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            onClick={onToggleCamera}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#374151",
              color: "white",
              cursor: "pointer",
            }}
          >
            {isCameraOff ? "Camera On" : "Camera Off"}
          </button>
        </div>
      )}

      {isDev && rtcDebug && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 6,
            border: "1px dashed #d1d5db",
            fontSize: 12,
            color: "#374151",
            backgroundColor: "#fff",
          }}
        >
          <div>myClientId: {debugMyClientId || "—"}</div>
          <div>peerClientId: {debugPeerClientId || "—"}</div>
          <div>isCaller: {String(rtcDebug.isCaller)}</div>
          <div>pc.connectionState: {rtcDebug.connectionState}</div>
          <div>pc.iceConnectionState: {rtcDebug.iceConnectionState}</div>
          <div>pc.signalingState: {rtcDebug.signalingState}</div>
          <div>pc.iceGatheringState: {rtcDebug.iceGatheringState}</div>
          <div>selectedCandidatePair: {rtcDebug.selectedCandidatePair ?? "-"}</div>
          <div>lastIceCandidate: {rtcDebug.lastIceCandidateSummary || "-"}</div>
          <div>remoteTrackReceived: {String(rtcDebug.remoteTrackReceived)}</div>
          <div>lastError: {rtcDebug.lastError ?? "-"}</div>
        </div>
      )}
    </section>
  );
}

