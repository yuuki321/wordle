# Pydantic models and data structures for API IO.

from __future__ import annotations
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Dict, Literal

GuessMark = Literal["hit", "present", "miss"]

class GuessRequest(BaseModel):
    room_id: str = Field(..., description="Room code")
    player_id: str = Field(..., description="Client-generated stable ID")
    guess: str = Field(..., description="5-letter guess")
    token: Optional[str] = Field(None, description="Join token issued by server")
    timestamp_ms: Optional[int] = None

    @field_validator("guess")
    @classmethod
    def validate_guess(cls, v: str) -> str:
        if not isinstance(v, str):
            raise ValueError("guess must be a string")
        w = v.strip().lower()
        if len(w) != 5 or not w.isalpha():
            raise ValueError("guess must be a 5-letter English word")
        return w

class JoinRoomRequest(BaseModel):
    room_id: Optional[str] = Field(None, description="Join an existing room; if omitted, create new")
    player_id: str = Field(..., description="Client-generated stable ID")
    nickname: str = Field(..., description="Display name")
    max_rounds: Optional[int] = Field(None, description="Only used when creating a new room")
    word_list_name: Optional[str] = Field(None, description="Reserved; currently single list")
    spectate: bool = False

class JoinRoomResponse(BaseModel):
    room_id: str
    token: str
    max_rounds: int
    accepted: bool
    role: Literal["player", "spectator"]
    message: str

class GuessFeedback(BaseModel):
    guess: str
    marks: List[GuessMark]

class PlayerPublicState(BaseModel):
    player_id: str
    nickname: str
    guesses: List[GuessFeedback]
    status: Literal["playing", "won", "lost"]
    rounds_used: int

class RoomStateResponse(BaseModel):
    room_id: str
    max_rounds: int
    your_id: str
    you_status: Literal["playing", "won", "lost", "spectating"]
    you_rounds_used: int
    players: List[PlayerPublicState]
    total_players: int
    game_over: bool
    winner_ids: List[str]
    reveal_answer: bool
    # Only if reveal_answer True; otherwise omitted
    answer: Optional[str] = None
    leaderboard: Optional[List[Dict]] = None

class RevealRequest(BaseModel):
    room_id: str
    player_id: str
    token: str

class HighScoreEntry(BaseModel):
    player_id: str
    nickname: str
    wins: int
    losses: int
    fastest_win: Optional[int] = None