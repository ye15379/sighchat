from django.urls import path

from .consumers import EchoConsumer, MatchConsumer

websocket_urlpatterns = [
    path("ws/echo/", EchoConsumer.as_asgi()),
    path("ws/match/", MatchConsumer.as_asgi()),
]

