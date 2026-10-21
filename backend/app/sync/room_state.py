"""Authoritative playback state for one room.

Pure and clock-injected: every method takes `now` (server monotonic ms) and returns a list
of Effects for the transport layer to deliver. No I/O, no asyncio, so it is unit-testable
with a fake clock.

Protocol summary (see README "Sync protocol"):
- Clients send *intents* (play / pause / seek) only on user action, carrying the `seq` they
  last saw. Media-element events are never broadcast, so echo loops cannot happen.
- Every play and every seek-while-playing goes through a ready barrier: `prepare(pos)` ->
  each client buffers `min_ahead` seconds and reports ready -> `start(pos, at_ms)` scheduled
  slightly in the future so both sides begin on the same server millisecond.
- A client that stalls while playing reports `buffering`; everyone is paused at that
  position and a new barrier runs, so one side never plays while the other buffers.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

START_LEAD_MS = 400.0          # minimum scheduling lead for start()
BARRIER_NOTICE_MS = 30_000.0   # after this, tell everyone who we are waiting for
MIN_AHEAD_DEFAULT = 8.0        # seconds buffered before a start
MIN_AHEAD_CAP = 60.0          # more than a browser reliably holds of a high-bitrate film is a deadlock
STALL_GROWTH = 1.5             # each stall asks for 1.5x more buffer next time
CALM_DECAY_MS = 180_000.0      # ...and each 3 minutes of smooth playback gives one step back
RESUME_DRIFT_TOLERANCE_S = 5.0 # use the staller's own position if it is this close


class Phase(str, Enum):
    PAUSED = "paused"
    PREPARING = "preparing"
    PLAYING = "playing"


@dataclass
class Effect:
    """A message for the transport. `to` None means every connected member."""
    msg: dict[str, Any]
    to: Optional[str] = None


@dataclass
class Member:
    id: str
    name: str
    is_admin: bool = False
    connected: bool = True
    ready_seq: int = -1          # the barrier seq this member reported ready for
    excused_seq: int = -1        # admin force-started without this member for this seq
    state: str = "loading"       # loading|ready|buffering|playing|paused
    pos: float = 0.0
    ahead: float = 0.0           # seconds buffered past pos
    need: float = 0.0            # seconds it is buffering towards before reporting ready
    rtt_ms: float = 0.0
    drift_ms: float = 0.0
    mbps: float = 0.0
    last_seen: float = 0.0

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "admin": self.is_admin,
            "connected": self.connected, "state": self.state,
            "pos": round(self.pos, 3), "ahead": round(self.ahead, 1), "need": round(self.need, 1),
            "rtt": round(self.rtt_ms), "drift": round(self.drift_ms), "mbps": round(self.mbps, 1),
        }


@dataclass
class RoomState:
    code: str
    duration: Optional[float] = None
    seq: int = 0
    phase: Phase = Phase.PAUSED
    pos: float = 0.0
    anchor_ms: float = 0.0       # server ms at which `pos` is valid (PLAYING only)
    want_playing: bool = False
    min_ahead: float = MIN_AHEAD_DEFAULT
    reason: str = ""             # why the current barrier exists, for the UI
    barrier_started_ms: float = 0.0
    barrier_noticed: bool = False
    calm_since_ms: float = 0.0   # last stall or decay step while playing
    members: dict[str, Member] = field(default_factory=dict)

    # ---- queries -------------------------------------------------------------------------

    def expected_pos(self, now: float) -> float:
        if self.phase is Phase.PLAYING and now >= self.anchor_ms:
            p = self.pos + (now - self.anchor_ms) / 1000.0
            return min(p, self.duration) if self.duration else p
        return self.pos

    def connected(self) -> list[Member]:
        return [m for m in self.members.values() if m.connected]

    def snapshot(self, now: float) -> dict[str, Any]:
        return {
            "t": "snapshot", "seq": self.seq, "phase": self.phase.value,
            "pos": self.pos, "anchor": self.anchor_ms, "want_playing": self.want_playing,
            "min_ahead": self.min_ahead, "reason": self.reason, "now": now,
            "duration": self.duration,
            "members": [m.public() for m in self.members.values()],
        }

    def presence(self) -> Effect:
        return Effect({"t": "presence", "members": [m.public() for m in self.members.values()]})

    # ---- membership ----------------------------------------------------------------------

    def join(self, member_id: str, name: str, now: float, is_admin: bool = False) -> list[Effect]:
        m = self.members.get(member_id)
        if m is None:
            m = Member(id=member_id, name=name, is_admin=is_admin)
            self.members[member_id] = m
        m.connected, m.name, m.last_seen = True, name, now
        m.state, m.ready_seq = "loading", -1
        # The (re)joiner converges from the snapshot. If it cannot keep up it reports
        # `buffering`, which runs the stall rule; a brief WS blip costs nothing.
        return [Effect(self.snapshot(now), to=member_id), self.presence()]

    def leave(self, member_id: str, now: float) -> list[Effect]:
        m = self.members.get(member_id)
        if m is None:
            return []
        m.connected = False
        m.state = "away"
        return [self.presence(), *self._check_barrier(now)]

    def remove(self, member_id: str, now: float) -> list[Effect]:
        self.members.pop(member_id, None)
        return [self.presence(), *self._check_barrier(now)]

    # ---- intents (user actions) ----------------------------------------------------------

    def intent(self, member_id: str, kind: str, base_seq: int, now: float,
               pos: Optional[float] = None) -> list[Effect]:
        m = self.members.get(member_id)
        if m is None or not m.connected:
            return []
        if kind == "force" and m.is_admin:
            return self._force_start(now)
        if base_seq < self.seq:
            # Stale: the user acted on a state that no longer exists. Re-sync them.
            return [Effect({"t": "rejected", "seq": self.seq}, to=member_id),
                    Effect(self.snapshot(now), to=member_id)]

        if kind == "play":
            if self.phase is Phase.PLAYING or (self.phase is Phase.PREPARING and self.want_playing):
                return []
            self.want_playing = True
            return self._start_barrier(self.pos, now, reason=f"play:{m.name}")

        if kind == "pause":
            if self.phase is Phase.PAUSED:
                return []
            p = self.expected_pos(now)
            return self._pause_at(p, now, by=m.name)

        if kind == "seek" and pos is not None:
            p = self._clamp(pos)
            if self.phase is Phase.PLAYING or self.want_playing:
                return self._start_barrier(p, now, reason=f"seek:{m.name}")
            return self._pause_at(p, now, by=m.name)

        return []

    # ---- client status reports -----------------------------------------------------------

    def status(self, member_id: str, now: float, *, seq: int, state: str, pos: float,
               ahead: float, rtt_ms: float = 0.0, drift_ms: float = 0.0,
               mbps: float = 0.0, need: float = 0.0) -> list[Effect]:
        m = self.members.get(member_id)
        if m is None:
            return []
        m.state, m.pos, m.ahead, m.need, m.last_seen = state, pos, ahead, need, now
        m.rtt_ms, m.drift_ms = rtt_ms or m.rtt_ms, drift_ms
        if mbps:
            m.mbps = mbps
        if seq != self.seq:
            return []  # report about an older command; ignore for decisions

        if state == "ready" and self.phase is Phase.PREPARING:
            m.ready_seq = seq
            return self._check_barrier(now)

        if state == "buffering" and self.phase is Phase.PLAYING and m.excused_seq != seq:
            exp = self.expected_pos(now)
            stall_pos = pos if abs(pos - exp) <= RESUME_DRIFT_TOLERANCE_S else exp
            self.min_ahead = min(self.min_ahead * STALL_GROWTH, MIN_AHEAD_CAP)
            self.calm_since_ms = now
            return self._start_barrier(stall_pos, now, reason=f"buffering:{m.name}")

        return []

    def set_min_ahead(self, seconds: float) -> None:
        self.min_ahead = max(2.0, min(seconds, MIN_AHEAD_CAP))

    # ---- time-driven ---------------------------------------------------------------------

    def tick(self, now: float) -> list[Effect]:
        out: list[Effect] = []
        if (self.phase is Phase.PREPARING and not self.barrier_noticed
                and now - self.barrier_started_ms > BARRIER_NOTICE_MS):
            self.barrier_noticed = True
            waiting = [m.name for m in self.connected() if m.ready_seq != self.seq]
            out.append(Effect({"t": "notice", "kind": "waiting", "names": waiting, "seq": self.seq}))
        if (self.phase is Phase.PLAYING and self.min_ahead > MIN_AHEAD_DEFAULT
                and now - max(self.calm_since_ms, self.anchor_ms) > CALM_DECAY_MS):
            self.min_ahead = max(MIN_AHEAD_DEFAULT, self.min_ahead / STALL_GROWTH)
            self.calm_since_ms = now
        if self.phase is Phase.PLAYING and self.duration and self.expected_pos(now) >= self.duration:
            out += self._pause_at(self.duration, now, by="end")
        return out

    # ---- internals -----------------------------------------------------------------------

    def _clamp(self, pos: float) -> float:
        pos = max(0.0, pos)
        if self.duration:
            pos = min(pos, max(0.0, self.duration - 0.5))
        return pos

    def _pause_at(self, pos: float, now: float, by: str) -> list[Effect]:
        self.seq += 1
        self.phase, self.pos, self.want_playing = Phase.PAUSED, pos, False
        self.reason = f"pause:{by}"
        return [Effect({"t": "cmd", "kind": "pause", "seq": self.seq, "pos": pos, "by": by})]

    def _start_barrier(self, pos: float, now: float, reason: str) -> list[Effect]:
        self.seq += 1
        self.phase, self.pos, self.reason = Phase.PREPARING, pos, reason
        self.barrier_started_ms, self.barrier_noticed = now, False
        effects = [Effect({"t": "cmd", "kind": "prepare", "seq": self.seq, "pos": pos,
                           "min_ahead": self.min_ahead, "reason": reason})]
        return effects + self._check_barrier(now)

    def _check_barrier(self, now: float) -> list[Effect]:
        if self.phase is not Phase.PREPARING or not self.want_playing:
            return []
        live = self.connected()
        if not live or any(m.ready_seq != self.seq for m in live):
            return []
        return self._schedule_start(now)

    def _schedule_start(self, now: float) -> list[Effect]:
        max_rtt = max((m.rtt_ms for m in self.connected()), default=0.0)
        at = now + max(START_LEAD_MS, 2.0 * max_rtt)
        self.phase, self.anchor_ms = Phase.PLAYING, at
        # an excused member catches up on its own (seek ahead, buffer, join in) rather than chasing
        excused = [m.id for m in self.connected() if m.excused_seq == self.seq]
        return [Effect({"t": "cmd", "kind": "start", "seq": self.seq, "pos": self.pos, "at": at,
                        "excused": excused})]

    def _force_start(self, now: float) -> list[Effect]:
        if self.phase is not Phase.PREPARING:
            return []
        self.want_playing = True
        for m in self.connected():
            if m.ready_seq != self.seq:
                m.excused_seq = self.seq  # let them catch up alone instead of re-stalling
        return self._schedule_start(now)
