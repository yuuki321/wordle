# Multi-Player Wordle (Server/Client, Python 3.11 + JavaScript)

A complete server/client Wordle that supports single-player and multi-player rooms. The server (FastAPI) holds the secret answer, validates guesses, scores them exactly like the original Wordle, and tracks high scores in SQLite. The client is a simple responsive SPA in vanilla HTML/CSS/JS.

This project fulfills:
- Task 1: Normal Wordle with configurable word list and max rounds.
- Task 2: Server/Client with server-side validation, client never sees the answer until end.
- Task 3: Multi-player rooms. Players race to guess the same hidden word; spectators can watch.
- Task 4: Bells & whistles implemented:
  - SQLite-backed high scores and a global leaderboard.
  - Spectator mode.
  - Keyboard hints and basic flip tile animation.
  - Color-blind friendly mode (toggle in header).

## How to run (from scratch)

Prerequisites:
- Python 3.11
- pip

Steps:
1. Clone or copy this repository structure to your machine.
2. Create and activate a virtual environment:
   - macOS/Linux:
     - python3.11 -m venv .venv
     - source .venv/bin/activate
   - Windows (PowerShell):
     - py -3.11 -m venv .venv
     - .venv\Scripts\Activate.ps1
3. Install dependencies:
   - pip install -r requirements.txt
4. Run the server:
   - uvicorn wordle.server.main:app --host 0.0.0.0 --port 8000
5. Open the client:
   - Visit http://localhost:8000 in your browser.

Notes:
- The server also serves the static client from / (index.html) and /static for assets.
- If the port 8000 is busy, change the port in the uvicorn command and open that port instead.

## How the game runs

- Open http://localhost:8000
- Choose:
  - New Room: creates a room with a random 6-character code. Share the code with friends.
  - Join: enter a room code to join as a player or toggle Spectate to watch.
- Type guesses in the input or use the on-screen keyboard.
- You have a maximum number of rounds (default 6) to guess the 5-letter answer.
- Colors:
  - Green (Hit): letter is in the correct spot.
  - Yellow (Present): letter exists in the answer, wrong spot.
  - Gray (Miss): letter not in the answer.
- The room ends once all players either win or lose. The answer is revealed to all. Results are recorded to the leaderboard.

## How the game works (rules and scoring)

- Exactly the original Wordle logic, including duplicates:
  - First pass marks letters that are exact matches (Hit).
  - Second pass marks Present letters, limited by the remaining count of that letter in the answer after removing Hits.
- Input validation:
  - Guesses must be 5-letter alphabetic words found in the server's word list.
  - The client attempts no authoritative validation; the server is the source of truth.
- Configurations (Task 1):
  - Max rounds (default 6). When creating a new room, this is applied server-side.
  - Word list: located at wordle/server/words.txt. You can replace it with your own list of 5-letter words.

## Multi-player design (Task 3)

Design choice:
- Cooperative-competitive race: All players in a room are guessing the same hidden word. Each player has their own board. Everyone can see opponents’ boards updating in real time (via polling). The room ends when all players have either won or used up their max rounds.

Reasons and trade-offs:
- Shared answer improves tension and fairness (everyone faces the same challenge).
- Simpler UX and server logic vs. per-player answers.
- We used HTTP polling (1s) for simplicity and reliability. WebSockets would reduce latency and bandwidth but increase complexity.

Player interaction:
- Players observe opponents' progress live (boards and status).
- Spectators can join to watch without influencing the game.

Win/Lose/Tie rules:
- Win: You guess the answer within the allowed rounds.
- Lose: You fail to guess the answer within the allowed rounds.
- Multiple winners are possible (if multiple players find the answer), and ties are implicitly supported.

If no player-supplied answer:
- The server chooses a random answer from the shared word list.
- If you want player-chosen answers, you could add a “custom word” option (see Ideas below).

## API overview

- POST /api/join
  - Request: { room_id?, player_id, nickname, max_rounds?, spectate? }
  - If room_id omitted/empty, creates a new room and returns a token.
  - If room_id provided, joins existing room (player or spectator) and returns a token.
- POST /api/guess
  - Request: { room_id, player_id, token, guess }
  - Validates token, room existence, and that guess is in the word list; returns feedback.
- GET /api/state/{room_id}?player_id=...&token=...
  - Returns your status, public state of all players, and answer if the game is over. Includes leaderboard.
- POST /api/reveal
  - Request: { room_id, player_id, token }
  - Returns answer, but only if the room is over.
- GET /api/leaderboard
  - Returns top players by wins and best (fastest) win.

Security/trust:
- Token is a signed room:player pairing issued by the server; prevents arbitrary querying of rooms by non-members. Tokens expire after 8 hours.

## How the code works

Server (Python/FastAPI):
- wordle/server/game.py
  - load_words: loads allowed 5-letter words from words.txt.
  - score_guess: exact Wordle scoring with proper handling of duplicates.
  - Room and PlayerState: in-memory models tracking guesses, status, and winners.
  - create_room/join_room: manage rooms and membership; issue signed tokens.
- wordle/server/main.py
  - FastAPI endpoints for join, guess, state, reveal, and leaderboard.
  - Serves static client files (index.html, styles.css, app.js).
  - On guess, validates token, room existence, and word membership.
  - Records results to SQLite when a player ends in win/loss.
- wordle/server/db.py
  - SQLAlchemy models for high scores and game logs.
  - record_result updates per-player win/loss counters and best (fastest) win.
  - top_leaderboard returns top N players.
- wordle/server/config.py
  - Centralized configuration: default max rounds, DB path, CORS, etc.

Client (HTML/CSS/JS):
- wordle/client/index.html: responsive layout with:
  - Controls to create/join rooms, spectate, color-blind toggle.
  - Your board + on-screen keyboard.
  - Opponents section showing each opponent’s board.
  - Sidebar with a global leaderboard.
- wordle/client/styles.css:
  - Dark theme, responsive grid.
  - Tile flip animation and color-blind palette.
- wordle/client/app.js:
  - API helper methods (join, guess, state).
  - Persistent identity via localStorage: player_id, nickname, token, room_id.
  - Polling loop to refresh state every 1s.
  - Render functions for your board, opponents, leaderboard.
  - On-screen keyboard and input handlers.
  - Applies keyboard letter hints based on feedback.

## Configuration

- Max rounds:
  - Default is 6 (server/config.py DEFAULT_MAX_ROUNDS).
  - When creating a new room via /api/join without room_id, you can supply max_rounds to override (bounded 1..10).
- Word list:
  - wordle/server/words.txt. Each line is a 5-letter alphabetic word.
  - Replace with your own list to customize difficulty.

## Input validation and edge cases

- Server rejects guesses not in the word list (400).
- Guess must be 5 alpha characters; otherwise 400.
- Spectators cannot submit guesses.
- Room not found returns 404, invalid token returns 401.
- Game over prevents further guesses (400).

## Decisions and trade-offs

- In-memory rooms:
  - Simpler and fast for a single-process server. Trade-off: not persistent across restarts and not horizontally scalable. This is acceptable for a coding exercise and local play.
- Polling vs WebSockets:
  - Polling chosen for simplicity and reliability. It’s easy to replace with WebSockets later.
- Token-based lightweight auth:
  - Avoids full authentication complexity while ensuring only joined users can query room state.
- SQLite for high scores:
  - Lightweight and file-based. Good enough for local/small-scale use.

## Bells & whitles ideas (some implemented, some proposed)

Implemented:
- High scores and global leaderboard (SQLite).
- Spectator mode.
- Basic animations (tile flip).
- Color-blind mode.

Not implemented but proposed (for more points):
- WebSocket live updates to eliminate polling.
- Per-room chat for player interaction.
- Per-room leaderboard and historical archive of games.
- Player-provided answers mode (each player sets a secret word for others).
- Daily word mode synchronized to date/seed.
- Admin controls to kick players or lock rooms.
- Mobile vibration feedback on keypress/miss.
- Shareable results (copy a grid of emojis like Wordle).
- Thematic word lists switcher (animals, geography, etc.).

## Testing the project

Manual:
- Create a new room; in another browser window/tab, join with the room code and a different nickname. Make simultaneous guesses and watch boards update.
- Let one player win; ensure the game reveals the answer and records results.
- Try invalid guesses (e.g., 4 letters, non-alphabetic, not in list) to see server validation errors.

Automated ideas:
- Unit tests for score_guess with duplicate letters and edge cases.
- API tests using httpx/pytest to simulate room creation, guessing, and conclude a game.

## Source code organization and conventions

- Clear separation:
  - server/: API, game logic, persistence, config, word list.
  - client/: static SPA assets.
- Naming:
  - Descriptive function and class names (score_guess, Room, PlayerState).
- Comments:
  - Inline comments explain algorithmic points (duplicate handling), validation, and flow.
- Future refactoring:
  - Extract WebSocket notifier, pluggable word lists, and per-room chat as modules.

## Repository practice

When you push:
- Commit logical changes in small steps, with descriptive messages:
  - feat(server): add FastAPI endpoints for join/guess/state
  - feat(game): implement Wordle scoring with duplicate handling
  - feat(client): add keyboard and animations
  - feat(db): add SQLite high scores and leaderboard
  - chore: add README and requirements
- Use branches for bigger features (e.g., websocket-upgrade).

## FAQ and clarifications considered

Ambiguities asked/assumed:
- Scoring rule: Followed the original Wordle with duplicate handling via two-pass method.
- Multi-player mode: Chosen shared-answer race mode; other modes possible and described.
- Client should not know the answer: enforced; revealed only when room is over.
- Configurations required: implemented max rounds and word list.
- Language versions: Python 3.11 verified via requirements; vanilla JS on client.

## Troubleshooting

- Port already in use: change port with --port 8001 and open http://localhost:8001
- Blank page: ensure you run uvicorn with the correct module path: wordle.server.main:app
- DB write issues: ensure the working directory has write permissions for wordle/server/wordle.db
- 401 Invalid token: you need to create or join a room from the client to obtain a token; tokens expire after 8 hours.

Enjoy playing!