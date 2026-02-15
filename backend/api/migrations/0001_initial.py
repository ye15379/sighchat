import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Session",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        primary_key=True,
                        default=uuid.uuid4,
                        editable=False,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("last_active_at", models.DateTimeField(auto_now=True)),
                ("locale", models.CharField(max_length=20, default="en")),
                ("region", models.CharField(max_length=10, default="GLOBAL")),
                ("sign_language", models.CharField(max_length=20, default="NONE")),
                ("purpose", models.CharField(max_length=20, default="chat")),
                ("allow_data_use", models.BooleanField(default=False)),
            ],
            options={
                "db_table": "api_session",
            },
        ),
    ]

