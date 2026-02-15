"use client";

import { useState, type RefObject } from "react";

type SignResult = {
  transcript: string;
  confidence: number;
  emotion?: string;
  latencyMs: number;
} | null;

type SignModuleProps = {
  enabled: boolean;
  localVideoRef: RefObject<HTMLVideoElement | null>;
};

export function SignModule({ enabled, localVideoRef }: SignModuleProps) {
  const [signMode, setSignMode] = useState(false);
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<SignResult>(null);
  const [error, setError] = useState<string | null>(null);

  const captureTwoSeconds = async () => {
    if (!enabled || !signMode || recording) return;
    setError(null);
    setRecording(true);
    setResult(null);

    try {
      const stream = localVideoRef.current?.srcObject as MediaStream | null;
      if (!stream) {
        throw new Error("No local media stream");
      }

      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      recorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) chunks.push(evt.data);
      };

      const blobPromise = new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      });

      recorder.start();
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 2000);

      const blob = await blobPromise;
      const formData = new FormData();
      formData.append("file", blob, "sign.webm");

      const res = await fetch("/api/sign/recognize", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Recognition failed: ${res.status}`);
      }

      const json = (await res.json()) as {
        transcript: string;
        confidence: number;
        emotion?: string;
        latencyMs: number;
      };
      setResult(json);
    } catch (e) {
      console.error(e);
      setError("Failed to capture/recognize sign segment");
    } finally {
      setRecording(false);
    }
  };

  return (
    <section
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: 12,
        backgroundColor: "#f9fafb",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 14 }}>
          <input
            type="checkbox"
            checked={signMode}
            onChange={(e) => setSignMode(e.target.checked)}
            disabled={!enabled}
            style={{ marginRight: 6 }}
          />
          Sign Mode
        </label>
        {!enabled && <span style={{ fontSize: 12, color: "#6b7280" }}>Join a room to enable sign mode</span>}
      </div>

      <button
        type="button"
        onClick={captureTwoSeconds}
        disabled={!enabled || !signMode || recording}
        style={{
          padding: "8px 12px",
          borderRadius: 6,
          border: "none",
          backgroundColor: !enabled || !signMode || recording ? "#9ca3af" : "#2563eb",
          color: "white",
          cursor: !enabled || !signMode || recording ? "not-allowed" : "pointer",
        }}
      >
        {recording ? "Recording..." : "Capture 2s"}
      </button>

      {result && (
        <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
          <div>
            transcript: <strong>{result.transcript}</strong>
          </div>
          <div>confidence: {result.confidence}</div>
          {result.emotion ? <div>emotion: {result.emotion}</div> : null}
          <div>latencyMs: {result.latencyMs}</div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, fontSize: 13, color: "#dc2626" }}>{error}</div>
      )}
    </section>
  );
}

