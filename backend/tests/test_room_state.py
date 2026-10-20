from app.sync.room_state import Phase, RoomState, START_LEAD_MS


def cmds(effects, kind=None):
    out = [e.msg for e in effects if e.msg.get("t") == "cmd"]
    return [c for c in out if kind is None or c["kind"] == kind]


def room_with_two(now=0.0):
    r = RoomState(code="t", duration=6000.0)
    r.join("a", "Arun", now, is_admin=True)
    r.join("b", "Meera", now)
    return r


def ready_all(r, now, ids=("a", "b")):
    eff = []
    for i in ids:
        eff += r.status(i, now, seq=r.seq, state="ready", pos=r.pos, ahead=30)
    return eff


def test_play_runs_barrier_then_schedules_start():
    r = room_with_two()
    eff = r.intent("a", "play", base_seq=0, now=1000)
    assert r.phase is Phase.PREPARING
    assert cmds(eff, "prepare")[0]["pos"] == 0.0
    assert not cmds(eff, "start")
    # one ready is not enough
    assert not cmds(r.status("a", 1100, seq=r.seq, state="ready", pos=0, ahead=30), "start")
    start = cmds(r.status("b", 1200, seq=r.seq, state="ready", pos=0, ahead=30), "start")
    assert start and start[0]["at"] >= 1200 + START_LEAD_MS
    assert r.phase is Phase.PLAYING


def test_start_lead_covers_slow_rtt():
    r = room_with_two()
    r.members["b"].rtt_ms = 350
    r.intent("a", "play", 0, 0)
    start = cmds(ready_all(r, 100), "start")[0]
    assert start["at"] == 100 + 700


def test_expected_position_advances_after_anchor():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    ready_all(r, 0)
    at = r.anchor_ms
    assert r.expected_pos(at - 100) == 0.0
    assert abs(r.expected_pos(at + 2500) - 2.5) < 1e-9


def test_pause_freezes_at_expected_position():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    ready_all(r, 0)
    eff = r.intent("b", "pause", r.seq, r.anchor_ms + 10_000)
    p = cmds(eff, "pause")[0]
    assert abs(p["pos"] - 10.0) < 1e-9
    assert r.phase is Phase.PAUSED and not r.want_playing


def test_stale_intent_is_rejected_and_resynced():
    r = room_with_two()
    r.intent("a", "play", 0, 0)           # seq -> 1
    eff = r.intent("b", "pause", 0, 10)   # b had not seen seq 1
    assert any(e.msg["t"] == "rejected" and e.to == "b" for e in eff)
    assert any(e.msg["t"] == "snapshot" and e.to == "b" for e in eff)
    assert r.phase is Phase.PREPARING


def test_seek_while_playing_rebarriers_and_keeps_playing_intent():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    ready_all(r, 0)
    eff = r.intent("a", "seek", r.seq, r.anchor_ms + 5000, pos=1200.0)
    assert cmds(eff, "prepare")[0]["pos"] == 1200.0
    assert r.want_playing and r.phase is Phase.PREPARING
    assert cmds(ready_all(r, r.anchor_ms + 6000), "start")[0]["pos"] == 1200.0


def test_seek_while_paused_stays_paused():
    r = room_with_two()
    eff = r.intent("a", "seek", 0, 0, pos=300.0)
    assert cmds(eff, "pause")[0]["pos"] == 300.0
    assert r.phase is Phase.PAUSED


def test_seek_is_clamped_to_duration():
    r = room_with_two()
    r.intent("a", "seek", 0, 0, pos=999_999.0)
    assert r.pos <= r.duration


def test_stall_pauses_everyone_and_grows_buffer_target():
    r = room_with_two()
    before = r.min_ahead
    r.intent("a", "play", 0, 0)
    ready_all(r, 0)
    t = r.anchor_ms + 60_000
    eff = r.status("b", t, seq=r.seq, state="buffering", pos=59.7, ahead=0)
    prep = cmds(eff, "prepare")[0]
    assert prep["pos"] == 59.7          # the staller's own position
    assert r.phase is Phase.PREPARING and r.want_playing
    assert r.min_ahead == before * 1.5
    assert "buffering:Meera" in prep["reason"]


def test_stall_with_wild_position_uses_expected():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    ready_all(r, 0)
    t = r.anchor_ms + 60_000
    prep = cmds(r.status("b", t, seq=r.seq, state="buffering", pos=0.0, ahead=0), "prepare")[0]
    assert abs(prep["pos"] - 60.0) < 1e-6


def test_status_for_old_seq_is_ignored():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    old = r.seq
    r.intent("a", "seek", r.seq, 10, pos=50.0)
    assert not r.status("a", 20, seq=old, state="ready", pos=0, ahead=30)
    assert r.members["a"].ready_seq != r.seq


def test_disconnect_mid_barrier_unblocks_the_rest():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    r.status("a", 10, seq=r.seq, state="ready", pos=0, ahead=30)
    eff = r.leave("b", 20)
    assert cmds(eff, "start")
    assert r.phase is Phase.PLAYING


def test_rejoin_gets_snapshot_and_does_not_disturb_playback():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    ready_all(r, 0)
    r.leave("b", 5000)
    eff = r.join("b", "Meera", 6000)
    snap = [e for e in eff if e.msg["t"] == "snapshot"][0]
    assert snap.to == "b" and snap.msg["phase"] == "playing"
    assert not cmds(eff)
    assert r.phase is Phase.PLAYING


def test_barrier_notice_after_timeout_and_force_start_excuses_laggard():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    r.status("a", 10, seq=r.seq, state="ready", pos=0, ahead=30)
    notice = [e.msg for e in r.tick(31_000) if e.msg["t"] == "notice"]
    assert notice and notice[0]["names"] == ["Meera"]
    assert not r.tick(32_000)  # only once
    # only the admin may force
    assert not r.intent("b", "force", r.seq, 33_000)
    assert cmds(r.intent("a", "force", r.seq, 33_000), "start")
    # the laggard's buffering no longer stalls the room
    assert not r.status("b", 40_000, seq=r.seq, state="buffering", pos=0, ahead=0)
    assert r.phase is Phase.PLAYING


def test_seek_storm_settles_on_last_value():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    ready_all(r, 0)
    t = r.anchor_ms
    for i in range(50):
        r.intent("a", "seek", r.seq, t + i * 20, pos=float(100 + i))
    assert r.pos == 149.0 and r.phase is Phase.PREPARING
    start = cmds(ready_all(r, t + 2000), "start")
    assert len(start) == 1 and start[0]["pos"] == 149.0


def test_duplicate_play_is_ignored():
    r = room_with_two()
    r.intent("a", "play", 0, 0)
    seq = r.seq
    assert r.intent("b", "play", seq, 5) == []
    assert r.seq == seq


def test_end_of_film_pauses():
    r = RoomState(code="t", duration=10.0)
    r.join("a", "Arun", 0, is_admin=True)
    r.intent("a", "play", 0, 0)
    r.status("a", 0, seq=r.seq, state="ready", pos=0, ahead=10)
    eff = r.tick(r.anchor_ms + 11_000)
    assert cmds(eff, "pause") and r.phase is Phase.PAUSED
