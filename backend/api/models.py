import uuid

from django.db import models


class Session(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_active_at = models.DateTimeField(auto_now=True)
    locale = models.CharField(max_length=20, default="en")
    region = models.CharField(max_length=10, default="GLOBAL")
    sign_language = models.CharField(max_length=20, default="NONE")
    purpose = models.CharField(max_length=20, default="chat")
    allow_data_use = models.BooleanField(default=False)

    class Meta:
        db_table = "api_session"

    def __str__(self) -> str:
        return f"Session<{self.id}>"

