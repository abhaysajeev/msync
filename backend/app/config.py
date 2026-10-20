"""Runtime settings, all from environment variables (see .env.example)."""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", "./data")).resolve())
    # argon2 hash of the admin password; generate with `python -m app.hashpw`
    admin_password_hash: str = field(default_factory=lambda: _env("ADMIN_PASSWORD_HASH"))
    session_secret: str = field(default_factory=lambda: _env("SESSION_SECRET") or secrets.token_hex(32))
    turn_secret: str = field(default_factory=lambda: _env("TURN_SECRET"))
    # hostname or IP the browser uses for TURN (usually the same as the site address)
    turn_host: str = field(default_factory=lambda: _env("TURN_HOST"))
    turn_port: int = field(default_factory=lambda: int(_env("TURN_PORT", "3478")))
    # secure cookies need HTTPS; disable only for local http development
    secure_cookies: bool = field(default_factory=lambda: _env("SECURE_COOKIES", "1") == "1")
    # internal token tusd's hooks and the worker present to the api
    internal_token: str = field(default_factory=lambda: _env("INTERNAL_TOKEN"))
    dev_admin_password: str = field(default_factory=lambda: _env("DEV_ADMIN_PASSWORD"))

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def incoming_dir(self) -> Path:
        return self.data_dir / "incoming"

    @property
    def db_url(self) -> str:
        return f"sqlite:///{self.data_dir / 'msync.db'}"


settings = Settings()
