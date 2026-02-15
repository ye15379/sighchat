"use client";

import { useEffect, useRef, useState } from "react";
import { ensureSession } from "./session";

export type MessageItem =
  | { id: string; ts: number; kind: "system"; text: string }
  | { id: string; ts: number; kind: "event"; payload: any };
type MessageDraft =
  | { kind: "system"; text: string }
  | { kind: "event"; payload: any };

export type Phase = "idle" | "connecting" | "queued" | "in_room";
export type Notice = {
  level: "info" | "success" | "warning" | "error";
  text: string;
} | null;
type FindMode = "random" | "region";
type CloseReason = null | "cancel" | "region_reset";
export type RtcSignalPayload = {
  kind: "hello" | "offer" | "answer" | "ice" | "hangup";
  clientId?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export function useMatchSocket(): {
  status: "disconnected" | "connecting" | "connected";
  phase: Phase;
  roomId: string | null;
  notice: Notice;
  rtcSignalQueue: RtcSignalPayload[];
  rtcSignalVersion: number;

  draftRegion: string;
  activeRegionKey: string;
  setDraftRegion: (v: string) => void;

  findRandom: () => Promise<void>;
  findRegion: () => Promise<void>;
  cancel: () => void;
  sendChat: (message: string) => void;
  sendRtcSignal: (signal: RtcSignalPayload) => void;
  clearNotice: () => void;
  debugSimulateClose?: (
    eventCode?: number,
    reason?: "cancel" | "region_reset" | null,
  ) => void;

  messages: MessageItem[];
} {
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected",
  );
  const [draftRegion, setDraftRegion] = useState("AU");
  const [activeRegion, setActiveRegion] = useState("AU");
  const [phase, setPhase] = useState<Phase>("idle");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  // [webrtc] Use a queue + counter instead of a single state value.
  // React state only keeps the last value; if multiple rtc_signal messages
  // arrive in the same tick (e.g. self-echo + peer signal via group_send),
  // intermediate signals are lost.  A monotonic counter forces the
  // signal-handler effect in useRoomRtc to re-run for every enqueued signal.
  const rtcSignalQueueRef = useRef<RtcSignalPayload[]>([]);
  const [rtcSignalVersion, setRtcSignalVersion] = useState(0);
  const [tokenByRegion, setTokenByRegion] = useState<Record<string, string | null>>({});

  const socketRef = useRef<WebSocket | null>(null);
  const pendingQueueRef = useRef<any[]>([]);
  const pendingFindRef = useRef<{ mode: FindMode; regionKey: string } | null>(null);
  const closeReasonRef = useRef<CloseReason>(null);
  const messageIdRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase>("idle");

  const activeRegionKey = (activeRegion || "AU").trim().toUpperCase() || "AU";

  const appendMessage = (msg: MessageDraft) => {
    const entry: MessageItem =
      msg.kind === "system"
        ? {
            kind: "system",
            text: msg.text,
            id: `m_${Date.now()}_${messageIdRef.current++}`,
            ts: Date.now(),
          }
        : {
            kind: "event",
            payload: msg.payload,
            id: `m_${Date.now()}_${messageIdRef.current++}`,
            ts: Date.now(),
          };
    setMessages((prev) => [...prev, entry]);
  };

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      socketRef.current?.close();
    };
  }, []);

  const canFind = () => {
    if (phase === "connecting" || phase === "queued") {
      appendMessage({
        kind: "system",
        text: "Already searching for a match. Please wait or Cancel first.",
      });
      return false;
    }
    if (phase === "in_room" || roomId) {
      appendMessage({
        kind: "system",
        text: "Already in a room. Please Cancel before finding a new match.",
      });
      return false;
    }
    return true;
  };

  const getOrCreateToken = async (regionKey: string) => {
    const existing = tokenByRegion[regionKey];
    if (existing) return existing;

    const t = await ensureSession(regionKey, "en");
    if (!t) return null;

    setTokenByRegion((prev) => ({ ...prev, [regionKey]: t }));
    return t;
  };

  const queueOrSend = (payload: any) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return;
    }
    pendingQueueRef.current.push(payload);
  };

  const getWsUrl = (token: string) => {
    const isBrowser = typeof window !== "undefined";
    const protocol =
      isBrowser && window.location.protocol === "https:" ? "wss" : "ws";
    const wsPort = protocol === "wss" ? 8001 : 8000;
    const hostname = isBrowser ? window.location.hostname : "localhost";
    return `${protocol}://${hostname}:${wsPort}/ws/match/?token=${encodeURIComponent(token)}`;
  };

  // 统一 close 分支的状态与 notice 决策，供真实 onclose 与 DEV 模拟复用
  const handleClose = (eventCode: number, reason: CloseReason) => {
    setStatus("disconnected");
    setPhase("idle");
    setRoomId(null);
    socketRef.current = null;
    pendingQueueRef.current = [];

    if (eventCode === 4401) {
      setNotice({ level: "error", text: "Auth failed. Please try again." });
      appendMessage({ kind: "system", text: "WebSocket auth failed (4401)" });
    } else if (reason !== "cancel" && reason !== "region_reset") {
      setNotice({ level: "warning", text: "Disconnected." });
      appendMessage({ kind: "system", text: "WebSocket disconnected" });
    } else {
      appendMessage({ kind: "system", text: "WebSocket disconnected" });
    }
  };

  const ensureConnected = (tokenForWs: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      return;
    }
    if (socketRef.current && socketRef.current.readyState === WebSocket.CONNECTING) {
      return;
    }

    setStatus("connecting");
    setPhase("connecting");

    const ws = new WebSocket(getWsUrl(tokenForWs));
    socketRef.current = ws;
    appendMessage({ kind: "system", text: `WebSocket url: ${ws.url}` });

    ws.onopen = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setStatus("connected");
      setNotice({ level: "info", text: "Connected" });
      appendMessage({ kind: "system", text: "WebSocket connected" });

      while (pendingQueueRef.current.length > 0) {
        const payload = pendingQueueRef.current[0];
        try {
          ws.send(JSON.stringify(payload));
          pendingQueueRef.current.shift();
        } catch {
          break;
        }
      }
    };

    ws.onclose = (event) => {
      const reason = closeReasonRef.current;
      closeReasonRef.current = null;
      const prevPhase = phaseRef.current;
      handleClose(event.code, reason);
      appendMessage({
        kind: "system",
        text: `WebSocket closed (code=${event.code}${
          event.reason ? `, reason=${event.reason}` : ""
        })`,
      });

      if (
        event.code !== 4401 &&
        reason !== "cancel" &&
        reason !== "region_reset" &&
        prevPhase !== "idle" &&
        !retryTimerRef.current
      ) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          void (async () => {
            if (phaseRef.current === "idle") return;
            const token = await getOrCreateToken(activeRegionKey);
            if (!token) return;
            ensureConnected(token);
          })();
        }, 1000);
      }
    };

    ws.onerror = () => {
      const reason = closeReasonRef.current;
      closeReasonRef.current = null;

      setStatus("disconnected");
      setPhase("idle");
      setRoomId(null);
      socketRef.current = null;
      pendingQueueRef.current = [];

      if (!reason) {
        setNotice({ level: "warning", text: "Disconnected." });
      }
      appendMessage({ kind: "system", text: "WebSocket error" });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "queued") {
          setPhase("queued");
          setNotice({ level: "info", text: "Searching..." });
        } else if (data.type === "matched") {
          setRoomId(data.room_id ?? null);
          setPhase("in_room");
          setNotice({ level: "success", text: "Matched! You can chat now." });
        } else if (data.type === "peer_left") {
          setRoomId(null);
          setPhase("idle");
          setNotice({ level: "warning", text: "Peer left the room." });
        } else if (data.type === "chat" && data.message?.kind === "rtc_signal") {
          // [webrtc] Enqueue signal; bump version counter to trigger effect
          rtcSignalQueueRef.current.push(data.message.signal as RtcSignalPayload);
          setRtcSignalVersion((v) => v + 1);
        }
        appendMessage({ kind: "event", payload: data });
      } catch {
        appendMessage({ kind: "system", text: `Raw message: ${event.data}` });
      }
    };
  };

  const startFind = async (
    mode: FindMode,
    desiredRegionKey: string,
    opts?: { force?: boolean },
  ) => {
    if (!opts?.force && !canFind()) return;

    const token = await getOrCreateToken(desiredRegionKey);
    if (!token) return;

    ensureConnected(token);
    const payload =
      mode === "region"
        ? { type: "find", mode: "region", region: desiredRegionKey }
        : { type: "find", mode: "random" };
    queueOrSend(payload);
    setPhase("connecting");
  };

  useEffect(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (socketRef.current) {
      closeReasonRef.current = "region_reset";
      socketRef.current.close();
      socketRef.current = null;
    }
    pendingQueueRef.current = [];
    setStatus("disconnected");
    setRoomId(null);
    setPhase("idle");
    setNotice({ level: "info", text: `Region switched to ${activeRegionKey}` });
    appendMessage({
      kind: "system",
      text: `Region changed to ${activeRegionKey}, session reset`,
    });

    const pendingFind = pendingFindRef.current;
    if (pendingFind && pendingFind.regionKey === activeRegionKey) {
      pendingFindRef.current = null;
      queueMicrotask(() => {
        void startFind(pendingFind.mode, pendingFind.regionKey, { force: true });
      });
    }
  }, [activeRegionKey]);

  const applyRegionAndResetIfNeeded = (): {
    desiredRegionKey: string;
    changed: boolean;
  } => {
    const desiredRegionKey = (draftRegion || "AU").trim().toUpperCase() || "AU";
    const changed = desiredRegionKey !== activeRegionKey;
    if (changed) {
      setActiveRegion(desiredRegionKey);
    }
    return { desiredRegionKey, changed };
  };

  const findRandom = async () => {
    if (!canFind()) return;
    const { desiredRegionKey, changed } = applyRegionAndResetIfNeeded();
    if (changed) {
      pendingFindRef.current = { mode: "random", regionKey: desiredRegionKey };
      return;
    }
    await startFind("random", desiredRegionKey);
  };

  const findRegion = async () => {
    if (!canFind()) return;
    const { desiredRegionKey, changed } = applyRegionAndResetIfNeeded();
    if (changed) {
      pendingFindRef.current = { mode: "region", regionKey: desiredRegionKey };
      return;
    }
    await startFind("region", desiredRegionKey);
  };

  const cancel = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      closeReasonRef.current = "cancel";
      try {
        ws.send(JSON.stringify({ type: "cancel" }));
      } catch {
        // ignore send errors during cancel
      }
      ws.close();
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      closeReasonRef.current = "cancel";
      ws.close();
    }

    pendingFindRef.current = null;
    pendingQueueRef.current = [];
    socketRef.current = null;
    setRoomId(null);
    setStatus("disconnected");
    setPhase("idle");
    setNotice({ level: "info", text: "You left the room." });
    appendMessage({ kind: "system", text: "Cancelled current match and reset state." });
  };

  const sendChat = (message: string) => {
    if (!roomId) {
      appendMessage({ kind: "system", text: "Not in a room yet" });
      return;
    }
    if (!message.trim()) return;

    queueOrSend({
      type: "chat",
      room_id: roomId,
      message,
    });
  };

  const sendRtcSignal = (signal: RtcSignalPayload) => {
    if (!roomId) return;
    queueOrSend({
      type: "chat",
      room_id: roomId,
      message: {
        kind: "rtc_signal",
        signal,
      },
    });
  };

  const debugSimulateClose = (
    eventCode: number = 1000,
    reason: "cancel" | "region_reset" | null = null,
  ) => {
    if (process.env.NODE_ENV !== "development") return;
    closeReasonRef.current = reason;
    const reasonFromRef = closeReasonRef.current;
    closeReasonRef.current = null;
    handleClose(eventCode, reasonFromRef);
  };

  return {
    status,
    phase,
    roomId,
    notice,
    rtcSignalQueue: rtcSignalQueueRef.current,
    rtcSignalVersion,
    draftRegion,
    activeRegionKey,
    setDraftRegion,
    findRandom,
    findRegion,
    cancel,
    sendChat,
    sendRtcSignal,
    clearNotice: () => setNotice(null),
    debugSimulateClose:
      process.env.NODE_ENV === "development" ? debugSimulateClose : undefined,
    messages,
  };
}

