"""End-to-end over HTTP + WebSocket: login, room, knock, admit, barrier, chat, kick."""
import json

from fastapi.testclient import TestClient

from app.db import Movie, session
from app.main import app


def recv_until(ws, t, kind=None, limit=30):
    for _ in range(limit):
        msg = json.loads(ws.receive_text())
        if msg["t"] == t and (kind is None or msg.get("kind") == kind):
            return msg
    raise AssertionError(f"never got {t}/{kind}")


def make_ready_movie():
    with session() as s:
        m = Movie(title="Test film", status="ready", duration=600.0)
        s.add(m)
        s.flush()
        return m.id


def test_full_flow():
    with TestClient(app) as host, TestClient(app) as guest:
        assert host.post("/api/admin/login", json={"password": "nope"}).status_code == 401
        assert host.post("/api/admin/login", json={"password": "test-password-123"}).status_code == 200
        assert host.get("/api/me").json()["admin"] is True

        mid = make_ready_movie()
        room = host.post("/api/rooms", json={"name": "Friday", "movie_id": mid}).json()
        code = room["code"]

        # guest cannot get in before admission
        assert guest.get(f"/api/rooms/{code}/session").status_code == 403
        assert guest.get("/api/rooms/{code}/public".format(code=code)).json()["movie_title"] == "Test film"
        k = guest.post(f"/api/rooms/{code}/knock", json={"name": "Meera"}).json()
        assert k["status"] == "knocking"

        with host.websocket_connect(f"/ws/rooms/{code}") as hws:
            recv_until(hws, "welcome")
            knocks = recv_until(hws, "knocks")
            assert knocks["knocks"][0]["name"] == "Meera"

            assert host.post(f"/api/rooms/{code}/guests/{k['id']}/admit").json()["status"] == "admitted"
            assert guest.get(f"/api/rooms/{code}/knock").json()["status"] == "admitted"
            assert guest.get(f"/api/rooms/{code}/session").status_code == 200

            # media auth: guest may fetch only this room's film
            ok = guest.get("/api/auth/media", headers={"x-forwarded-uri": f"/media/{mid}/index.m3u8"})
            assert ok.status_code == 200
            bad = guest.get("/api/auth/media", headers={"x-forwarded-uri": "/media/ffffffffffff/x"})
            assert bad.status_code == 403

            with guest.websocket_connect(f"/ws/rooms/{code}") as gws:
                snap = recv_until(gws, "snapshot")
                assert snap["phase"] == "paused"

                # clock ping
                gws.send_text(json.dumps({"t": "ping", "t0": 123.0}))
                pong = recv_until(gws, "pong")
                assert pong["t0"] == 123.0 and pong["t2"] >= pong["t1"]

                gws.send_text(json.dumps({"t": "intent", "kind": "play", "base_seq": snap["seq"]}))
                prep = recv_until(hws, "cmd", "prepare")
                recv_until(gws, "cmd", "prepare")
                for ws in (hws, gws):
                    ws.send_text(json.dumps({"t": "status", "seq": prep["seq"], "state": "ready",
                                             "pos": 0, "ahead": 20}))
                s1 = recv_until(hws, "cmd", "start")
                s2 = recv_until(gws, "cmd", "start")
                assert s1["at"] == s2["at"] and s1["seq"] == prep["seq"]

                gws.send_text(json.dumps({"t": "chat", "text": "popcorn ready", "nonce": "n1"}))
                c = recv_until(hws, "chat")
                assert c["text"] == "popcorn ready" and c["name"] == "Meera"

                # kick closes the guest socket and blocks re-entry
                host.post(f"/api/rooms/{code}/guests/{k['id']}/kick")
                recv_until(gws, "kicked")
            assert guest.get(f"/api/rooms/{code}/session").status_code == 403


def test_bandwidth_endpoint_requires_identity_and_streams():
    with TestClient(app) as c:
        assert c.get("/api/bw").status_code == 403
        c.post("/api/admin/login", json={"password": "test-password-123"})
        r = c.get("/api/bw?bytes=200000")
        assert r.status_code == 200 and len(r.content) == 200000


def test_tusd_precreate_rejects_strangers():
    with TestClient(app) as c:
        r = c.post("/api/hooks/tusd", json={"Type": "pre-create", "Event": {"Upload": {"Size": 10}}})
        assert r.json()["RejectUpload"] is True
