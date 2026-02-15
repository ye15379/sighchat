"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMatchSocket } from "../../lib/useMatchSocket";
import { useRoomRtc } from "../../lib/useRoomRtc";
import { VideoCallPanel } from "../../components/VideoCallPanel";
import { SignModule } from "../../components/SignModule";

const PRESET_REGIONS = ["AU", "US", "CN", "GLOBAL"] as const;
type RegionMode = (typeof PRESET_REGIONS)[number] | "CUSTOM";

export default function MatchPage() {
  const {
    status,
    phase,
    roomId,
    notice,
    draftRegion,
    activeRegionKey,
    setDraftRegion,
    findRandom,
    findRegion,
    cancel,
    sendChat,
    sendRtcSignal,
    rtcSignalQueue,
    rtcSignalVersion,
    clearNotice,
    debugSimulateClose,
    messages,
  } = useMatchSocket();

  const [regionMode, setRegionMode] = useState<RegionMode>("AU");
  const [customRegion, setCustomRegion] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});

  const rtc = useRoomRtc({
    enabled: phase === "in_room" && !!roomId,
    roomId: roomId ?? null,
    sendSignal: sendRtcSignal,
    signalQueue: rtcSignalQueue,
    signalVersion: rtcSignalVersion,
  });

  const messagesBoxRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // 仅当 draftRegion 为空时初始化
  useEffect(() => {
    if (!draftRegion) {
      setDraftRegion("AU");
    }
  }, [draftRegion, setDraftRegion]);

  useEffect(() => {
    if (atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  const onRegionModeChange = (nextMode: RegionMode) => {
    setRegionMode(nextMode);
    if (nextMode === "CUSTOM") {
      const nextCustom = customRegion || draftRegion || "";
      if (!customRegion) setCustomRegion(nextCustom);
      setDraftRegion(nextCustom);
      return;
    }
    setDraftRegion(nextMode);
  };

  const onCustomRegionChange = (value: string) => {
    setCustomRegion(value);
    setDraftRegion(value);
  };

  const onSendChat = () => {
    if (!chatInput.trim()) return;
    sendChat(chatInput);
    setChatInput("");
  };

  const onChatKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSendChat();
    }
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString("en-US", { hour12: false });

  const isSearching = phase === "connecting" || phase === "queued";
  const inRoom = phase === "in_room" && !!roomId;
  const idle = phase === "idle";
  const isDev = process.env.NODE_ENV === "development";

  return (
    <main
      style={{
        maxWidth: 760,
        margin: "32px auto",
        padding: "20px",
        fontFamily:
          "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>SignChat</h1>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          backgroundColor: "#fafafa",
        }}
      >
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 14 }}>
          <span>
            Status: <strong>{status}</strong>
          </span>
          <span>
            Phase: <strong>{phase}</strong>
          </span>
          <span>
            Active region: <strong>{activeRegionKey}</strong>
          </span>
          <span>
            Draft region: <strong>{draftRegion || "(empty)"}</strong>
          </span>
          <span>
            Room: <strong>{roomId ?? "-"}</strong>
          </span>
        </div>
      </section>

      {isDev && (
        <section
          style={{
            border: "1px dashed #d1d5db",
            borderRadius: 8,
            padding: 10,
            marginBottom: 16,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => debugSimulateClose?.(1000, "cancel")}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            Sim Cancel Close
          </button>
          <button
            type="button"
            onClick={() => debugSimulateClose?.(1000, "region_reset")}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            Sim Region Reset Close
          </button>
          <button
            type="button"
            onClick={() => debugSimulateClose?.(1000, null)}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            Sim Real Disconnect
          </button>
          <button
            type="button"
            onClick={() => debugSimulateClose?.(4401, null)}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            Sim 4401
          </button>
        </section>
      )}

      {notice && (
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: 10,
            marginBottom: 16,
            backgroundColor:
              notice.level === "error"
                ? "#fef2f2"
                : notice.level === "warning"
                ? "#fffbeb"
                : notice.level === "success"
                ? "#f0fdf4"
                : "#eff6ff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 14 }}>{notice.text}</span>
          <button
            type="button"
            onClick={clearNotice}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "#6b7280",
              fontSize: 16,
              lineHeight: 1,
            }}
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </section>
      )}

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 14 }}>
            Region:
            <select
              value={regionMode}
              onChange={(e) => onRegionModeChange(e.target.value as RegionMode)}
              style={{
                marginLeft: 8,
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid #d1d5db",
                backgroundColor: "white",
              }}
            >
              {PRESET_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="CUSTOM">CUSTOM</option>
            </select>
          </label>

          {regionMode === "CUSTOM" && (
            <input
              type="text"
              placeholder="Custom region"
              value={customRegion}
              onChange={(e) => onCustomRegionChange(e.target.value)}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid #d1d5db",
                minWidth: 140,
              }}
            />
          )}
        </div>
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {idle && (
          <>
            <button
              type="button"
              onClick={findRandom}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "none",
                backgroundColor: "#2563eb",
                color: "white",
                cursor: "pointer",
              }}
            >
              Find Random
            </button>
            <button
              type="button"
              onClick={findRegion}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "none",
                backgroundColor: "#7c3aed",
                color: "white",
                cursor: "pointer",
              }}
            >
              Find Region
            </button>
          </>
        )}

        {isSearching && (
          <>
            <button
              type="button"
              disabled
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "none",
                backgroundColor: "#9ca3af",
                color: "white",
                cursor: "not-allowed",
              }}
            >
              Searching...
            </button>
            <button
              type="button"
              onClick={cancel}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "none",
                backgroundColor: "#f97316",
                color: "white",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </>
        )}

        {inRoom && (
          <>
            <button
              type="button"
              onClick={cancel}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "none",
                backgroundColor: "#ef4444",
                color: "white",
                cursor: "pointer",
              }}
            >
              Leave
            </button>
            <input
              type="text"
              placeholder="Type message..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={onChatKeyDown}
              style={{
                flex: 1,
                minWidth: 220,
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid #d1d5db",
              }}
            />
            <button
              type="button"
              onClick={onSendChat}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "none",
                backgroundColor: "#16a34a",
                color: "white",
                cursor: "pointer",
              }}
            >
              Send
            </button>
          </>
        )}
      </section>

      <section
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 420px", minWidth: 320 }}>
          <VideoCallPanel
            setLocalVideoEl={rtc.setLocalVideoEl}
            setRemoteVideoEl={rtc.setRemoteVideoEl}
            rtcState={rtc.state}
            rtcError={rtc.error}
            onHangup={rtc.hangup}
            onReconnect={rtc.reconnect}
            onToggleMic={rtc.toggleMic}
            onToggleCamera={rtc.toggleCamera}
            isMicMuted={rtc.isMicMuted}
            isCameraOff={rtc.isCameraOff}
            inRoom={inRoom}
            onEnsurePlay={rtc.ensureRemotePlay}
            rtcDebug={rtc.debugInfo}
          />

          <SignModule enabled={inRoom} localVideoRef={rtc.localVideoRef} />
        </div>

        <div style={{ flex: "1 1 360px", minWidth: 320 }}>
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: 12,
              backgroundColor: "#f9fafb",
            }}
          >
            <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>Messages</h2>
            <div
              ref={messagesBoxRef}
              onScroll={() => {
                const el = messagesBoxRef.current;
                if (!el) return;
                atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
              }}
              style={{ maxHeight: 560, overflowY: "auto" }}
            >
              {messages.length === 0 ? (
                <div style={{ color: "#9ca3af" }}>(no messages yet)</div>
              ) : (
                messages.map((m, idx) => (
                  <div
                    key={m.id}
                    style={{
                      padding: "6px 0",
                      borderBottom: idx === messages.length - 1 ? "none" : "1px solid #e5e7eb",
                    }}
                  >
                    {m.kind === "system" ? (
                      <span style={{ color: "#6b7280" }}>
                        [{formatTime(m.ts)}] {m.text}
                      </span>
                    ) : (
                      <>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span style={{ color: "#374151" }}>
                            [{formatTime(m.ts)}] EVENT {m.payload?.type ?? "unknown"}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedEvents((prev) => ({
                                ...prev,
                                [m.id]: !prev[m.id],
                              }))
                            }
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "#2563eb",
                              cursor: "pointer",
                              padding: 0,
                              fontSize: 12,
                            }}
                          >
                            {expandedEvents[m.id] ? "Hide" : "Show"}
                          </button>
                        </div>
                        {expandedEvents[m.id] && (
                          <pre
                            style={{
                              margin: "6px 0 0 0",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {JSON.stringify(m.payload, null, 2)}
                          </pre>
                        )}
                      </>
                    )}
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

