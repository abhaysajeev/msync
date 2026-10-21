import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import Movie, session
from app.main import app
from app.media.subs import SubtitleError, to_vtt

SRT = """1
00:00:01,500 --> 00:00:03,000
<font color="#ffff00">Hello</font> {\\an8}there

2
00:01:02,250 --> 00:01:04,000
<i>Second line</i>
"""


def test_srt_becomes_vtt_with_dots_and_clean_tags():
    out = to_vtt(SRT.encode(), "film.srt")
    assert out.startswith("WEBVTT\n")
    assert "00:00:01.500 --> 00:00:03.000" in out
    assert "Hello there" in out and "<font" not in out and "{\\an8}" not in out
    assert "<i>Second line</i>" in out  # VTT keeps italics


def test_offset_shifts_and_drops_cues_before_zero():
    out = to_vtt(SRT.encode(), "film.srt", offset=-2.0)
    assert "00:00:00.000 --> 00:00:01.000" in out
    assert "00:01:00.250 --> 00:01:02.000" in out
    out2 = to_vtt(SRT.encode(), "film.srt", offset=-5.0)
    assert "NOTE dropped" in out2 and "00:00:57.250" in out2


def test_windows_1252_and_utf16_files_decode():
    text = SRT.replace("Hello", "Café")
    assert "Café" in to_vtt(text.encode("cp1252"), "a.srt")
    assert "Café" in to_vtt(text.encode("utf-16"), "a.srt")


def test_rejects_junk():
    with pytest.raises(SubtitleError):
        to_vtt(b"not a subtitle", "a.srt")
    with pytest.raises(SubtitleError):
        to_vtt(SRT.encode(), "a.pdf")


def test_add_shift_delete_endpoints():
    with session() as s:
        m = Movie(title="Sub film", status="ready", duration=100.0)
        s.add(m)
        s.flush()
        mid = m.id
    (settings.media_dir / mid).mkdir(parents=True, exist_ok=True)
    with TestClient(app) as c:
        assert c.post(f"/api/movies/{mid}/subtitles?filename=a.srt", content=SRT).status_code == 401
        c.post("/api/admin/login", json={"password": "test-password-123"})
        r = c.post(f"/api/movies/{mid}/subtitles?filename=Film.en.srt&label=English&lang=en", content=SRT.encode())
        assert r.status_code == 200
        sub = r.json()["subtitles"][0]
        assert sub["label"] == "English" and (settings.media_dir / mid / sub["file"]).exists()

        r = c.post(f"/api/movies/{mid}/subtitles/{sub['file']}/shift", json={"offset": 1.5})
        new = r.json()["subtitles"][0]
        assert new["file"] != sub["file"]  # new name, so cached copies are not reused
        assert not (settings.media_dir / mid / sub["file"]).exists()
        assert "00:00:03.000 --> 00:00:04.500" in (settings.media_dir / mid / new["file"]).read_text()

        assert c.delete(f"/api/movies/{mid}/subtitles/{new['file']}").json()["subtitles"] == []
        assert c.post(f"/api/movies/{mid}/subtitles?filename=x.srt", content=b"junk").status_code == 400
