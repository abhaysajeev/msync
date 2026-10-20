"""Room hub: one WebSocket per member carries sync, chat, presence, knocks and call signaling.

The authoritative RoomState is in memory (single uvicorn worker). Each room has an asyncio
lock so state transitions never interleave.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import WebSocket
from sqlalchemy import select

from .db import ChatMessage, Guest, Movie, Room, session
from .sync.clock import now_ms
from .sync.room_state import Effect, Phase, RoomState

log = logging.getLogger("msync.hub")
CHAT_HISTORY = 100
CHAT_MAX_LEN = 1000
TICK_S = 0.5


@dataclass
class Conn:
    ws: WebSocket
    member_id: str
    name: str
    is_admin: bool


@dataclass
class LiveRoom:
    code: str
    state: RoomState
    conns: dict[str, Conn] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, LiveRoom] = {}
        self._ticker: Optional[asyncio.Task] = None

    # ---- lifecycle ---------------------------------------------------------------------------

    def start(self) -> None:
        if self._ticker is None:
            self._ticker = asyncio.create_task(self._tick_loop())

    async def stop(self) -> None:
        if self._ticker:
            self._ticker.cancel()
            self._ticker = None

    async def _tick_loop(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            for room in list(self.rooms.values()):
                async with room.lock:
                    effects = room.state.tick(now_ms())
                await self._deliver(room, effects)

    def room(self, code: str) -> LiveRoom:
        live = self.rooms.get(code)
        if live is None:
            live = LiveRoom(code=code, state=RoomState(code=code))
            self.rooms[code] = live
        self._sync_duration(live)
        return live

    def _sync_duration(self, live: LiveRoom) -> None:
        with session() as s:
            r = s.get(Room, live.code)
            m = s.get(Movie, r.movie_id) if r and r.movie_id else None
            live.state.duration = m.duration if m and m.status == "ready" else None

    # ---- delivery ----------------------------------------------------------------------------

    async def _send(self, conn: Conn, msg: dict[str, Any]) -> None:
        try:
            await conn.ws.send_text(json.dumps(msg, separators=(",", ":")))
        except Exception:  # noqa: BLE001 - a dead socket is cleaned up by its reader
            pass

    async def _deliver(self, room: LiveRoom, effects: list[Effect]) -> None:
        for e in effects:
            if e.to is None:
                await asyncio.gather(*(self._send(c, e.msg) for c in list(room.conns.values())))
            elif e.to in room.conns:
                await self._send(room.conns[e.to], e.msg)

    async def broadcast(self, code: str, msg: dict[str, Any], admins_only: bool = False) -> None:
        room = self.rooms.get(code)
        if not room:
            return
        targets = [c for c in room.conns.values() if c.is_admin or not admins_only]
        await asyncio.gather(*(self._send(c, msg) for c in targets))

    # ---- admin side-channels -----------------------------------------------------------------

    def knocks(self, code: str) -> list[dict[str, Any]]:
        with session() as s:
            rows = s.scalars(select(Guest).where(Guest.room_code == code, Guest.status == "knocking")
                             .order_by(Guest.created_at)).all()
            return [{"id": g.id, "name": g.name, "since": g.created_at} for g in rows]

    async def push_knocks(self, code: str) -> None:
        await self.broadcast(code, {"t": "knocks", "knocks": self.knocks(code)}, admins_only=True)

    async def kick(self, code: str, member_id: str) -> None:
        room = self.rooms.get(code)
        if not room:
            return
        conn = room.conns.get(member_id)
        if conn:
            await self._send(conn, {"t": "kicked"})
            try:
                await conn.ws.close(code=4003)
            except Exception:  # noqa: BLE001
                pass
        async with room.lock:
            room.conns.pop(member_id, None)
            effects = room.state.remove(member_id, now_ms())
        await self._deliver(room, effects)

    async def movie_changed(self, code: str) -> None:
        room = self.rooms.get(code)
        if not room:
            return
        async with room.lock:
            self._sync_duration(room)
            st = room.state
            st.seq += 1
            st.pos, st.want_playing = 0.0, False
            st.phase = Phase.PAUSED
            msg = {"t": "movie_changed", "seq": st.seq}
        await self.broadcast(code, msg)

    # ---- the socket --------------------------------------------------------------------------

    async def serve(self, ws: WebSocket, code: str, member_id: str, name: str, is_admin: bool) -> None:
        room = self.room(code)
        conn = Conn(ws=ws, member_id=member_id, name=name, is_admin=is_admin)
        old = room.conns.get(member_id)
        if old:  # same person, new tab or reconnect: the newest connection wins
            await self._send(old, {"t": "replaced"})
            try:
                await old.ws.close(code=4001)
            except Exception:  # noqa: BLE001
                pass
        room.conns[member_id] = conn

        async with room.lock:
            effects = room.state.join(member_id, name, now_ms(), is_admin=is_admin)
        await self._send(conn, {"t": "welcome", "you": member_id, "admin": is_admin, "name": name})
        await self._deliver(room, effects)
        await self._send(conn, {"t": "chat_history", "messages": self._history(code)})
        if is_admin:
            await self._send(conn, {"t": "knocks", "knocks": self.knocks(code)})

        try:
            while True:
                raw = await ws.receive_text()
                recv = now_ms()
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                await self._handle(room, conn, msg, recv)
        except Exception:  # noqa: BLE001 - WebSocketDisconnect and friends
            pass
        finally:
            if room.conns.get(member_id) is conn:
                room.conns.pop(member_id, None)
                async with room.lock:
                    effects = room.state.leave(member_id, now_ms())
                await self._deliver(room, effects)

    async def _handle(self, room: LiveRoom, conn: Conn, msg: dict[str, Any], recv: float) -> None:
        t = msg.get("t")
        if t == "ping":
            # NTP-style: t0 client send, t1 server receive, t2 server send
            await self._send(conn, {"t": "pong", "t0": msg.get("t0"), "t1": recv, "t2": now_ms()})
            return
        if t == "intent":
            pos = msg.get("pos")
            async with room.lock:
                effects = room.state.intent(conn.member_id, str(msg.get("kind")),
                                            int(msg.get("base_seq", -1)), now_ms(),
                                            pos=float(pos) if pos is not None else None)
            await self._deliver(room, effects)
            return
        if t == "status":
            async with room.lock:
                effects = room.state.status(
                    conn.member_id, now_ms(), seq=int(msg.get("seq", -1)),
                    state=str(msg.get("state", "")), pos=float(msg.get("pos") or 0),
                    ahead=float(msg.get("ahead") or 0), rtt_ms=float(msg.get("rtt") or 0),
                    drift_ms=float(msg.get("drift") or 0), mbps=float(msg.get("mbps") or 0))
                effects.append(room.state.presence())
            await self._deliver(room, effects)
            return
        if t == "min_ahead" and conn.is_admin:
            room.state.set_min_ahead(float(msg.get("seconds") or 8))
            return
        if t == "resync":
            await self._send(conn, room.state.snapshot(now_ms()))
            return
        if t == "chat":
            text = str(msg.get("text", "")).strip()[:CHAT_MAX_LEN]
            if not text:
                return
            with session() as s:
                cm = ChatMessage(room_code=room.code, member_id=conn.member_id, name=conn.name,
                                 text=text, ts=time.time())
                s.add(cm)
                s.flush()
                out = {"t": "chat", **cm.public(), "nonce": msg.get("nonce")}
            await self.broadcast(room.code, out)
            return
        if t == "typing":
            await self._others(room, conn, {"t": "typing", "member": conn.member_id})
            return
        if t in ("rtc", "media_state"):
            # WebRTC signaling / mic+camera state: relay verbatim to the other member(s)
            await self._others(room, conn, {**msg, "from": conn.member_id})
            return

    async def _others(self, room: LiveRoom, conn: Conn, msg: dict[str, Any]) -> None:
        await asyncio.gather(*(self._send(c, msg) for c in list(room.conns.values())
                               if c.member_id != conn.member_id))

    def _history(self, code: str) -> list[dict[str, Any]]:
        with session() as s:
            rows = s.scalars(select(ChatMessage).where(ChatMessage.room_code == code)
                             .order_by(ChatMessage.id.desc()).limit(CHAT_HISTORY)).all()
            return [r.public() for r in reversed(rows)]


hub = Hub()
