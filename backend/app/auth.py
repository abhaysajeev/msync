"""Admin password login and signed cookies. No accounts: one admin, admitted guests."""
from __future__ import annotations

import hmac
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import HTTPException, Request, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import settings
from .db import Guest, session

ADMIN_COOKIE = "msync_admin"
GUEST_COOKIE = "msync_guest"
ADMIN_MAX_AGE = 60 * 60 * 24 * 30
GUEST_MAX_AGE = 60 * 60 * 24 * 7

_ser = URLSafeTimedSerializer(settings.session_secret, salt="msync")
_ph = PasswordHasher()


@dataclass
class Identity:
    kind: str                 # "admin" | "guest"
    id: str                   # member id inside rooms
    name: str
    room_code: Optional[str] = None
    guest_status: Optional[str] = None

    @property
    def is_admin(self) -> bool:
        return self.kind == "admin"


def verify_password(password: str) -> bool:
    if settings.admin_password_hash:
        try:
            return _ph.verify(settings.admin_password_hash, password)
        except (VerifyMismatchError, InvalidHashError):
            return False
    if settings.dev_admin_password:
        return hmac.compare_digest(password, settings.dev_admin_password)
    return False


# --- login throttle: 8 attempts per 10 minutes per client address ---------------------------
_attempts: dict[str, deque] = defaultdict(deque)


def throttle(key: str, limit: int = 8, window: float = 600.0) -> None:
    q = _attempts[key]
    now = time.time()
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "Too many attempts. Try again in a few minutes.")
    q.append(now)


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


def _set_cookie(resp: Response, name: str, value: str, max_age: int) -> None:
    resp.set_cookie(name, value, max_age=max_age, httponly=True, samesite="lax",
                    secure=settings.secure_cookies, path="/")


def set_admin_cookie(resp: Response) -> None:
    _set_cookie(resp, ADMIN_COOKIE, _ser.dumps({"a": 1}), ADMIN_MAX_AGE)


def set_guest_cookie(resp: Response, guest_id: str) -> None:
    _set_cookie(resp, GUEST_COOKIE, _ser.dumps({"g": guest_id}), GUEST_MAX_AGE)


def clear_cookies(resp: Response) -> None:
    resp.delete_cookie(ADMIN_COOKIE, path="/")
    resp.delete_cookie(GUEST_COOKIE, path="/")


def _load(cookies: dict[str, str], name: str, max_age: int) -> Optional[dict]:
    raw = cookies.get(name)
    if not raw:
        return None
    try:
        return _ser.loads(raw, max_age=max_age)
    except BadSignature:
        return None


def identity_from_cookies(cookies: dict[str, str]) -> Optional[Identity]:
    if _load(cookies, ADMIN_COOKIE, ADMIN_MAX_AGE):
        return Identity(kind="admin", id="admin", name="Host")
    data = _load(cookies, GUEST_COOKIE, GUEST_MAX_AGE)
    if data and "g" in data:
        with session() as s:
            g = s.get(Guest, data["g"])
            if g:
                return Identity(kind="guest", id=g.id, name=g.name, room_code=g.room_code,
                                guest_status=g.status)
    return None


def identity(request: Request) -> Optional[Identity]:
    return identity_from_cookies(request.cookies)


def require_admin(request: Request) -> Identity:
    who = identity(request)
    if not who or not who.is_admin:
        raise HTTPException(401, "Admin only")
    return who


def can_enter_room(who: Optional[Identity], code: str) -> bool:
    if not who:
        return False
    if who.is_admin:
        return True
    return who.room_code == code and who.guest_status == "admitted"
