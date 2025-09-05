# Core game logic for Wordle and in-memory room management.
# Implements canonical Wordle marking rules:
# - Two-pass algorithm: first mark hits (exact position), then mark presents
#   up to the remaining counts of each letter in the answer (excluding hits).
# - This ensures multiple 'present' occurrences are handled correctly.
# - When any player wins (all hits), the room is immediately ended and other
#   active players are marked as lost.

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import random
import time
from itsdangerous import TimestampSigner, BadSignature
from .config import DEFAULT_MAX_ROUNDS, SECRET_KEY, WORDS_PATH, ALLOW_SPECTATORS
from .models import GuessFeedback

_signer = TimestampSigner(SECRET_KEY)

def load_words() -> List[str]:
    words = []
    with open(WORDS_PATH, "r", encoding="utf-8") as f:
        for line in f:
            w = line.strip().lower()
            if len(w) == 5 and w.isalpha():
                words.append(w)
    if not words:
        raise RuntimeError("Word list is empty or missing.")
    return words

WORDS = load_words()

def choose_answer() -> str:
    return random.choice(WORDS)

def score_guess(answer: str, guess: str) -> List[str]:
    answer = answer.lower()
    guess = guess.lower()
    marks: List[str] = ["miss"] * 5

    # First pass: mark hits
    for i in range(5):
        if guess[i] == answer[i]:
            marks[i] = "hit"

    # Second pass: mark presents if the letter is in the answer
    for i in range(5):
        if marks[i] == "hit":
            continue
        ch = guess[i]
        if ch in answer:
            marks[i] = "present"
        else:
            marks[i] = "miss"

    return marks

@dataclass
class PlayerState:
    player_id: str
    nickname: str
    guesses: List[GuessFeedback] = field(default_factory=list)
    status: str = "playing"  # "playing"|"won"|"lost"
    rounds_used: int = 0
    last_guess_ts: float = 0.0
    is_spectator: bool = False
    was_creator: bool = False

@dataclass
class Room:
    room_id: str
    answer: str
    max_rounds: int
    players: Dict[str, PlayerState] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    game_over: bool = False
    winner_ids: List[str] = field(default_factory=list)

    def add_player(self, player_id: str, nickname: str, is_spectator: bool, was_creator: bool) -> None:
        if player_id not in self.players:
            self.players[player_id] = PlayerState(
                player_id=player_id,
                nickname=nickname,
                is_spectator=is_spectator,
                was_creator=was_creator
            )

    def submit_guess(self, player_id: str, guess: str) -> GuessFeedback:
        if self.game_over:
            raise ValueError("Game already over for this room.")

        p = self.players.get(player_id)
        if not p:
            raise ValueError("Player not in room.")
        if p.is_spectator:
            raise ValueError("Spectators cannot guess.")
        if p.status != "playing":
            raise ValueError("Player already finished.")

        marks = score_guess(self.answer, guess)
        p.rounds_used += 1
        feedback = GuessFeedback(guess=guess, marks=marks)
        p.guesses.append(feedback)
        p.last_guess_ts = time.time()

        # Win handling: if all marks are 'hit' -> player wins, room ends immediately
        if all(m == "hit" for m in marks):
            p.status = "won"
            if player_id not in self.winner_ids:
                self.winner_ids.append(player_id)
            # End room immediately and mark others (non-spectator) who are playing as lost
            self.game_over = True
            for pid, other in self.players.items():
                if other.is_spectator or pid == player_id:
                    continue
                if other.status == "playing":
                    other.status = "lost"
            return feedback

        # If not win, check if player exhausted rounds
        if p.rounds_used >= self.max_rounds:
            p.status = "lost"

        # If all non-spectator players have terminal status, mark room over
        active_players = [pl for pl in self.players.values() if not pl.is_spectator]
        if active_players and all(pl.status in ("won", "lost") for pl in active_players):
            self.game_over = True

        return feedback

# In-memory room registry.
ROOMS: Dict[str, Room] = {}

def new_room_id() -> str:
    import secrets
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))

def create_room(nickname: str, player_id: str, max_rounds: Optional[int]) -> Tuple[Room, str]:
    rid = new_room_id()
    ans = choose_answer()
    mr = max_rounds if (isinstance(max_rounds, int) and 1 <= max_rounds <= 10) else DEFAULT_MAX_ROUNDS
    room = Room(room_id=rid, answer=ans, max_rounds=mr)
    ROOMS[rid] = room
    room.add_player(player_id=player_id, nickname=nickname, is_spectator=False, was_creator=True)
    token = issue_token(rid, player_id)
    return room, token

def join_room(room_id: str, nickname: str, player_id: str, spectate: bool = False) -> Tuple[Room, str]:
    room = ROOMS.get(room_id)
    if not room:
        raise ValueError("Room not found.")
    if spectate and not ALLOW_SPECTATORS:
        raise ValueError("Spectators are disabled on this server.")
    room.add_player(player_id=player_id, nickname=nickname, is_spectator=spectate, was_creator=False)
    token = issue_token(room_id, player_id)
    return room, token

def issue_token(room_id: str, player_id: str) -> str:
    return _signer.sign(f"{room_id}:{player_id}".encode()).decode()

def verify_token(token: str, room_id: str, player_id: str) -> bool:
    try:
        data = _signer.unsign(token, max_age=60 * 60 * 8).decode()  # 8h validity
        rid, pid = data.split(":")
        return rid == room_id and pid == player_id
    except BadSignature:
        return False

def room_public_state(room: Room) -> dict:
    players = []
    for p in room.players.values():
        if p.is_spectator:
            continue
        players.append({
            "player_id": p.player_id,
            "nickname": p.nickname,
            "guesses": [GuessFeedback(guess=g.guess, marks=g.marks).model_dump() for g in p.guesses],
            "status": p.status,
            "rounds_used": p.rounds_used,
        })
    return {
        "room_id": room.room_id,
        "max_rounds": room.max_rounds,
        "players": players,
        "total_players": len([p for p in room.players.values() if not p.is_spectator]),
        "game_over": room.game_over,
        "winner_ids": list(room.winner_ids),
    }