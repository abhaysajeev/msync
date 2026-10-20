"""Decide how to turn an uploaded file into single-rendition fMP4 HLS, and build the commands.

Pure functions only (probe dict in, plan / argv out) so the decisions are unit-tested.
The rule: never re-encode video unless the admin explicitly approves it. Audio that browsers
cannot play is re-encoded to AAC stereo, which costs a few CPU-minutes per film.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

SEGMENT_SECONDS = 6
TEXT_SUBS = {"subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"}
IMAGE_SUBS = {"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"}
H264_OK_PROFILES = {"baseline", "constrained baseline", "main", "high"}
H264_OK_PIX = {"yuv420p", "yuvj420p"}
HEVC_OK_PIX = {"yuv420p", "yuvj420p", "yuv420p10le"}


@dataclass
class SubtitlePlan:
    stream: int
    lang: str
    label: str
    file: str


@dataclass
class Plan:
    video_stream: int
    video_codec: str
    video_mode: str                     # copy | x264
    hvc1_tag: bool
    audio_stream: Optional[int]
    audio_codec: Optional[str]
    audio_mode: str                     # copy | aac | none
    subtitles: list[SubtitlePlan] = field(default_factory=list)
    skipped_subtitles: list[str] = field(default_factory=list)
    needs_transcode: Optional[str] = None   # reason, when video cannot be copied
    codecs: str = ""
    width: int = 0
    height: int = 0
    duration: float = 0.0


class ProbeError(ValueError):
    pass


def _tag(stream: dict, key: str) -> str:
    return (stream.get("tags") or {}).get(key, "") or ""


def _avc_codec_string(v: dict) -> str:
    prof = (v.get("profile") or "").lower()
    idc = {"constrained baseline": (0x42, 0x40), "baseline": (0x42, 0x00),
           "main": (0x4D, 0x00), "high": (0x64, 0x00)}.get(prof, (0x64, 0x00))
    level = int(v.get("level") or 40)
    return f"avc1.{idc[0]:02X}{idc[1]:02X}{level:02X}"


def _hevc_codec_string(v: dict) -> str:
    ten_bit = (v.get("pix_fmt") or "").endswith("10le")
    level = int(v.get("level") or 120)
    return f"hvc1.{2 if ten_bit else 1}.{4 if ten_bit else 6}.L{level}.B0"


def decide(probe: dict, *, audio_index: Optional[int] = None, transcode: bool = False) -> Plan:
    streams = probe.get("streams") or []
    videos = [s for s in streams if s.get("codec_type") == "video"
              and not (s.get("disposition") or {}).get("attached_pic")]
    if not videos:
        raise ProbeError("No video stream found in this file.")
    v = videos[0]
    vcodec = (v.get("codec_name") or "").lower()
    pix = (v.get("pix_fmt") or "").lower()
    prof = (v.get("profile") or "").lower()
    duration = float((probe.get("format") or {}).get("duration") or v.get("duration") or 0)

    reason: Optional[str] = None
    hvc1 = False
    if vcodec == "h264":
        if prof not in H264_OK_PROFILES or pix not in H264_OK_PIX:
            reason = f"H.264 {v.get('profile')} {pix} does not play in browsers"
    elif vcodec == "hevc":
        hvc1 = True
        if pix not in HEVC_OK_PIX:
            reason = f"HEVC {pix} does not play in browsers"
    else:
        reason = f"{vcodec or 'unknown'} video does not play in browsers"

    video_mode = "copy"
    if reason and transcode:
        video_mode, hvc1, reason = "x264", False, None

    if video_mode == "x264":
        vcodec_str = "avc1.640029"
    elif vcodec == "hevc":
        vcodec_str = _hevc_codec_string(v)
    else:
        vcodec_str = _avc_codec_string(v)

    audios = [s for s in streams if s.get("codec_type") == "audio"]
    a: Optional[dict] = None
    if audio_index is not None:
        a = next((s for s in audios if s.get("index") == audio_index), None)
    if a is None and audios:
        a = next((s for s in audios if (s.get("disposition") or {}).get("default")), audios[0])
    if a is None:
        audio_mode, acodec = "none", None
    else:
        acodec = (a.get("codec_name") or "").lower()
        audio_mode = "copy" if acodec == "aac" else "aac"

    subs, skipped = [], []
    n = 0
    for s in streams:
        if s.get("codec_type") != "subtitle":
            continue
        c = (s.get("codec_name") or "").lower()
        lang = _tag(s, "language") or "und"
        label = _tag(s, "title") or lang
        if c in TEXT_SUBS:
            subs.append(SubtitlePlan(stream=s["index"], lang=lang, label=label, file=f"sub_{n}.vtt"))
            n += 1
        else:
            skipped.append(f"{label} ({c})")

    codecs = vcodec_str + (",mp4a.40.2" if audio_mode != "none" else "")
    return Plan(video_stream=v["index"], video_codec=vcodec, video_mode=video_mode, hvc1_tag=hvc1,
                audio_stream=a["index"] if a else None, audio_codec=acodec, audio_mode=audio_mode,
                subtitles=subs, skipped_subtitles=skipped, needs_transcode=reason, codecs=codecs,
                width=int(v.get("width") or 0), height=int(v.get("height") or 0), duration=duration)


def audio_tracks(probe: dict) -> list[dict]:
    out = []
    for s in probe.get("streams") or []:
        if s.get("codec_type") == "audio":
            out.append({"index": s["index"], "codec": s.get("codec_name"),
                        "channels": s.get("channels"), "lang": _tag(s, "language") or "und",
                        "title": _tag(s, "title"),
                        "default": bool((s.get("disposition") or {}).get("default"))})
    return out


def probe_cmd(src: Path) -> list[str]:
    return ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(src)]


def package_cmd(src: Path, out: Path, plan: Plan, threads: int = 2) -> list[str]:
    cmd = ["nice", "-n", "19", "ffmpeg", "-hide_banner", "-nostdin", "-y", "-nostats",
           "-progress", "pipe:1", "-i", str(src),
           "-map", f"0:{plan.video_stream}"]
    if plan.audio_stream is not None:
        cmd += ["-map", f"0:{plan.audio_stream}"]
    if plan.video_mode == "copy":
        cmd += ["-c:v", "copy"]
        if plan.hvc1_tag:
            cmd += ["-tag:v", "hvc1"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                "-profile:v", "high", "-level:v", "4.1", "-threads", str(threads),
                "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_SECONDS})"]
    if plan.audio_mode == "copy":
        cmd += ["-c:a", "copy"]
    elif plan.audio_mode == "aac":
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    cmd += ["-sn", "-dn", "-max_muxing_queue_size", "4096",
            "-f", "hls", "-hls_time", str(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
            "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_segment_filename", str(out / "seg_%05d.m4s"), str(out / "index.m3u8")]
    for sp in plan.subtitles:
        cmd += ["-map", f"0:{sp.stream}", "-c:s", "webvtt", "-f", "webvtt", str(out / sp.file)]
    return cmd


def poster_cmd(src: Path, out: Path, at: float, stream: int) -> list[str]:
    return ["nice", "-n", "19", "ffmpeg", "-hide_banner", "-nostdin", "-y", "-ss", f"{at:.2f}",
            "-i", str(src), "-map", f"0:{stream}", "-frames:v", "1",
            "-vf", "scale=640:-2", "-q:v", "4", str(out / "poster.jpg")]


_EXTINF = re.compile(r"#EXTINF:([\d.]+)")


def build_profile(out: Path, window_s: float = 30.0) -> dict:
    """Per-segment (duration, bytes), plus average and peak bitrate over a sliding window.

    The client uses the segment list to compute the exact prebuffer needed at its
    measured throughput, so peaks are respected, not just the average.
    """
    lines = (out / "index.m3u8").read_text().splitlines()
    segs: list[list[float]] = []
    dur: Optional[float] = None
    for ln in lines:
        m = _EXTINF.match(ln)
        if m:
            dur = float(m.group(1))
        elif ln and not ln.startswith("#") and dur is not None:
            segs.append([round(dur, 3), (out / ln).stat().st_size])
            dur = None
    init = (out / "init.mp4").stat().st_size if (out / "init.mp4").exists() else 0
    total_d = sum(d for d, _ in segs) or 1.0
    total_b = sum(b for _, b in segs) + init
    peak = 0.0
    j, acc_d, acc_b = 0, 0.0, 0
    for i in range(len(segs)):
        while j < len(segs) and acc_d < window_s:
            acc_d += segs[j][0]
            acc_b += segs[j][1]
            j += 1
        if acc_d > 0:
            peak = max(peak, acc_b * 8 / acc_d / 1e6)
        acc_d -= segs[i][0]
        acc_b -= segs[i][1]
    return {"duration": round(total_d, 3), "init_bytes": init, "segments": segs,
            "avg_mbps": round(total_b * 8 / total_d / 1e6, 2), "peak_mbps": round(peak, 2),
            "window_s": window_s}


def write_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    tmp.replace(path)
