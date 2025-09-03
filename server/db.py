# Simple SQLite data layer using SQLAlchemy for high scores and logging.

from __future__ import annotations
from sqlalchemy import create_engine, Column, Integer, String, DateTime, func, Boolean
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.sql import select
from pathlib import Path
from typing import Optional, List, Tuple
from .config import DB_PATH

Base = declarative_base()

class HighScore(Base):
    __tablename__ = "high_scores"
    id = Column(Integer, primary_key=True)
    player_id = Column(String, index=True, nullable=False)
    nickname = Column(String, nullable=False)
    wins = Column(Integer, default=0)
    losses = Column(Integer, default=0)
    fastest_win = Column(Integer, nullable=True)  # rounds

class GameLog(Base):
    __tablename__ = "game_log"
    id = Column(Integer, primary_key=True)
    room_id = Column(String, index=True, nullable=False)
    player_id = Column(String, index=True, nullable=False)
    nickname = Column(String, nullable=False)
    outcome = Column(String, nullable=False)  # "win"/"loss"
    rounds_used = Column(Integer, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    was_creator = Column(Boolean, default=False)

_engine = create_engine(f"sqlite:///{DB_PATH}", echo=False, future=True)
SessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False, future=True)

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(_engine)

def record_result(player_id: str, nickname: str, won: bool, rounds_used: int, room_id: str, was_creator: bool):
    with SessionLocal() as s:
        # Upsert-like behavior
        hs = s.execute(select(HighScore).where(HighScore.player_id == player_id)).scalar_one_or_none()
        if hs is None:
            hs = HighScore(player_id=player_id, nickname=nickname, wins=0, losses=0, fastest_win=None)
            s.add(hs)
        hs.nickname = nickname  # keep latest nickname

        if won:
            hs.wins += 1
            if hs.fastest_win is None or rounds_used < hs.fastest_win:
                hs.fastest_win = rounds_used
        else:
            hs.losses += 1

        gl = GameLog(
            room_id=room_id,
            player_id=player_id,
            nickname=nickname,
            outcome="win" if won else "loss",
            rounds_used=rounds_used,
            was_creator=was_creator
        )
        s.add(gl)
        s.commit()

def top_leaderboard(limit: int = 10):
    with SessionLocal() as s:
        rows = s.execute(select(HighScore).order_by(HighScore.wins.desc(), HighScore.fastest_win.asc().nulls_last()).limit(limit)).scalars().all()
        return [
            {
                "player_id": r.player_id,
                "nickname": r.nickname,
                "wins": r.wins,
                "losses": r.losses,
                "fastest_win": r.fastest_win
            }
            for r in rows
        ]