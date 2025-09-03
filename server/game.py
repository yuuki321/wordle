# Core game logic for Wordle and in-memory room management.
# Implements exact Wordle marking rules:
# - Use a two-pass algorithm to correctly handle duplicate letters.
# - First pass marks hits; second pass marks presents bounded by remaining counts.
# - Modification: when any player wins (all hits), the room is immediately ended
#   (room.game_over = True) and remaining active players are marked as lost.
#   This enforces immediate server-side game-over across all clients.

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
    # Load 5-letter words; ensure lowercase and alphabetic.
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
    # Implements Wordle duplicate rules.
    answer = answer.lower()
    guess = guess.lower()
    marks = ["miss"] * 5
    # First pass: hits
    answer_counts: Dict[str, int] = {}
    for i in range(5):
        if guess[i] == answer[i]:
            marks[i] = "hit"
        else:
            answer_counts[answer[i]] = answer_counts.get(answer[i], 0) + 1
    # Second pass: presents
    for i in range(5):
        if marks[i] == "hit":
            continue
        ch = guess[i]
        if answer_counts.get(ch, 0) > 0:
            marks[i] = "present"
            answer_counts[ch] -= 1
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
        """
        Submit a guess for a player. Returns GuessFeedback for that guess.
        Server-side enforcement: if the guess results in all hits (player wins),
        the room is immediately marked game_over and all other active non-spectator
        players who are still 'playing' are marked as 'lost'. This makes the server
        authoritative for immediate multi-player end-on-first-win behavior.
        """
        if self.game_over:
            raise ValueError("Game already over for this room.")

        p = self.players.get(player_id)
        if not p:
            raise ValueError("Player not in room.")
        if p.is_spectator:
            raise ValueError("Spectators cannot guess.")
        if p.status != "playing":
            raise ValueError("Player already finished.")

        # Apply Wordle scoring.
        marks = score_guess(self.answer, guess)
        p.rounds_used += 1
        feedback = GuessFeedback(guess=guess, marks=marks)
        p.guesses.append(feedback)
        p.last_guess_ts = time.time()

        # If this player got all hits -> they win.
        if all(m == "hit" for m in marks):
            p.status = "won"
            # Register winner if not already
            if player_id not in self.winner_ids:
                self.winner_ids.append(player_id)

            # Immediately end the room when the first win occurs.
            # Mark game_over true and mark other active players as lost.
            self.game_over = True
            # For all players who are still playing (and not spectators), mark lost.
            for pid, other in self.players.items():
                if other.is_spectator:
                    continue
                if pid == player_id:
                    continue
                if other.status == "playing":
                    other.status = "lost"
            # Room ends now. Return feedback for the submitter.
            return feedback

        # If not a win, check if this player has exhausted max rounds -> they lose.
        if p.rounds_used >= self.max_rounds:
            p.status = "lost"

        # Room over when all players either won or lost; spectators are ignored.
        active_players = [pl for pl in self.players.values() if not pl.is_spectator]
        if all(pl.status in ("won", "lost") for pl in active_players):
            self.game_over = True

        return feedback

# In-memory room registry.
ROOMS: Dict[str, Room] = {}

def new_room_id() -> str:
    import secrets
    # Short code 6 chars for UX; collisions extremely unlikely
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