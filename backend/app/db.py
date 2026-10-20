"""SQLite persistence. Two people, a handful of films: SQLite is plenty."""
from __future__ import annotations

import time
import uuid
from contextlib import contextmanager
from typing import Iterator, Optional

from sqlalchemy import Float, Integer, String, Text, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def _id() -> str:
    return uuid.uuid4().hex[:12]


def now_s() -> float:
    return time.time()


class Movie(Base):
    __tablename__ = "movies"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    title: Mapped[str] = mapped_column(String(300))
    # downloading | queued | processing | choose_audio | ready | needs_transcode | failed
    status: Mapped[str] = mapped_column(String(20), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)   # 0..1 of current step
    source_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    transcode: Mapped[int] = mapped_column(Integer, default=0)    # admin approved full re-encode
    audio_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    duration: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    video_codec: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    audio_codec: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    codecs: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)  # RFC 6381 string
    peak_mbps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    avg_mbps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    subtitles: Mapped[str] = mapped_column(Text, default="[]")    # JSON list
    audio_tracks: Mapped[str] = mapped_column(Text, default="[]") # JSON list from probe
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=now_s)
    started_at: Mapped[Optional[float]] = mapped_column(Float, nullable=True)


class Room(Base):
    __tablename__ = "rooms"
    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    movie_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=now_s)


class Guest(Base):
    __tablename__ = "guests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    room_code: Mapped[str] = mapped_column(String(32), index=True)
    name: Mapped[str] = mapped_column(String(60))
    status: Mapped[str] = mapped_column(String(12), default="knocking")  # knocking|admitted|denied|kicked
    created_at: Mapped[float] = mapped_column(Float, default=now_s)


class ChatMessage(Base):
    __tablename__ = "chat"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    room_code: Mapped[str] = mapped_column(String(32), index=True)
    member_id: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(60))
    text: Mapped[str] = mapped_column(Text)
    ts: Mapped[float] = mapped_column(Float, default=now_s)

    def public(self) -> dict:
        return {"id": self.id, "member": self.member_id, "name": self.name,
                "text": self.text, "ts": self.ts}


settings.data_dir.mkdir(parents=True, exist_ok=True)
engine = create_engine(settings.db_url, connect_args={"check_same_thread": False})


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")      # api and worker share the file
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


SessionLocal = sessionmaker(engine, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)


@contextmanager
def session() -> Iterator[Session]:
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()
