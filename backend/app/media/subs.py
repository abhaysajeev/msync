"""Turn an added subtitle file (SRT, VTT, ASS/SSA) into WebVTT, optionally shifted in time.

SRT and VTT are converted here in pure Python; ASS/SSA go through ffmpeg. Text encodings
vary a lot in downloaded subtitle files (UTF-8 with or without BOM, UTF-16, Windows-1252),
so decoding tries them in turn.
"""
from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path

MAX_BYTES = 5 * 1024 * 1024
_TIME = re.compile(r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})")
_CUE_LINE = re.compile(r"^\s*(\S+)\s*-->\s*(\S+)(.*)$")
_DROP_TAGS = re.compile(r"</?font[^>]*>|\{\\[^}]*\}", re.IGNORECASE)


class SubtitleError(ValueError):
    pass


def decode(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise SubtitleError("Could not read the subtitle file's text encoding.")


def _parse_time(s: str) -> float:
    m = _TIME.fullmatch(s.strip())
    if not m:
        raise SubtitleError(f"Bad timestamp: {s!r}")
    h, mi, se, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(se) + int(ms.ljust(3, "0")) / 1000


def _fmt_time(t: float) -> str:
    t = max(0.0, t)
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def srt_or_vtt_to_vtt(text: str, offset: float = 0.0) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    lines = text.split("\n")
    if lines and lines[0].startswith("WEBVTT"):
        lines = lines[1:]
    out = ["WEBVTT", ""]
    cues = 0
    for ln in lines:
        m = _CUE_LINE.match(ln)
        if m:
            start, end = _parse_time(m.group(1)) + offset, _parse_time(m.group(2)) + offset
            if end <= 0:
                out.append("NOTE dropped: before the film starts")
                continue
            out.append(f"{_fmt_time(start)} --> {_fmt_time(end)}{m.group(3)}")
            cues += 1
        else:
            out.append(_DROP_TAGS.sub("", ln))
    if not cues:
        raise SubtitleError("No subtitle timings found in this file.")
    return "\n".join(out).rstrip() + "\n"


def to_vtt(data: bytes, filename: str, offset: float = 0.0) -> str:
    if len(data) > MAX_BYTES:
        raise SubtitleError("Subtitle files are limited to 5 MB.")
    ext = Path(filename).suffix.lower()
    if ext in (".srt", ".vtt", ".txt", ""):
        return srt_or_vtt_to_vtt(decode(data), offset)
    if ext in (".ass", ".ssa"):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / f"in{ext}"
            src.write_text(decode(data), encoding="utf-8")
            r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(src),
                                "-f", "webvtt", str(Path(d) / "out.vtt")],
                               capture_output=True, text=True, timeout=60)
            if r.returncode != 0:
                raise SubtitleError("This ASS/SSA file could not be converted.")
            return srt_or_vtt_to_vtt((Path(d) / "out.vtt").read_text(encoding="utf-8"), offset)
    raise SubtitleError("Use an .srt, .vtt, .ass or .ssa subtitle file.")

