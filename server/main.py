# FastAPI server implementing the Wordle API for single and multi-player.
# Provides:
# - POST /api/join: create or join room
# - POST /api/guess: submit a guess
# - GET  /api/state/{room_id}?player_id=...&token=...: get room state
# - POST /api/reveal: reveal answer when game over
# - GET  /api/words: get allowed words (for client validation optional)
# - GET  /api/leaderboard: top players
#
# Also serves the client static files on / (SPA).
#
# Run: uvicorn wordle.server.main:app --host 0.0.0.0 --port 8000

from __future__ import annotations
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from typing import Optional
from .config import CORS_ORIGINS
from .models import (
    JoinRoomRequest, JoinRoomResponse, GuessRequest, RoomStateResponse, RevealRequest
)
from .game import (
    create_room, join_room, ROOMS, room_public_state, verify_token
)
from .game import WORDS
from .db import init_db, record_result, top_leaderboard

app = FastAPI(title="Multi-Player Wordle", version="1.0.0")

# CORS for dev convenience
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# Initialize database on startup
@app.on_event("startup")
def startup():
    init_db()

# Serve client static files
CLIENT_DIR = Path(__file__).parents[1] / "client"
app.mount("/static", StaticFiles(directory=str(CLIENT_DIR)), name="static")

@app.get("/", response_class=HTMLResponse)
def index():
    # Serve index.html
    p = CLIENT_DIR / "index.html"
    return HTMLResponse(p.read_text(encoding="utf-8"))

@app.get("/api/words")
def list_words():
    # Optional endpoint — client-side validation could use it, but server is source of truth.
    return {"count": len(WORDS)}

@app.get("/api/leaderboard")
def api_leaderboard():
    return {"leaderboard": top_leaderboard(10)}

@app.post("/api/join", response_model=JoinRoomResponse)
def api_join(req: JoinRoomRequest):
    # Create or join room. Client provides a stable player_id, and we issue a token.
    nickname = req.nickname.strip()[:24] or "Player"
    if req.room_id is None or req.room_id.strip() == "":
        room, token = create_room(nickname=nickname, player_id=req.player_id, max_rounds=req.max_rounds)
        return JoinRoomResponse(
            room_id=room.room_id,
            token=token,
            max_rounds=room.max_rounds,
            accepted=True,
            role="player",
            message="Room created. Share the room code with friends!"
        )
    else:
        room_id = req.room_id.strip().upper()
        try:
            room, token = join_room(room_id=room_id, nickname=nickname, player_id=req.player_id, spectate=req.spectate)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        return JoinRoomResponse(
            room_id=room.room_id,
            token=token,
            max_rounds=room.max_rounds,
            accepted=True,
            role="spectator" if req.spectate else "player",
            message=f"Joined room {room.room_id}."
        )

@app.post("/api/guess")
def api_guess(req: GuessRequest):
    # Server-side validation & scoring. Client must include token.
    if not req.token or not verify_token(req.token, req.room_id, req.player_id):
        raise HTTPException(status_code=401, detail="Invalid token")
    room = ROOMS.get(req.room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # Validate guess is in word list
    if req.guess not in WORDS:
        raise HTTPException(status_code=400, detail="Guess is not in allowed words list")

    # Everything OK — score it.
    try:
        feedback = room.submit_guess(req.player_id, req.guess)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # If the player's state changed to terminal, record result.
    p = room.players[req.player_id]
    if p.status in ("won", "lost"):
        record_result(
            player_id=p.player_id,
            nickname=p.nickname,
            won=(p.status == "won"),
            rounds_used=p.rounds_used,
            room_id=room.room_id,
            was_creator=p.was_creator
        )

    return {"feedback": feedback.model_dump()}

@app.get("/api/state/{room_id}", response_model=RoomStateResponse)
def api_state(room_id: str, player_id: str, token: str):
    # Only valid participants (or spectators with token) can query state.
    if not verify_token(token, room_id, player_id):
        raise HTTPException(status_code=401, detail="Invalid token")

    room = ROOMS.get(room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    public = room_public_state(room)
    you = room.players.get(player_id)
    you_status = "spectating" if (you and you.is_spectator) else (you.status if you else "spectating")
    reveal = room.game_over
    ans = room.answer if reveal else None

    # Attach leaderboard for UX
    state = {
        **public,
        "your_id": player_id,
        "you_status": you_status,
        "you_rounds_used": you.rounds_used if you else 0,
        "reveal_answer": reveal,
        "answer": ans,
        "leaderboard": top_leaderboard(10)
    }
    return state

@app.post("/api/reveal")
def api_reveal(req: RevealRequest):
    if not verify_token(req.token, req.room_id, req.player_id):
        raise HTTPException(status_code=401, detail="Invalid token")
    room = ROOMS.get(req.room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if not room.game_over:
        raise HTTPException(status_code=400, detail="Game not over yet")
    return {"answer": room.answer}