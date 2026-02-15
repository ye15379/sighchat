from django.urls import path
from .views import health, init_session

urlpatterns = [
    path("health/", health, name="health"),
    # POST /api/session/init （无尾斜杠）
    path("api/session/init", init_session, name="init_session"),
    # 兼容带尾斜杠的形式
    path("api/session/init/", init_session),
]

