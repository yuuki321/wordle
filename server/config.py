# Configuration module for server-side constants and defaults.

from pathlib import Path

# Default maximum number of rounds per game.
DEFAULT_MAX_ROUNDS = 6

# Path to the default word list (5-letter words).
WORDS_PATH = Path(__file__).parent / "words.txt"

# Secret key for signing session tokens (not strictly auth, just room validation).
SECRET_KEY = "change-me-in-prod-please"

# Whether to allow spectators (non-players) to join rooms in read-only mode.
ALLOW_SPECTATORS = True

# SQLite DB file path for high scores and game logs.
DB_PATH = Path(__file__).parent / "wordle.db"

# CORS origins (if you deploy the client separately, add its domain here).
CORS_ORIGINS = ["*"]

# Rate limit basics (simple guard at API level — not a full limiter).
MAX_GUESSES_PER_MINUTE_PER_PLAYER = 60