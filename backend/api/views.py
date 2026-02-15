import json

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .auth import create_session_token
from .models import Session


def health(request):
    return JsonResponse({"status": "ok"})


@csrf_exempt
def init_session(request):
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed"}, status=405)

    try:
        raw_body = request.body.decode("utf-8") if request.body else "{}"
        data = json.loads(raw_body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "Invalid JSON"}, status=400)

    session = Session.objects.create(
        locale=data.get("locale", "en"),
        region=data.get("region", "GLOBAL"),
        sign_language=data.get("sign_language", "NONE"),
        purpose=data.get("purpose", "chat"),
        allow_data_use=bool(data.get("allow_data_use", False)),
    )

    token = create_session_token(str(session.id))

    return JsonResponse(
        {
            "session_id": str(session.id),
            "token": token,
        }
    )
