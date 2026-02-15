"use client";

import { useEffect, useRef, useState } from "react";
import { ensureSession } from "../../lib/session";

export default function WsTestPage() {
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected",
  );
  const [input, setInput] = useState("");
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  const connect = async () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) return;

    const t = token ?? (await ensureSession("GLOBAL", "en"));
    if (!t) return;
    setToken(t);

    setStatus("connecting");
    const ws = new WebSocket(
      `ws://localhost:8000/ws/echo/?token=${encodeURIComponent(t)}`,
    );
    socketRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
    };

    ws.onclose = (event) => {
      setStatus("disconnected");
      if (event.code === 4401) {
        setLastMessage("WebSocket auth failed (4401)");
      }
    };

    ws.onerror = () => {
      setStatus("disconnected");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLastMessage(JSON.stringify(data, null, 2));
      } catch {
        setLastMessage(event.data);
      }
    };
  };

  const send = () => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      alert("WebSocket not connected");
      return;
    }

    const payload = {
      message: input || "hello",
    };

    socketRef.current.send(JSON.stringify(payload));
  };

  return (
    <main
      style={{
        maxWidth: 640,
        margin: "40px auto",
        padding: "24px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>WebSocket Echo Test</h1>
      <p style={{ marginBottom: "1rem", color: "#555" }}>
        Backend WebSocket: <code>ws://localhost:8000/ws/echo/</code>
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={connect}
          style={{
            padding: "8px 16px",
            borderRadius: 4,
            border: "none",
            backgroundColor: "#2563eb",
            color: "white",
            cursor: "pointer",
          }}
        >
          Connect
        </button>
        <span style={{ marginLeft: 12 }}>
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
        <input
          type="text"
          placeholder='Type message, will send as {"message": "<text>"}'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{
            width: "70%",
            padding: "8px",
            borderRadius: 4,
            border: "1px solid #ddd",
            marginRight: 8,
          }}
        />
        <button
          type="button"
          onClick={send}
          style={{
            padding: "8px 16px",
            borderRadius: 4,
            border: "none",
            backgroundColor: "#16a34a",
            color: "white",
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </div>

      <div>
        <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Last echo</h2>
        <pre
          style={{
            minHeight: 80,
            padding: 12,
            backgroundColor: "#f3f4f6",
            borderRadius: 4,
            fontSize: "0.9rem",
            overflowX: "auto",
          }}
        >
          {lastMessage ?? "(no messages yet)"}
        </pre>
      </div>
    </main>
  );
}

