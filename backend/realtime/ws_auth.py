from typing import Any, Dict
from urllib.parse import parse_qs

import jwt
from django.conf import settings


class JwtAuthMiddleware:
  """
  Channels WebSocket middleware:
  - 从 query string 中读取 ?token=...
  - 使用 settings.SECRET_KEY + HS256 校验 JWT
  - 成功则在 scope["user_session"] 中注入会话信息
  - 失败则在握手阶段直接关闭连接（4401）
  """

  def __init__(self, app):
      self.app = app

  async def __call__(self, scope: Dict[str, Any], receive, send):
      # 只处理 websocket 连接
      if scope.get("type") != "websocket":
          return await self.app(scope, receive, send)

      query_string = scope.get("query_string", b"")
      params = parse_qs(query_string.decode("utf-8"))
      token_list = params.get("token")
      token = token_list[0] if token_list else None

      if not token:
          await send({"type": "websocket.close", "code": 4401})
          return

      try:
          # 与 create_session_token 保持一致：HS256 + SECRET_KEY
          payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
      except jwt.PyJWTError:
          await send({"type": "websocket.close", "code": 4401})
          return

      # 与现有 payload 结构兼容：包含 sid
      session_id = payload.get("sid") or payload.get("session_id")

      scope = dict(scope)
      scope["user_session"] = {
          "session_id": session_id,
          "payload": payload,
      }

      return await self.app(scope, receive, send)


def JwtAuthMiddlewareStack(inner):
  """
  便捷封装：保持与 AuthMiddlewareStack 类似的用法。
  """

  return JwtAuthMiddleware(inner)

