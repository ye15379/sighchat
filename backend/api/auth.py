import time
from typing import Any, Dict

import jwt
from django.conf import settings


def create_session_token(session_id: str) -> str:
    """
    Create a JWT token for a given session ID.

    Payload includes:
    - sid: session_id
    - iat: issued at (unix timestamp)
    """
    payload: Dict[str, Any] = {
        "sid": session_id,
        "iat": int(time.time()),
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")

    # PyJWT may return bytes in some versions, normalize to str
    if isinstance(token, bytes):
        token = token.decode("utf-8")

    return token

