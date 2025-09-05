# Simple SQLite data layer using SQLAlchemy for high scores and logging.

from __future__ import annotations
from sqlalchemy import create_engine, Column, Integer, String, DateTime, func, Boolean, delete
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
    fastest_win = Column(Integer, nullable=True)  # rounds (lower is better)

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
    """
    Return leaderboard entries sorted by:
     - wins DESC (more wins is better)
     - losses ASC (fewer losses is better)
     - fastest_win ASC (fewer guesses to win is better), nulls last

    Also compute tied ranks: equal (wins, losses, fastest_win) receive same rank,
    and subsequent ranks skip accordingly (1,1,3).
    """
    with SessionLocal() as s:
        rows = s.execute(select(HighScore)).scalars().all()

    # Convert to dictionaries and prepare sortable keys
    entries = []
    for r in rows:
        entries.append({
            "player_id": r.player_id,
            "nickname": r.nickname,
            "wins": int(r.wins or 0),
            "losses": int(r.losses or 0),
            # fastest_win may be None; keep as None for sorting nulls last
            "fastest_win": int(r.fastest_win) if r.fastest_win is not None else None
        })

    # Sort according to rules
    # wins DESC, losses ASC, fastest_win ASC (None treated as large)
    def sort_key(e):
        return (-e["wins"], e["losses"], e["fastest_win"] if e["fastest_win"] is not None else 9999)

    entries.sort(key=sort_key)

    # Now assign ranks with ties: same key -> same rank
    ranked = []
    last_key = None
    last_rank = 0
    items_before = 0
    for idx, e in enumerate(entries):
        key = (e["wins"], e["losses"], e["fastest_win"] if e["fastest_win"] is not None else None)
        if key == last_key:
            rank = last_rank
        else:
            rank = items_before + 1
            last_key = key
            last_rank = rank
        e_out = {
            "player_id": e["player_id"],
            "nickname": e["nickname"],
            "wins": e["wins"],
            "losses": e["losses"],
            "fastest_win": e["fastest_win"],
            "rank": rank
        }
        ranked.append(e_out)
        items_before += 1
        if len(ranked) >= limit:
            break

    return ranked

def clear_leaderboard():
    # Deletes all leaderboard and game log rows
    from sqlalchemy import delete
    with SessionLocal() as s:
        s.execute(delete(HighScore))
        s.execute(delete(GameLog))
        s.commit()