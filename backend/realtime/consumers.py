import asyncio
import logging
import uuid
from collections import deque
from typing import Deque, Dict, Optional, TypedDict

from channels.generic.websocket import AsyncJsonWebsocketConsumer

logger = logging.getLogger(__name__)


class WaitingUser(TypedDict):
    channel_name: str
    region: str


RANDOM_QUEUE: Deque[WaitingUser] = deque()
REGION_QUEUES: Dict[str, Deque[WaitingUser]] = {}
QUEUE_LOCK = asyncio.Lock()


class EchoConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        await self.accept()

    async def receive_json(self, content, **kwargs):
        # 简单 JSON echo
        await self.send_json({"echo": content})


class MatchConsumer(AsyncJsonWebsocketConsumer):
    """
    最小可用的匹配 + 房间广播逻辑（单机内存队列版）
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.region: str = "GLOBAL"
        self.mode: Optional[str] = None  # "random" | "region" | None
        self.room_id: Optional[str] = None
        self.room_group_name: Optional[str] = None

    async def connect(self):
        await self.accept()

    async def disconnect(self, code):
        # 断开连接时从等待队列和房间中清理
        await self._remove_from_queues()
        if self.room_group_name:
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "chat.peer_left",
                },
            )
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        msg_type = content.get("type")

        if msg_type == "find":
            await self.handle_find(content)
        elif msg_type == "cancel":
            await self.handle_cancel()
        elif msg_type == "chat":
            await self.handle_chat(content)
        else:
            await self.send_json({"error": "unknown_type"})

    # 匹配逻辑
    async def handle_find(self, content):
        mode = content.get("mode")
        if mode not in {"random", "region"}:
            await self.send_json({"error": "invalid_mode"})
            return

        self.mode = mode
        region = content.get("region") or "GLOBAL"
        self.region = region

        logger.info(
            "[signal] handle_find mode=%s region=%s channel=%s",
            mode, region, self.channel_name,
        )

        async with QUEUE_LOCK:
            if mode == "random":
                logger.info("[signal] RANDOM_QUEUE length before match: %d", len(RANDOM_QUEUE))
                await self._match_in_queue(RANDOM_QUEUE, region)
            else:
                queue = REGION_QUEUES.setdefault(region, deque())
                logger.info("[signal] REGION_QUEUE[%s] length before match: %d", region, len(queue))
                await self._match_in_queue(queue, region)

    async def _match_in_queue(self, queue: Deque[WaitingUser], region: str):
        # 如果已有等待者，则配对
        while queue:
            waiting = queue.popleft()
            # 防御：如果 channel 已经失效，简单跳过
            if waiting["channel_name"] == self.channel_name:
                # 自己已经在队列中，忽略
                continue

            room_id = str(uuid.uuid4())
            room_group_name = f"room_{room_id}"
            self.room_id = room_id
            self.room_group_name = room_group_name

            # 当前用户加入房间 group
            await self.channel_layer.group_add(room_group_name, self.channel_name)

            # 通知对方加入房间，并发送 matched
            await self.channel_layer.send(
                waiting["channel_name"],
                {
                    "type": "match.join",
                    "room_id": room_id,
                    "peer_region": self.region,
                },
            )

            # 给自己发送 matched
            await self.send_json(
                {
                    "type": "matched",
                    "room_id": room_id,
                    "peer": {
                        "region": waiting["region"],
                    },
                }
            )
            return

        # 没有等待者，把自己加入队列
        queue.append(
            {
                "channel_name": self.channel_name,
                "region": region,
            }
        )
        await self.send_json({"type": "queued"})

    async def handle_cancel(self):
        await self._remove_from_queues()
        if self.room_group_name:
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "chat.peer_left",
                },
            )
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
            self.room_group_name = None
            self.room_id = None
        await self.send_json({"type": "cancelled"})

    async def handle_chat(self, content):
        room_id = content.get("room_id")
        message = content.get("message")
        if not room_id or not message:
            await self.send_json({"error": "invalid_chat"})
            return

        if room_id != self.room_id or not self.room_group_name:
            await self.send_json({"error": "not_in_room"})
            return

        # [signal] Log RTC signal relay for debugging
        if isinstance(message, dict) and message.get("kind") == "rtc_signal":
            sig = message.get("signal", {})
            logger.info(
                "[signal] relay rtc_signal room=%s from_channel=%s kind=%s clientId=%s",
                room_id,
                self.channel_name,
                sig.get("kind") if isinstance(sig, dict) else "?",
                sig.get("clientId") if isinstance(sig, dict) else "?",
            )

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "chat.message",
                "room_id": room_id,
                "message": message,
            },
        )

    async def _remove_from_queues(self):
        async with QUEUE_LOCK:
            # 从 random 队列移除
            self._filter_queue(RANDOM_QUEUE)

            # 从所有 region 队列移除
            for region, q in list(REGION_QUEUES.items()):
                self._filter_queue(q)
                if not q:
                    REGION_QUEUES.pop(region, None)

    def _filter_queue(self, queue: Deque[WaitingUser]):
        if not queue:
            return
        tmp: Deque[WaitingUser] = deque()
        while queue:
            item = queue.popleft()
            if item["channel_name"] != self.channel_name:
                tmp.append(item)
        queue.extend(tmp)

    # === Channel layer handlers ===

    async def match_join(self, event):
        """
        被配对方接收到 join 事件：
        - 加入房间 group
        - 发送 matched 给客户端
        """
        room_id = event["room_id"]
        peer_region = event.get("peer_region", "GLOBAL")

        self.room_id = room_id
        self.room_group_name = f"room_{room_id}"

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)

        await self.send_json(
            {
                "type": "matched",
                "room_id": room_id,
                "peer": {"region": peer_region},
            }
        )

    async def chat_message(self, event):
        await self.send_json(
            {
                "type": "chat",
                "room_id": event["room_id"],
                "message": event["message"],
            }
        )

    async def chat_peer_left(self, event):
        await self.send_json({"type": "peer_left"})

