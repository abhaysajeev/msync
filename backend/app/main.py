"""HTTP API + room WebSocket. Video bytes never pass through here: Caddy serves /media/*."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from sqlalchemy import select

from . import auth
from .config import settings
from .db import Guest, Movie, Room, init_db, session
from .hub import hub
from .media import subs as subtitles
from .sync.clock import now_ms

log = logging.getLogger("msync")
ROOM_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
NAME_RE = re.compile(r"^[\w .'\-]{1,40}$", re.UNICODE)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    init_db()
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    settings.incoming_dir.mkdir(parents=True, exist_ok=True)
    hub.start()
    yield
    await hub.stop()


app = FastAPI(title="msync", lifespan=lifespan, docs_url=None, redoc_url=None)

if os.environ.get("DEV_SERVE_MEDIA") == "1":
    # local development only: in production Caddy serves /media behind forward_auth
    from fastapi.staticfiles import StaticFiles

    settings.media_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=settings.media_dir), name="media")


def _room_code() -> str:
    return "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(10))


def movie_public(m: Movie) -> dict:
    return {
        "id": m.id, "title": m.title, "status": m.status, "progress": round(m.progress or 0, 4),
        "duration": m.duration, "size_bytes": m.size_bytes, "video_codec": m.video_codec,
        "audio_codec": m.audio_codec, "width": m.width, "height": m.height, "codecs": m.codecs,
        "peak_mbps": m.peak_mbps, "avg_mbps": m.avg_mbps, "note": m.note, "error": m.error,
        "subtitles": json.loads(m.subtitles or "[]"),
        "audio_tracks": json.loads(m.audio_tracks or "[]"),
        "created_at": m.created_at, "started_at": m.started_at,
        "poster": f"/media/{m.id}/poster.jpg" if m.status == "ready" else None,
    }


def room_public(r: Room, s) -> dict:
    m = s.get(Movie, r.movie_id) if r.movie_id else None
    live = hub.rooms.get(r.code)
    members = [mm.public() for mm in live.state.members.values()] if live else []
    st = live.state if live else None
    return {
        "code": r.code, "name": r.name, "movie": movie_public(m) if m else None,
        "created_at": r.created_at, "members": members,
        "phase": st.phase.value if st else "paused",
        "pos": st.expected_pos(now_ms()) if st else 0.0,
        "knocks": hub.knocks(r.code),
    }


# ---- identity --------------------------------------------------------------------------------

@app.get("/api/me")
def me(request: Request):
    who = auth.identity(request)
    if not who:
        return {"admin": False, "guest": None}
    if who.is_admin:
        return {"admin": True, "guest": None}
    return {"admin": False, "guest": {"id": who.id, "name": who.name, "room": who.room_code,
                                      "status": who.guest_status}}


@app.post("/api/admin/login")
def login(request: Request, response: Response, password: str = Body(..., embed=True)):
    auth.throttle("login:" + auth.client_ip(request))
    if not auth.verify_password(password):
        raise HTTPException(401, "That password is not right.")
    auth.set_admin_cookie(response)
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    auth.clear_cookies(response)
    return {"ok": True}


# ---- films -----------------------------------------------------------------------------------

@app.get("/api/movies")
def list_movies(request: Request):
    auth.require_admin(request)
    with session() as s:
        rows = s.scalars(select(Movie).order_by(Movie.created_at.desc())).all()
        return [movie_public(m) for m in rows]


@app.post("/api/movies/import")
def import_movie(request: Request, url: str = Body(...), title: str = Body("")):
    auth.require_admin(request)
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "Paste a direct http or https link to the video file.")
    name = title.strip() or Path(url.split("?")[0]).stem.replace(".", " ")[:200] or "Imported film"
    with session() as s:
        m = Movie(title=name, status="downloading", source_url=url)
        s.add(m)
        s.flush()
        return movie_public(m)


@app.patch("/api/movies/{movie_id}")
def update_movie(movie_id: str, request: Request, body: dict = Body(...)):
    auth.require_admin(request)
    with session() as s:
        m = s.get(Movie, movie_id)
        if not m:
            raise HTTPException(404, "No such film")
        if "title" in body and str(body["title"]).strip():
            m.title = str(body["title"]).strip()[:300]
        if "audio_index" in body:
            if m.status not in ("choose_audio", "needs_transcode", "failed"):
                raise HTTPException(409, "The audio track can only be chosen before processing.")
            m.audio_index = int(body["audio_index"])
            if m.status == "choose_audio":
                m.status, m.note = "queued", None
        return movie_public(m)


@app.post("/api/movies/{movie_id}/transcode")
def approve_transcode(movie_id: str, request: Request):
    auth.require_admin(request)
    with session() as s:
        m = s.get(Movie, movie_id)
        if not m or m.status != "needs_transcode":
            raise HTTPException(409, "This film does not need a re-encode.")
        m.transcode, m.status, m.progress = 1, "queued", 0.0
        return movie_public(m)


@app.post("/api/movies/{movie_id}/retry")
def retry_movie(movie_id: str, request: Request):
    auth.require_admin(request)
    with session() as s:
        m = s.get(Movie, movie_id)
        if not m or m.status != "failed":
            raise HTTPException(409, "Only failed films can be retried.")
        m.status = "downloading" if (m.source_url and not m.source_path) else "queued"
        m.error, m.progress = None, 0.0
        return movie_public(m)


@app.delete("/api/movies/{movie_id}")
def delete_movie(movie_id: str, request: Request):
    auth.require_admin(request)
    with session() as s:
        m = s.get(Movie, movie_id)
        if not m:
            raise HTTPException(404, "No such film")
        if m.status in ("processing", "downloading"):
            raise HTTPException(409, "Wait for this film to finish processing first.")
        if m.source_path:
            Path(m.source_path).unlink(missing_ok=True)
        shutil.rmtree(settings.media_dir / m.id, ignore_errors=True)
        for r in s.scalars(select(Room).where(Room.movie_id == m.id)):
            r.movie_id = None
        s.delete(m)
    return {"ok": True}


# ---- subtitles added by the host ---------------------------------------------------------------

_SUB_FILE = re.compile(r"^sub_[a-z0-9_]+\.vtt$")


def _movie_subs(m: Movie) -> list[dict]:
    return json.loads(m.subtitles or "[]")


async def _subs_changed(movie_id: str, subs: list[dict]) -> None:
    """Rooms showing this film pick up the new list without reloading."""
    with session() as s:
        codes = [r.code for r in s.scalars(select(Room).where(Room.movie_id == movie_id))]
    for code in codes:
        await hub.broadcast(code, {"t": "subtitles", "movie": movie_id, "subtitles": subs})


def _write_vtt(movie_id: str, text: str) -> str:
    # a new name on every write: /media files are cached as immutable on each device
    name = f"sub_{secrets.token_hex(4)}.vtt"
    (settings.media_dir / movie_id / name).write_text(text, encoding="utf-8")
    return name


@app.post("/api/movies/{movie_id}/subtitles")
async def add_subtitle(movie_id: str, request: Request, filename: str, label: str = "",
                       lang: str = "und", offset: float = 0.0):
    """Body: the raw subtitle file. Query: filename, optional label, lang, offset (seconds)."""
    auth.require_admin(request)
    data = await request.body()
    try:
        vtt = subtitles.to_vtt(data, filename, offset)
    except subtitles.SubtitleError as e:
        raise HTTPException(400, str(e)) from e
    with session() as s:
        m = s.get(Movie, movie_id)
        if not m or m.status != "ready":
            raise HTTPException(409, "Subtitles can be added once the film is ready.")
        name = _write_vtt(movie_id, vtt)
        subs = _movie_subs(m) + [{"lang": (lang or "und")[:12],
                                  "label": (label.strip() or Path(filename).stem)[:60], "file": name}]
        m.subtitles = json.dumps(subs)
    await _subs_changed(movie_id, subs)
    return {"subtitles": subs}


@app.patch("/api/movies/{movie_id}/subtitles/{file}")
async def update_subtitle(movie_id: str, file: str, request: Request,
                          delay: Optional[float] = Body(None, embed=True), label: Optional[str] = Body(None, embed=True)):
    """Shared timing for both viewers: `delay` seconds, positive shows every line later.
    The file itself is never rewritten, so the value can be changed again at any time."""
    auth.require_admin(request)
    if not _SUB_FILE.match(file) or (delay is not None and abs(delay) > 600):
        raise HTTPException(400, "Bad subtitle or delay.")
    with session() as s:
        m = s.get(Movie, movie_id)
        subs = _movie_subs(m) if m else []
        entry = next((x for x in subs if x["file"] == file), None)
        if not entry:
            raise HTTPException(404, "No such subtitle.")
        if delay is not None:
            entry["delay"] = round(delay, 3)
        if label is not None and label.strip():
            entry["label"] = label.strip()[:60]
        m.subtitles = json.dumps(subs)
    await _subs_changed(movie_id, subs)
    return {"subtitles": subs}


@app.delete("/api/movies/{movie_id}/subtitles/{file}")
async def delete_subtitle(movie_id: str, file: str, request: Request):
    auth.require_admin(request)
    if not _SUB_FILE.match(file):
        raise HTTPException(400, "Bad subtitle name.")
    with session() as s:
        m = s.get(Movie, movie_id)
        if not m:
            raise HTTPException(404, "No such film")
        subs = [x for x in _movie_subs(m) if x["file"] != file]
        m.subtitles = json.dumps(subs)
    (settings.media_dir / movie_id / file).unlink(missing_ok=True)
    await _subs_changed(movie_id, subs)
    return {"subtitles": subs}


@app.get("/api/disk")
def disk(request: Request):
    auth.require_admin(request)
    u = shutil.disk_usage(settings.data_dir)
    return {"total": u.total, "used": u.used, "free": u.free}


# ---- rooms and the admit flow ----------------------------------------------------------------

@app.get("/api/rooms")
def list_rooms(request: Request):
    auth.require_admin(request)
    with session() as s:
        rows = s.scalars(select(Room).order_by(Room.created_at.desc())).all()
        return [room_public(r, s) for r in rows]


@app.post("/api/rooms")
def create_room(request: Request, name: str = Body(""), movie_id: Optional[str] = Body(None)):
    auth.require_admin(request)
    with session() as s:
        if movie_id:
            m = s.get(Movie, movie_id)
            if not m or m.status != "ready":
                raise HTTPException(400, "That film is not ready yet.")
        r = Room(code=_room_code(), name=(name.strip() or "Movie night")[:120], movie_id=movie_id)
        s.add(r)
        s.flush()
        return room_public(r, s)


@app.patch("/api/rooms/{code}")
async def update_room(code: str, request: Request, body: dict = Body(...)):
    auth.require_admin(request)
    changed = False
    with session() as s:
        r = s.get(Room, code)
        if not r:
            raise HTTPException(404, "No such room")
        if "name" in body and str(body["name"]).strip():
            r.name = str(body["name"]).strip()[:120]
        if "movie_id" in body and body["movie_id"] != r.movie_id:
            m = s.get(Movie, body["movie_id"]) if body["movie_id"] else None
            if body["movie_id"] and (not m or m.status != "ready"):
                raise HTTPException(400, "That film is not ready yet.")
            r.movie_id, changed = body["movie_id"], True
        out = room_public(r, s)
    if changed:
        await hub.movie_changed(code)
    return out


@app.delete("/api/rooms/{code}")
async def delete_room(code: str, request: Request):
    auth.require_admin(request)
    with session() as s:
        r = s.get(Room, code)
        if not r:
            raise HTTPException(404, "No such room")
        guests = s.scalars(select(Guest).where(Guest.room_code == code)).all()
        for g in guests:
            g.status = "kicked"
        s.delete(r)
    live = hub.rooms.pop(code, None)
    if live:
        for c in list(live.conns.values()):
            try:
                await c.ws.close(code=4004)
            except Exception:  # noqa: BLE001
                pass
    return {"ok": True}


@app.get("/api/rooms/{code}/public")
def room_info(code: str):
    """What the join page may show before admission: the room's name and its film's title."""
    with session() as s:
        r = s.get(Room, code)
        if not r:
            raise HTTPException(404, "This invite link is not valid any more.")
        m = s.get(Movie, r.movie_id) if r.movie_id else None
        return {"code": r.code, "name": r.name, "movie_title": m.title if m else None,
                "duration": m.duration if m else None}


@app.post("/api/rooms/{code}/knock")
async def knock(code: str, request: Request, response: Response, name: str = Body(..., embed=True)):
    auth.throttle("knock:" + auth.client_ip(request), limit=20, window=600)
    name = name.strip()
    if not NAME_RE.match(name):
        raise HTTPException(400, "Use up to 40 letters, numbers or spaces for your name.")
    who = auth.identity(request)
    with session() as s:
        if not s.get(Room, code):
            raise HTTPException(404, "This invite link is not valid any more.")
        g = s.get(Guest, who.id) if who and not who.is_admin else None
        if g and g.room_code == code and g.status in ("knocking", "admitted"):
            g.name = name
        else:
            g = Guest(room_code=code, name=name, status="knocking")
            s.add(g)
            s.flush()
        gid, status = g.id, g.status
    auth.set_guest_cookie(response, gid)
    await hub.push_knocks(code)
    return {"id": gid, "status": status}


@app.get("/api/rooms/{code}/knock")
def knock_status(code: str, request: Request):
    who = auth.identity(request)
    if not who or who.is_admin or who.room_code != code:
        return {"status": "none"}
    return {"status": who.guest_status, "name": who.name}


@app.post("/api/rooms/{code}/guests/{guest_id}/{action}")
async def guest_action(code: str, guest_id: str, action: str, request: Request):
    auth.require_admin(request)
    new = {"admit": "admitted", "deny": "denied", "kick": "kicked"}.get(action)
    if not new:
        raise HTTPException(404, "Unknown action")
    with session() as s:
        g = s.get(Guest, guest_id)
        if not g or g.room_code != code:
            raise HTTPException(404, "No such guest")
        g.status = new
    if new == "kicked":
        await hub.kick(code, guest_id)
    await hub.push_knocks(code)
    return {"ok": True, "status": new}


@app.get("/api/rooms/{code}/session")
def room_session(code: str, request: Request):
    """Everything a member needs to start watching: the film, its manifest and its profile."""
    who = auth.identity(request)
    if not auth.can_enter_room(who, code):
        raise HTTPException(403, "You have not been let into this room yet.")
    with session() as s:
        r = s.get(Room, code)
        if not r:
            raise HTTPException(404, "No such room")
        m = s.get(Movie, r.movie_id) if r.movie_id else None
        movie = movie_public(m) if m and m.status == "ready" else None
        profile = None
        if movie:
            p = settings.media_dir / m.id / "profile.json"
            profile = json.loads(p.read_text()) if p.exists() else None
            movie["manifest"] = f"/media/{m.id}/index.m3u8"
        return {"room": {"code": r.code, "name": r.name}, "you": {"id": who.id, "name": who.name,
                "admin": who.is_admin}, "movie": movie, "profile": profile}


# ---- WebRTC: TURN REST credentials -----------------------------------------------------------

@app.get("/api/ice")
def ice_servers(request: Request):
    who = auth.identity(request)
    if not who or (not who.is_admin and who.guest_status != "admitted"):
        raise HTTPException(403, "Not in a room")
    servers: list[dict] = [{"urls": ["stun:stun.l.google.com:19302"]}]
    if settings.turn_secret and settings.turn_host:
        expiry = int(time.time()) + 6 * 3600
        user = f"{expiry}:{who.id}"
        cred = base64.b64encode(hmac.new(settings.turn_secret.encode(), user.encode(),
                                         hashlib.sha1).digest()).decode()
        h, p = settings.turn_host, settings.turn_port
        servers = [{"urls": [f"stun:{h}:{p}"]},
                   {"urls": [f"turn:{h}:{p}?transport=udp", f"turn:{h}:{p}?transport=tcp"],
                    "username": user, "credential": cred}]
    return {"iceServers": servers}


# ---- bandwidth check -------------------------------------------------------------------------

_BW_BLOCK = os.urandom(1 << 20)  # incompressible, so gzip/brotli cannot fake the speed


@app.get("/api/bw")
def bandwidth(request: Request, bytes: int = 8 << 20):
    if not auth.identity(request):
        raise HTTPException(403, "Open your invite link first.")
    n = max(1 << 16, min(bytes, 64 << 20))

    def gen():
        left = n
        while left > 0:
            chunk = _BW_BLOCK[: min(left, len(_BW_BLOCK))]
            left -= len(chunk)
            yield chunk

    return StreamingResponse(gen(), media_type="application/octet-stream", headers={
        "Content-Length": str(n), "Cache-Control": "no-store", "Content-Encoding": "identity"})


@app.post("/api/bw/up")
async def bandwidth_up(request: Request):
    if not auth.identity(request):
        raise HTTPException(403, "Open your invite link first.")
    got = 0
    async for chunk in request.stream():
        got += len(chunk)
        if got > 16 << 20:
            break
    return {"bytes": got}


# ---- Caddy forward_auth for /media/* ---------------------------------------------------------

_MEDIA_PATH = re.compile(r"^/media/([0-9a-f]{12})/")


@app.get("/api/auth/media")
def media_auth(request: Request):
    who = auth.identity(request)
    if not who:
        return PlainTextResponse("no", status_code=401)
    if who.is_admin:
        return PlainTextResponse("ok")
    if who.guest_status != "admitted":
        return PlainTextResponse("no", status_code=403)
    uri = request.headers.get("x-forwarded-uri", "")
    m = _MEDIA_PATH.match(uri)
    with session() as s:
        r = s.get(Room, who.room_code)
        if r and m and r.movie_id == m.group(1):
            return PlainTextResponse("ok")
    return PlainTextResponse("no", status_code=403)


# ---- tusd hooks ------------------------------------------------------------------------------

@app.post("/api/hooks/tusd")
async def tusd_hook(request: Request):
    body = await request.json()
    kind = body.get("Type")
    event = body.get("Event") or {}
    cookies: dict[str, str] = {}
    for part in request.headers.get("cookie", "").split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            cookies[k] = v
    who = auth.identity_from_cookies(cookies)

    if kind == "pre-create":
        if not who or not who.is_admin:
            return JSONResponse({"RejectUpload": True, "HTTPResponse": {
                "StatusCode": 401, "Body": json.dumps({"message": "Sign in as the host to upload."}),
                "Header": {"Content-Type": "application/json"}}})
        size = (event.get("Upload") or {}).get("Size") or 0
        if size and size > shutil.disk_usage(settings.data_dir).free * 0.45:
            return JSONResponse({"RejectUpload": True, "HTTPResponse": {
                "StatusCode": 413, "Body": json.dumps({"message": "Not enough free disk on the server."}),
                "Header": {"Content-Type": "application/json"}}})
        return JSONResponse({})

    if kind == "post-finish":
        up = event.get("Upload") or {}
        meta = up.get("MetaData") or {}
        path = (up.get("Storage") or {}).get("Path")
        if not path:
            return JSONResponse({})
        title = (meta.get("title") or Path(meta.get("filename") or "Untitled").stem).strip()[:300]
        with session() as s:
            s.add(Movie(title=title or "Untitled", status="queued", source_path=path,
                        size_bytes=up.get("Size")))
        return JSONResponse({})

    return JSONResponse({})


# ---- client debug log ------------------------------------------------------------------------

@app.post("/api/debug")
async def debug_log(request: Request):
    who = auth.identity(request)
    if not who:
        raise HTTPException(403)
    body = await request.body()
    log_dir = settings.data_dir / "client-logs"
    log_dir.mkdir(exist_ok=True)
    with (log_dir / f"{time.strftime('%Y%m%d')}-{who.id}.log").open("ab") as f:
        f.write(body[:200_000] + b"\n")
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True}


# ---- the room socket -------------------------------------------------------------------------

@app.websocket("/ws/rooms/{code}")
async def room_socket(ws: WebSocket, code: str):
    origin = ws.headers.get("origin", "")
    host = ws.headers.get("host", "")
    if origin and origin.split("://", 1)[-1] != host:
        await ws.close(code=4003)  # cross-site WebSocket hijacking guard
        return
    who = auth.identity_from_cookies(ws.cookies)
    with session() as s:
        exists = s.get(Room, code) is not None
    if not exists or not auth.can_enter_room(who, code):
        await ws.close(code=4003)
        return
    await ws.accept()
    await hub.serve(ws, code, who.id, who.name, who.is_admin)
