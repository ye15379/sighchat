# WebRTC 调试手册：Safari 黑屏 / 重复 m-line 问题

> 受影响文件：`frontend/lib/useRoomRtc.ts`
>
> 修复日期：2026-02

---

## 目录

1. [症状](#1-症状)
2. [根因分析](#2-根因分析)
3. [修复方案](#3-修复方案)
4. [三层防护体系](#4-三层防护体系)
5. [验收步骤](#5-验收步骤)
6. [诊断脚本](#6-诊断脚本)
7. [防回归建议](#7-防回归建议)
8. [FAQ](#8-faq)

---

## 1. 症状

Safari（macOS / iOS）与 Chrome 互测 WebRTC 视频通话时：

| 现象 | 详情 |
|------|------|
| 远端大窗黑屏 | `readyState=0`，`videoWidth=0`，`videoHeight=0` |
| `pc.connectionState` | 显示 `connected`（ICE/DTLS 正常） |
| remote `srcObject` | 包含 **2 audio + 2 video** tracks（正常应为 1+1） |

Chrome 偶尔也会出现远端黑屏，但频率低于 Safari。

**关键诊断信号**：在 Console 运行 [诊断脚本](#6-诊断脚本)，如果远端 video 的 `tracks` 数组里出现 2 条 `kind:"video"`，即可确认此问题。

---

## 2. 根因分析

### 重复 m-line / 双通道机制

在 `autoStart()` 中，**两套**创建 SDP m-line 的机制同时运行：

**机制 1 — `addTrack`（隐式创建 transceiver）：**

```typescript
stream.getTracks().forEach((track) => pc.addTrack(track, stream));
// → 生成 1 audio m-line + 1 video m-line
```

**机制 2 — `ensureRecvTransceivers`（显式 `addTransceiver`）：**

```typescript
pc.addTransceiver("audio", { direction: "sendrecv" });
pc.addTransceiver("video", { direction: "sendrecv" });
// → 再生成 1 audio m-line + 1 video m-line
```

**结果**：SDP 包含 **4 条 m-line**（2 audio + 2 video）。远端 peer 收到 2 audio + 2 video tracks。

**Safari 的行为**：无法在一个 `<video>` 元素上渲染含 2 条 video track 的 `MediaStream` → `readyState=0`，`videoWidth=0`，`videoHeight=0`（黑屏）。Chrome 对多 video track 有一定容忍度，但也可能因 stale stream 绑定而黑屏。

---

## 3. 修复方案

所有改动集中在 **`frontend/lib/useRoomRtc.ts`** 一个文件内。

### A) 发送侧根因修复：`addTransceiver` + `replaceTrack`

**核心原则**：只使用一套机制。选择 `addTransceiver`（显式控制更可靠），彻底移除 `addTrack()`。

```typescript
// 创建恰好 1 audio + 1 video transceiver（=恰好 2 条 m-line）
audioTxRef.current = pc.addTransceiver("audio", { direction: "sendrecv" });
videoTxRef.current = pc.addTransceiver("video", { direction: "sendrecv" });

// 通过 replaceTrack 挂载本地 track（不会创建新 m-line）
const audioTrack = stream.getAudioTracks()[0] ?? null;
const videoTrack = stream.getVideoTracks()[0] ?? null;
if (audioTrack) await audioTxRef.current.sender.replaceTrack(audioTrack);
if (videoTrack) await videoTxRef.current.sender.replaceTrack(videoTrack);
```

- `addTrack()` 完全移除
- 新增 `audioTxRef` / `videoTxRef`（`useRef<RTCRtpTransceiver | null>`）保存引用

### B) 接收侧防护：`bindRemoteVideo` 过滤为 1v + 1a

即使未来意外产生多条 track，remote `<video>` 也只渲染**第一条 live video track + 第一条 live audio track**：

```typescript
const vTrack =
  src.getVideoTracks().find((t) => t.readyState === "live") ??
  src.getVideoTracks()[0];
const aTrack =
  src.getAudioTracks().find((t) => t.readyState === "live") ??
  src.getAudioTracks()[0];
const wanted: MediaStreamTrack[] = [];
if (vTrack) wanted.push(vTrack);
if (aTrack) wanted.push(aTrack);
video.srcObject = new MediaStream(wanted);
```

同时用 track ID 集合比较，避免 srcObject 无谓替换（防 flicker）。

### C) `ontrack` 聚合流去重

当 `event.streams` 为空时使用 fallback 聚合流，按 `track.id` 去重，防止两次 `ontrack` 把同一 track 叠加：

```typescript
const already = remoteStreamRef.current
  .getTracks()
  .some((t) => t.id === event.track.id);
if (!already) {
  remoteStreamRef.current.addTrack(event.track);
}
```

### D) Transceiver refs 生命周期管理

| 时机 | 操作 |
|------|------|
| 创建 PC | `audioTxRef.current = pc.addTransceiver(...)` |
| cleanup / hangup | `sender.replaceTrack(null)` 解绑 → refs 置 `null` |
| `resetSessionFlags` | refs 置 `null` |

---

## 4. 三层防护体系

| 层级 | 机制 | 保证 |
|------|------|------|
| **发送侧** | 仅 `addTransceiver` + `replaceTrack`，不用 `addTrack` | SDP 只有 2 条 m-line（1 audio + 1 video） |
| **接收侧 bind** | `bindRemoteVideo` 过滤为 1 video + 1 audio track | `<video>.srcObject` 永远 ≤ 2 tracks |
| **接收侧 ontrack** | fallback 按 `track.id` 去重 | 不重复累加 track |

---

## 5. 验收步骤

```bash
# 1. 启动 HTTPS 开发服务器
./frontend/scripts/dev-clean-start-https.sh

# 2. 在两台浏览器中打开匹配页面
#    Safari:  https://<LAN_IP>:3000/match
#    Chrome:  https://<LAN_IP>:3000/match

# 3. 两边 Find Region → matched

# 4. 在两边 Console 运行诊断脚本（见下方）
#    预期：远端大窗 1 video + 1 audio，w/h > 0，readyState >= 1

# 5. Console 搜索 "[bind]" 日志，应看到类似：
#    [bind] ontrack: src vTracks=1 aTracks=1 → render [video:xxxx:live, audio:yyyy:live]
```

---

## 6. 诊断脚本

在任意浏览器 Console 中运行，快速检查页面上所有 `<video>` 元素的状态：

```javascript
(() => [...document.querySelectorAll("video")].map(v => ({
  muted: v.muted,
  paused: v.paused,
  readyState: v.readyState,
  w: v.videoWidth,
  h: v.videoHeight,
  tracks: v.srcObject
    ? v.srcObject.getTracks().map(t => ({ kind: t.kind, rs: t.readyState }))
    : null
})))()
```

**健康结果示例**（2 个 video 元素）：

```json
[
  { "muted": true,  "paused": false, "readyState": 4, "w": 640, "h": 480,
    "tracks": [{ "kind": "video", "rs": "live" }, { "kind": "audio", "rs": "live" }] },
  { "muted": true,  "paused": false, "readyState": 4, "w": 640, "h": 480,
    "tracks": [{ "kind": "video", "rs": "live" }, { "kind": "audio", "rs": "live" }] }
]
```

**异常信号**（即回归）：

- 某个 video 的 `tracks` 含 2 条 `kind: "video"` → 重复 m-line 又出现了
- `readyState: 0` + `w: 0, h: 0` → 黑屏
- `tracks: null` → srcObject 未绑定

---

## 7. 防回归建议

以下建议尚未写入代码，但推荐在未来迭代中加固：

### 7.1 m-line 数量断言日志

在 `pc.connectionState === "connected"` 回调中，检查 transceiver 数量：

```typescript
// 建议在 onconnectionstatechange("connected") 中添加：
const txCount = pc.getTransceivers().length;
if (txCount > 2) {
  console.error(
    `[RTC][REGRESSION] Expected 2 transceivers, got ${txCount}.`,
    pc.getTransceivers().map(tx => ({
      mid: tx.mid,
      direction: tx.direction,
      senderTrack: tx.sender.track?.kind,
      receiverTrack: tx.receiver.track?.kind,
    }))
  );
}
```

如果在日志中看到 `[RTC][REGRESSION]`，说明重复 m-line 问题已回归。

### 7.2 远端渲染 track 选择策略

当前策略：从 `remoteStreamRef.current` 中挑选第一条 live video + 第一条 live audio。

未来可考虑更精准的方式：直接绑定 `receiver.track`（由 transceiver 提供），跳过 `event.streams` 中间层：

```typescript
// 未来可选方案示例（仅供参考，未实现）：
const videoReceiver = pc.getTransceivers()
  .find(tx => tx.receiver.track?.kind === "video");
const audioReceiver = pc.getTransceivers()
  .find(tx => tx.receiver.track?.kind === "audio");
video.srcObject = new MediaStream([
  videoReceiver?.receiver.track,
  audioReceiver?.receiver.track,
].filter(Boolean));
```

---

## 8. FAQ

### Q: 为什么 `addTrack()` 和 `addTransceiver()` 不能同时用？

`addTrack()` 会**隐式**创建一个 transceiver（如果没有空闲的 transceiver 可复用）。如果之后再调 `addTransceiver()`，就会创建**第二个**同 kind 的 transceiver，导致 SDP 里出现重复的 m-line。

### Q: Chrome 为什么有时候没事，Safari 却一定黑屏？

Chrome 对一个 `<video>` 元素绑定含多条 video track 的 `MediaStream` 有一定容忍度（通常渲染第一条）。Safari 则完全不渲染，video 元素停留在 `readyState=0`。

### Q: `replaceTrack()` 和 `addTrack()` 有什么区别？

- `addTrack(track, stream)`：创建或复用一个 transceiver，**可能**增加 m-line
- `sender.replaceTrack(track)`：在**已有**的 transceiver sender 上替换 track，**不会**改变 SDP 结构

### Q: 修复后 `toggleMic` / `toggleCamera` 还能正常工作吗？

能。`replaceTrack` 共享的是同一个 `MediaStreamTrack` 对象引用。`toggleMic` 设置 `track.enabled = false` 同样作用于 transceiver sender 持有的那条 track。

### Q: 如果以后需要屏幕共享（多 video track），怎么办？

屏幕共享应该用独立的 transceiver（`addTransceiver("video")`），并在 `bindRemoteVideo` 的过滤逻辑中识别并分流到独立的 `<video>` 元素。当前的 1v+1a 过滤是针对"单路视频通话"场景的安全防护。
