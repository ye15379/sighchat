"use client";

import { useState } from "react";
import { useMatchSocket } from "../../lib/useMatchSocket";

export default function MatchTestPage() {
  const {
    status,
    phase,
    roomId,
    draftRegion,
    activeRegionKey,
    setDraftRegion,
    findRandom,
    findRegion,
    cancel,
    sendChat,
    messages,
  } = useMatchSocket();

  const [chatInput, setChatInput] = useState("");

  const handleSendChat = () => {
    if (!chatInput.trim()) return;
    sendChat(chatInput);
    setChatInput("");
  };

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "40px auto",
        padding: "24px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>Match Test</h1>
      <p style={{ marginBottom: "1rem", color: "#555" }}>
        WebSocket endpoint: <code>ws://localhost:8000/ws/match/</code>
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <span>
          Status:{" "}
          <strong>
            {status === "connected"
              ? "connected"
              : status === "connecting"
              ? "connecting..."
              : "disconnected"}
          </strong>
        </span>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <span>
          Phase: <strong>{phase}</strong>
        </span>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <span>
          Active region: <strong>{activeRegionKey}</strong>
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: "1rem",
        }}
      >
        <label style={{ fontSize: 14 }}>
          Region:{" "}
          <input
            type="text"
            value={draftRegion}
            onChange={(e) => setDraftRegion(e.target.value)}
            style={{
              padding: "6px 8px",
              borderRadius: 4,
              border: "1px solid #ddd",
              width: 100,
            }}
          />
        </label>

        <button
          type="button"
          onClick={findRandom}
          style={{
            padding: "6px 10px",
            borderRadius: 4,
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
            padding: "6px 10px",
            borderRadius: 4,
            border: "none",
            backgroundColor: "#7c3aed",
            color: "white",
            cursor: "pointer",
          }}
        >
          Find Region
        </button>

        <button
          type="button"
          onClick={cancel}
          style={{
            padding: "6px 10px",
            borderRadius: 4,
            border: "none",
            backgroundColor: "#f97316",
            color: "white",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <strong>Current room:</strong> <code>{roomId ?? "(not matched yet)"}</code>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: "1rem",
        }}
      >
        <input
          type="text"
          placeholder="Chat message"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          style={{
            flex: 1,
            padding: "6px 8px",
            borderRadius: 4,
            border: "1px solid #ddd",
          }}
        />
        <button
          type="button"
          onClick={handleSendChat}
          style={{
            padding: "6px 10px",
            borderRadius: 4,
            border: "none",
            backgroundColor: "#16a34a",
            color: "white",
            cursor: "pointer",
          }}
        >
          Send Chat
        </button>
      </div>

      <div>
        <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Events / Messages</h2>
        <div
          style={{
            maxHeight: 320,
            overflowY: "auto",
            border: "1px solid #e5e7eb",
            borderRadius: 4,
            padding: 8,
            backgroundColor: "#f9fafb",
            fontSize: "0.9rem",
          }}
        >
          {messages.length === 0 ? (
            <div style={{ color: "#9ca3af" }}>(no messages yet)</div>
          ) : (
            messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  padding: "4px 0",
                  borderBottom:
                    idx === messages.length - 1 ? "none" : "1px solid #e5e7eb",
                }}
              >
                {m.kind === "system" ? (
                  <span style={{ color: "#6b7280" }}>{m.text}</span>
                ) : (
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {JSON.stringify(m.payload)}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

