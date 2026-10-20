"""Media job runner: URL imports, then probe -> package -> profile, one film at a time.

Run as its own process (`python -m app.media.worker`), at nice 19 so playback and the API
never compete with it for the 2 vCPUs. State lives in the movies table, so a crash or a
restart simply resumes from the last status.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import httpx
from sqlalchemy import select

from ..config import settings
from ..db import Movie, init_db, session
from . import pipeline

log = logging.getLogger("msync.worker")
POLL_S = 2.0


def _update(movie_id: str, **fields) -> None:
    with session() as s:
        m = s.get(Movie, movie_id)
        if m:
            for k, v in fields.items():
                setattr(m, k, v)


def _next_job() -> Optional[tuple[str, str]]:
    with session() as s:
        m = s.scalars(select(Movie).where(Movie.status.in_(["downloading", "queued"]))
                      .order_by(Movie.created_at)).first()
        return (m.id, m.status) if m else None


def _free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


# ---- URL import ------------------------------------------------------------------------------

def download(movie_id: str) -> None:
    with session() as s:
        m = s.get(Movie, movie_id)
        url = m.source_url if m else None
    if not url or not url.startswith(("http://", "https://")):
        _update(movie_id, status="failed", error="Only http and https links can be imported.")
        return
    settings.incoming_dir.mkdir(parents=True, exist_ok=True)
    dest = settings.incoming_dir / f"{movie_id}.src"
    _update(movie_id, started_at=time.time(), progress=0.0)
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0)) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            if total and total > _free_bytes(settings.data_dir) * 0.45:
                raise RuntimeError("Not enough free disk to download and package this file.")
            got, last = 0, 0.0
            with dest.open("wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
                    got += len(chunk)
                    if total and time.time() - last > 1.0:
                        last = time.time()
                        _update(movie_id, progress=got / total, size_bytes=got)
        _update(movie_id, status="queued", source_path=str(dest), progress=0.0, size_bytes=got)
    except Exception as e:  # noqa: BLE001 - surface any failure to the admin
        dest.unlink(missing_ok=True)
        _update(movie_id, status="failed", error=f"Download failed: {e}")


# ---- processing ------------------------------------------------------------------------------

STALL_S = 600  # no progress for this long: ffmpeg is stuck, fail the job instead of hanging


def _run_ffmpeg(cmd: list[str], duration: float, on_progress: Callable[[float], None]) -> None:
    # stderr goes to a file, never a pipe: copied MKV streams can print thousands of timestamp
    # warnings, and an unread pipe fills at 64 KB and blocks ffmpeg forever.
    with tempfile.TemporaryFile(mode="w+") as errf:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, text=True)
        last_progress = [time.monotonic()]
        stalled = [False]

        def watchdog() -> None:
            while proc.poll() is None:
                if time.monotonic() - last_progress[0] > STALL_S:
                    stalled[0] = True
                    proc.kill()
                    return
                time.sleep(5)

        threading.Thread(target=watchdog, daemon=True).start()
        last = 0.0
        assert proc.stdout is not None
        for line in proc.stdout:
            last_progress[0] = time.monotonic()
            if line.startswith("out_time_us=") and duration > 0:
                try:
                    t = int(line.split("=", 1)[1]) / 1e6
                except ValueError:
                    continue
                if time.time() - last > 1.0:
                    last = time.time()
                    on_progress(max(0.0, min(t / duration, 0.999)))
        code = proc.wait()
        if stalled[0]:
            raise RuntimeError(f"ffmpeg made no progress for {STALL_S // 60} minutes and was stopped")
        if code != 0:
            errf.seek(0)
            lines = [ln for ln in errf.read().strip().splitlines() if ln.strip()]
            raise RuntimeError(lines[-1] if lines else "ffmpeg failed")


def process(movie_id: str) -> None:
    with session() as s:
        m = s.get(Movie, movie_id)
        if not m:
            return
        src = Path(m.source_path or "")
        transcode, audio_index = bool(m.transcode), m.audio_index
    if not src.is_file():
        _update(movie_id, status="failed", error="The uploaded file is missing.")
        return

    _update(movie_id, status="processing", progress=0.0, started_at=time.time(), error=None)
    out = settings.media_dir / movie_id
    tmp = settings.media_dir / f".{movie_id}.tmp"
    try:
        pr = subprocess.run(pipeline.probe_cmd(src), capture_output=True, text=True, timeout=120)
        if pr.returncode != 0:
            raise pipeline.ProbeError("This file could not be read as a video.")
        probe = json.loads(pr.stdout)
        plan = pipeline.decide(probe, audio_index=audio_index, transcode=transcode)
        _update(movie_id, duration=plan.duration, video_codec=plan.video_codec,
                audio_codec=plan.audio_codec, width=plan.width, height=plan.height,
                audio_tracks=json.dumps(pipeline.audio_tracks(probe)))
        tracks = pipeline.audio_tracks(probe)
        if len(tracks) > 1 and audio_index is None:
            # several languages: ask the host which one to keep before packaging
            _update(movie_id, status="choose_audio", progress=0.0,
                    note="This file has several audio tracks. Pick one.")
            return
        if plan.needs_transcode:
            _update(movie_id, status="needs_transcode", note=plan.needs_transcode, progress=0.0)
            return
        if src.stat().st_size * 1.1 > _free_bytes(settings.data_dir):
            raise RuntimeError("Not enough free disk to package this film.")

        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        _run_ffmpeg(pipeline.package_cmd(src, tmp, plan), plan.duration,
                    lambda p: _update(movie_id, progress=p))
        subprocess.run(pipeline.poster_cmd(src, tmp, plan.duration * 0.12, plan.video_stream),
                       capture_output=True, timeout=300)
        prof = pipeline.build_profile(tmp)
        pipeline.write_json(tmp / "profile.json", prof)

        shutil.rmtree(out, ignore_errors=True)
        tmp.rename(out)
        size = sum(p.stat().st_size for p in out.iterdir() if p.is_file())
        subs = [{"lang": sp.lang, "label": sp.label, "file": sp.file} for sp in plan.subtitles]
        note = None
        if plan.skipped_subtitles:
            note = "Image subtitles skipped: " + ", ".join(plan.skipped_subtitles)
        _update(movie_id, status="ready", progress=1.0, size_bytes=size, codecs=plan.codecs,
                peak_mbps=prof["peak_mbps"], avg_mbps=prof["avg_mbps"],
                duration=prof["duration"], subtitles=json.dumps(subs), note=note,
                source_path=None)
        src.unlink(missing_ok=True)
        src.with_suffix(".info").unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(tmp, ignore_errors=True)
        log.exception("processing %s failed", movie_id)
        _update(movie_id, status="failed", error=str(e)[:500])


def recover() -> None:
    """A film left mid-processing by a crash goes back to the queue."""
    with session() as s:
        for m in s.scalars(select(Movie).where(Movie.status == "processing")):
            m.status, m.progress = "queued", 0.0


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    init_db()
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    recover()
    log.info("worker ready, media dir %s", settings.media_dir)
    while True:
        job = _next_job()
        if not job:
            time.sleep(POLL_S)
            continue
        movie_id, status = job
        log.info("job %s (%s)", movie_id, status)
        if status == "downloading":
            download(movie_id)
        else:
            process(movie_id)


if __name__ == "__main__":
    main()
