from pathlib import Path

import pytest

from app.media.pipeline import ProbeError, build_profile, decide, package_cmd


def probe(video, audios=(), subs=(), duration=7200.0):
    streams = [dict(index=0, codec_type="video", **video)]
    for i, a in enumerate(audios, start=1):
        streams.append(dict(index=i, codec_type="audio", **a))
    for j, s in enumerate(subs, start=len(streams)):
        streams.append(dict(index=j, codec_type="subtitle", **s))
    return {"format": {"duration": str(duration)}, "streams": streams}


H264 = dict(codec_name="h264", profile="High", pix_fmt="yuv420p", level=41, width=1920, height=1080)


def test_h264_aac_is_pure_copy():
    p = decide(probe(H264, [dict(codec_name="aac", channels=2)]))
    assert (p.video_mode, p.audio_mode, p.needs_transcode) == ("copy", "copy", None)
    assert p.codecs == "avc1.640029,mp4a.40.2"


def test_ac3_audio_is_reencoded_but_video_copied():
    p = decide(probe(H264, [dict(codec_name="ac3", channels=6)]))
    assert p.video_mode == "copy" and p.audio_mode == "aac"


def test_hevc_10bit_copies_with_hvc1_tag():
    p = decide(probe(dict(codec_name="hevc", profile="Main 10", pix_fmt="yuv420p10le", level=150)))
    assert p.video_mode == "copy" and p.hvc1_tag and p.needs_transcode is None
    assert p.codecs.startswith("hvc1.2.4.L150")
    cmd = package_cmd(Path("in.mkv"), Path("out"), p)
    assert "-tag:v" in cmd and "hvc1" in cmd


def test_h264_high10_needs_transcode_until_approved():
    v = dict(H264, profile="High 10", pix_fmt="yuv420p10le")
    p = decide(probe(v))
    assert p.needs_transcode
    p2 = decide(probe(v), transcode=True)
    assert p2.video_mode == "x264" and p2.needs_transcode is None
    assert "libx264" in package_cmd(Path("a"), Path("b"), p2)


def test_av1_needs_transcode():
    assert decide(probe(dict(codec_name="av1", pix_fmt="yuv420p"))).needs_transcode


def test_default_audio_track_and_explicit_choice():
    auds = [dict(codec_name="aac", disposition={"default": 0}, tags={"language": "hin"}),
            dict(codec_name="eac3", disposition={"default": 1}, tags={"language": "eng"})]
    assert decide(probe(H264, auds)).audio_stream == 2
    assert decide(probe(H264, auds), audio_index=1).audio_stream == 1


def test_cover_art_is_not_the_video():
    pr = probe(dict(codec_name="mjpeg", disposition={"attached_pic": 1}))
    pr["streams"].append(dict(index=5, codec_type="video", **H264))
    assert decide(pr).video_stream == 5


def test_text_subs_kept_image_subs_listed():
    subs = [dict(codec_name="subrip", tags={"language": "eng"}),
            dict(codec_name="hdmv_pgs_subtitle", tags={"language": "fra", "title": "French"})]
    p = decide(probe(H264, [dict(codec_name="aac")], subs))
    assert [s.lang for s in p.subtitles] == ["eng"]
    assert p.skipped_subtitles == ["French (hdmv_pgs_subtitle)"]
    assert "webvtt" in package_cmd(Path("a"), Path("b"), p)


def test_no_video_raises():
    with pytest.raises(ProbeError):
        decide({"format": {}, "streams": [{"index": 0, "codec_type": "audio", "codec_name": "aac"}]})


def test_profile_peak_window(tmp_path):
    # 10 segments of 6 s: 9 at 3 MB, one burst at 12 MB
    lines = ["#EXTM3U", "#EXT-X-MAP:URI=\"init.mp4\""]
    (tmp_path / "init.mp4").write_bytes(b"x" * 1000)
    for i in range(10):
        size = 12_000_000 if i == 4 else 3_000_000
        (tmp_path / f"seg_{i:05d}.m4s").write_bytes(b"\0" * size)
        lines += ["#EXTINF:6.000,", f"seg_{i:05d}.m4s"]
    (tmp_path / "index.m3u8").write_text("\n".join(lines))
    prof = build_profile(tmp_path)
    assert len(prof["segments"]) == 10 and prof["duration"] == 60.0
    assert prof["peak_mbps"] > prof["avg_mbps"]
    # window of 30 s containing the burst: (4*3+12) MB * 8 / 30 s = 6.4 Mbps
    assert abs(prof["peak_mbps"] - 6.4) < 0.01
