from pathlib import Path
from typing import List

import environ

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DJANGO_DEBUG=(bool, False),
)

# Read .env.example as default when running in docker (we use env_file in compose)
environ.Env.read_env(str(BASE_DIR / ".env.example"))

SECRET_KEY: str = env("DJANGO_SECRET_KEY")
DEBUG: bool = env("DJANGO_DEBUG")


# ── ALLOWED_HOSTS ────────────────────────────────────────
# Assemble from DJANGO_ALLOWED_HOSTS (comma-separated) + LAN_IP (single value).
# Filter out empty strings that arise when ${LAN_IP} is unset in docker-compose,
# which would otherwise cause Django to reject every request with 400 DisallowedHost.

def _build_allowed_hosts() -> List[str]:
    raw: str = env("DJANGO_ALLOWED_HOSTS", default="")
    hosts: List[str] = [h.strip() for h in raw.split(",") if h.strip()]

    # LAN_IP may be passed separately by compose or dev scripts
    lan_ip: str = env("LAN_IP", default="").strip()
    if lan_ip:
        hosts.append(lan_ip)

    # Dev baseline: always reachable from loopback
    for h in ("localhost", "127.0.0.1", "0.0.0.0"):
        if h not in hosts:
            hosts.append(h)

    return list(dict.fromkeys(hosts))  # dedupe, preserve order


ALLOWED_HOSTS: List[str] = _build_allowed_hosts()


# ── CSRF_TRUSTED_ORIGINS ─────────────────────────────────
# Required for POST / WebSocket upgrade from HTTPS frontend.
# Same filtering: drop entries with empty host that appear when LAN_IP is unset.

def _build_csrf_trusted_origins() -> List[str]:
    raw: str = env("DJANGO_CSRF_TRUSTED_ORIGINS", default="")
    origins: List[str] = [o.strip() for o in raw.split(",") if o.strip()]

    lan_ip: str = env("LAN_IP", default="").strip()
    if lan_ip:
        for origin in (f"https://{lan_ip}:3000", f"https://{lan_ip}:8001"):
            if origin not in origins:
                origins.append(origin)

    # Dev baseline
    for origin in ("https://localhost:3000", "https://127.0.0.1:3000"):
        if origin not in origins:
            origins.append(origin)

    # Filter out malformed origins produced when LAN_IP is empty, e.g.:
    #   "https://:3000"  → scheme present but host is empty
    #   "https://"       → scheme only, no host at all
    def _is_valid_origin(origin: str) -> bool:
        if "://" not in origin:
            return False
        after_scheme: str = origin.split("://", 1)[1]
        # after_scheme must start with a non-empty, non-colon character (the host)
        return bool(after_scheme) and after_scheme[0] not in (":", "/", "")

    return [o for o in dict.fromkeys(origins) if _is_valid_origin(o)]


CSRF_TRUSTED_ORIGINS: List[str] = _build_csrf_trusted_origins()

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",

    "rest_framework",
    "channels",

    "api",
    "realtime",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "core.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "core.wsgi.application"
ASGI_APPLICATION = "core.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": env("DB_NAME"),
        "USER": env("DB_USER"),
        "PASSWORD": env("DB_PASSWORD"),
        "HOST": env("DB_HOST"),
        "PORT": env("DB_PORT"),
    }
}

# Channels (Redis)
REDIS_HOST = env("REDIS_HOST")
REDIS_PORT = env("REDIS_PORT")

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [(REDIS_HOST, int(REDIS_PORT))],
        },
    },
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

