/*
Client-side SPA logic for multi-player Wordle.

Leaderboard changes:
- Show "Win" and "Lose" labels instead of "W"/"L".
- Show "Guesses" (fastest_win) after each entry.
- Display ranks respecting ties (same rank for equal metrics; skip numbers after ties).
- Use server-provided 'rank' field and display accordingly.
- Keep existing visual rank classes (lead-1/2/3/rest) based on position in list,
  but display numeric rank that may be tied.
*/

const api = {
  async join({room_id, player_id, nickname, max_rounds, spectate}) {
    const res = await fetch("/api/join", {
      method:"POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ room_id, player_id, nickname, max_rounds, spectate })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async guess({room_id, player_id, token, guess}) {
    const res = await fetch("/api/guess", {
      method:"POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ room_id, player_id, token, guess })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async state({room_id, player_id, token}) {
    const url = `/api/state/${encodeURIComponent(room_id)}?player_id=${encodeURIComponent(player_id)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async leaderboard() {
    const res = await fetch("/api/leaderboard");
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async clearLeaderboard() {
    const res = await fetch("/api/leaderboard/clear", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
};

// storage, state, UI element references unchanged (keep previous code)
const store = {
  loadId() {
    let id = localStorage.getItem("player_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("player_id", id);
    }
    return id;
  },
  get nickname() { return localStorage.getItem("nickname") || ""; },
  set nickname(v){ localStorage.setItem("nickname", v); },
  set token(v){ localStorage.setItem("token", v); },
  get token(){ return localStorage.getItem("token") || ""; },
  set room(v){ localStorage.setItem("room_id", v); },
  get room(){ return localStorage.getItem("room_id") || ""; },
  get colorBlind(){ return localStorage.getItem("cb") === "1"; },
  set colorBlind(b){ localStorage.setItem("cb", b ? "1" : "0"); },
};

const state = {
  player_id: store.loadId(),
  nickname: store.nickname || `Player-${Math.floor(Math.random()*1000)}`,
  room_id: store.room || "",
  token: store.token || "",
  max_rounds: 6,
  you_status: "spectating",
  you_rounds_used: 0,
  players: [],
  game_over: false,
  winner_ids: [],
  reveal_answer: false,
  answer: null
};

const els = {
  newRoomBtn: document.getElementById("newRoomBtn"),
  joinRoomBtn: document.getElementById("joinRoomBtn"),
  roomCodeInput: document.getElementById("roomCodeInput"),
  spectateToggle: document.getElementById("spectateToggle"),
  nickname: document.getElementById("nickname"),
  youId: document.getElementById("youId"),
  roomId: document.getElementById("roomId"),
  maxRounds: document.getElementById("maxRounds"),
  yourStatus: document.getElementById("yourStatus"),
  board: document.getElementById("board"),
  opponents: document.getElementById("opponents"),
  opponentBoards: document.getElementById("opponentBoards"),
  guessInput: document.getElementById("guessInput"),
  guessBtn: document.getElementById("guessBtn"),
  keyboard: document.getElementById("keyboard"),
  banner: document.getElementById("gameOverBanner"),
  leaderboard: document.getElementById("leaderboard"),
  cbMode: document.getElementById("cbMode"),
  clearLeaderboardUnder: document.getElementById("clearLeaderboardUnder"),
};

const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "⟵ZXCVBNM⏎"];
let keyState = {}; // letter -> miss/present/hit

// build keyboard (same as before)
function buildKeyboard(){
  els.keyboard.innerHTML = "";
  KEY_ROWS.forEach(row => {
    for (const ch of row) {
      const btn = document.createElement("button");
      btn.className = "key";
      if (ch === "⟵") { btn.textContent = "Back"; btn.classList.add("small"); }
      else if (ch === "⏎") { btn.textContent = "Enter"; btn.classList.add("small"); }
      else btn.textContent = ch;
      btn.addEventListener("click", () => onKey(ch));
      els.keyboard.appendChild(btn);
    }
  });
}
buildKeyboard();

function resetKeyboard(){
  keyState = {};
  for (const btn of els.keyboard.querySelectorAll(".key")) {
    btn.classList.remove("miss","present","hit");
  }
}

function setKeyColor(letter, mark){
  const priority = { "miss": 1, "present": 2, "hit": 3 };
  const cur = keyState[letter] || null;
  if (!cur || priority[mark] > priority[cur]) {
    keyState[letter] = mark;
  }
  for (const btn of els.keyboard.querySelectorAll(".key")) {
    const t = btn.textContent.toUpperCase();
    const l = (t === "ENTER" || t === "BACK") ? "" : t;
    if (l) {
      btn.classList.remove("miss","present","hit");
      if (keyState[l]) btn.classList.add(keyState[l]);
    }
  }
}

// flip caches (unchanged)
let _lastBoardTiles = {};
let _lastOpponentTiles = {};

// render functions (use server marks directly) remain similar; keeping flip behavior
function renderYourBoard(){
  const me = state.players.find(p => p.player_id === state.player_id);
  const guesses = me ? me.guesses : [];
  const rows = state.max_rounds;
  els.board.innerHTML = "";
  for (let r = 0; r < rows; r++){
    const row = guesses[r];
    for (let c = 0; c < 5; c++){
      const tile = document.createElement("div");
      tile.className = "tile";
      if (row){
        const ch = row.guess[c].toUpperCase();
        const mark = row.marks[c];
        tile.textContent = ch;
        tile.classList.add(mark);

        const key = `me-${r}-${c}`;
        const prev = _lastBoardTiles[key] || { letter: null, mark: null };
        if (prev.letter !== ch || prev.mark !== mark){
          tile.classList.add("flip");
          tile.addEventListener("animationend", () => tile.classList.remove("flip"), { once: true });
        }
        _lastBoardTiles[key] = { letter: ch, mark: mark };

        setKeyColor(ch, mark);
      } else {
        tile.textContent = "";
      }
      els.board.appendChild(tile);
    }
  }
}

function renderOpponents(){
  const others = state.players.filter(p => p.player_id !== state.player_id);
  els.opponentBoards.innerHTML = "";
  for (const op of others){
    const card = document.createElement("div");
    card.className = "opponent";
    const title = document.createElement("h4");
    title.textContent = `${op.nickname} -- ${op.status.toUpperCase()} (${op.rounds_used}/${state.max_rounds})`;
    card.appendChild(title);
    const b = document.createElement("div");
    b.className = "board";
    const rows = state.max_rounds;
    for (let r = 0; r < rows; r++){
      const row = op.guesses[r];
      for (let c = 0; c < 5; c++){
        const tile = document.createElement("div");
        tile.className = "tile";
        if (row){
          const ch = row.guess[c].toUpperCase();
          const mark = row.marks[c];
          tile.textContent = ch;
          tile.classList.add(mark);

          const key = `${op.player_id}-${r}-${c}`;
          const prev = _lastOpponentTiles[key] || { letter: null, mark: null };
          if (prev.letter !== ch || prev.mark !== mark){
            tile.classList.add("flip");
            tile.addEventListener("animationend", () => tile.classList.remove("flip"), { once: true });
          }
          _lastOpponentTiles[key] = { letter: ch, mark: mark };
        }
        b.appendChild(tile);
      }
    }
    card.appendChild(b);
    els.opponentBoards.appendChild(card);
  }
}

function renderStatus(){
  els.roomId.textContent = state.room_id || "-";
  els.maxRounds.textContent = String(state.max_rounds);
  els.yourStatus.textContent = `Status: ${state.you_status.toUpperCase()} • Rounds Used: ${state.you_rounds_used}/${state.max_rounds}`;
}

// Render leaderboard entries using server-supplied ranked list
function renderLeaderboard(list){
  els.leaderboard.innerHTML = "";
  if (!Array.isArray(list)) return;
  // list elements include: player_id, nickname, wins, losses, fastest_win, rank
  for (let i = 0; i < list.length; i++){
    const e = list[i];
    const li = document.createElement("li");

    // Visual class by position (not by tied rank) to preserve gold/silver/bronze styling
    const rankClass = i === 0 ? "lead-1" : (i === 1 ? "lead-2" : (i === 2 ? "lead-3" : "lead-rest"));
    li.classList.add(rankClass);

    const displayName = (e.player_id === state.player_id) ? (store.nickname || state.nickname) : e.nickname;
    const rankText = `#${e.rank}`;
    const winText = `Win: ${e.wins}`;
    const lossText = `Lose: ${e.losses}`;
    const guessText = `Guess: ${e.fastest_win !== null && e.fastest_win !== undefined ? e.fastest_win : "-"}`;

    li.textContent = `${rankText} ${displayName} — ${winText} • ${lossText} • ${guessText}`;
    els.leaderboard.appendChild(li);
  }
}

// Help labels rendering (unchanged)
function applyHelpColors(){
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const helpList = sidebar.querySelector("ul");
  if (!helpList) return;
  helpList.innerHTML = "";
  const items = [
    { cls: "help-hit", text: "Green = Hit" },
    { cls: "help-present", text: "Yellow = Present" },
    { cls: "help-miss", text: "Gray = Miss" }
  ];
  for (const it of items){
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = `help-label ${it.cls}`;
    span.textContent = it.text.split(" = ")[0];
    li.appendChild(span);
    const desc = document.createTextNode(" = " + it.text.split(" = ")[1]);
    li.appendChild(desc);
    helpList.appendChild(li);
  }
}
applyHelpColors();

function onKey(ch){
  if (state.you_status !== "playing") return;
  if (ch === "⟵"){
    els.guessInput.value = els.guessInput.value.slice(0,-1);
  } else if (ch === "⏎"){
    submitGuess();
  } else {
    const v = (els.guessInput.value + ch).toUpperCase();
    els.guessInput.value = v.slice(0,5);
  }
}

function lettersOnly(s){ return /^[a-zA-Z]+$/.test(s); }

async function submitGuess(){
  let guess = els.guessInput.value.trim().toLowerCase();
  if (guess.length !== 5 || !lettersOnly(guess)){
    alert("Please enter a 5-letter word (A-Z).");
    return;
  }
  els.guessInput.value = "";
  try{
    await api.guess({ room_id: state.room_id, player_id: state.player_id, token: state.token, guess });
    await refreshState();
  } catch (e){
    console.error(e);
    alert("Guess failed: " + getErrorMessage(e));
  }
}

function getErrorMessage(e){
  try{
    const j = JSON.parse(String(e.message));
    return j.detail || e.message;
  }catch{
    return e.message || String(e);
  }
}

let _last_room_id = null;
let _last_reveal = false;

async function refreshState(){
  if (!state.room_id || !state.token) return;
  try{
    const s = await api.state({ room_id: state.room_id, player_id: state.player_id, token: state.token });
    const room_changed = (_last_room_id !== s.room_id);
    state.max_rounds = s.max_rounds;
    state.players = s.players;
    state.you_status = s.you_status;
    state.you_rounds_used = s.you_rounds_used;
    state.game_over = s.game_over;
    state.winner_ids = s.winner_ids || [];
    state.reveal_answer = s.reveal_answer;
    state.answer = s.answer || null;

    if (room_changed || (_last_reveal === true && s.reveal_answer === false)){
      resetKeyboard();
      _lastBoardTiles = {};
      _lastOpponentTiles = {};
      els.banner.classList.add("hidden");
    }

    const anyWinner = (s.winner_ids && s.winner_ids.length > 0);
    if (anyWinner){
      state.game_over = true;
      state.reveal_answer = true;
      if (!state.answer && s.answer) state.answer = s.answer;
    }

    renderStatus();
    renderYourBoard();
    renderOpponents();

    // Leaderboard: server returns { leaderboard: [...] } from /api/state and /api/leaderboard endpoints.
    // When /api/state includes 'leaderboard' it's the array; when using /api/leaderboard endpoint wrap accordingly.
    let lb = s.leaderboard || null;
    if (!lb){
      // fallback to dedicated endpoint
      const resp = await api.leaderboard();
      lb = resp.leaderboard || [];
    }
    renderLeaderboard(lb);

    if (state.game_over){
      const meWon = state.winner_ids.includes(state.player_id);
      els.banner.classList.remove("hidden");
      if (meWon) els.banner.textContent = `You won in ${state.you_rounds_used} rounds! Answer: ${state.answer || "[hidden]"}`;
      else {
        els.banner.textContent = state.answer ? `Game Over. Answer: ${state.answer}` : `Game Over. A player guessed the word!`;
      }
    } else {
      els.banner.classList.add("hidden");
    }

    _last_room_id = s.room_id;
    _last_reveal = s.reveal_answer;
  } catch(e){
    console.error("State error:", e);
  }
}

// clear leaderboard action (unchanged)
els.clearLeaderboardUnder.addEventListener("click", async () => {
  if (!confirm("This will permanently clear ALL leaderboard records. Continue?")) return;
  try{
    await api.clearLeaderboard();
    const resp = await api.leaderboard();
    const list = resp.leaderboard || [];
    renderLeaderboard(list);
    alert("Leaderboard cleared.");
  }catch(e){
    console.error(e);
    alert("Failed to clear leaderboard: " + getErrorMessage(e));
  }
});

// Polling loop
let pollTimer = null;
function startPolling(){
  stopPolling();
  pollTimer = setInterval(refreshState, 1000);
}
function stopPolling(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer=null; }
}

// createRoom / joinRoom / nickname wiring
async function createRoom(){
  const nickname = els.nickname.value.trim() || state.nickname;
  try{
    const res = await api.join({ room_id: null, player_id: state.player_id, nickname, max_rounds: 6, spectate: false });
    state.room_id = res.room_id;
    state.token = res.token;
    state.max_rounds = res.max_rounds;
    store.room = state.room_id;
    store.token = res.token;
    store.nickname = nickname;
    state.you_status = "playing";
    els.roomCodeInput.value = state.room_id;
    resetKeyboard();
    _lastBoardTiles = {};
    _lastOpponentTiles = {};
    await refreshState();
    startPolling();
  }catch(e){
    alert("Create room failed: " + getErrorMessage(e));
  }
}

async function joinRoom(){
  const code = els.roomCodeInput.value.trim().toUpperCase();
  if (!code){ alert("Enter room code to join."); return; }
  const spectate = els.spectateToggle.checked;
  const nickname = els.nickname.value.trim() || state.nickname;
  try{
    const res = await api.join({ room_id: code, player_id: state.player_id, nickname, max_rounds: undefined, spectate });
    state.room_id = res.room_id;
    state.token = res.token;
    state.max_rounds = res.max_rounds;
    store.room = state.room_id;
    store.token = res.token;
    store.nickname = nickname;
    state.you_status = spectate ? "spectating" : "playing";
    resetKeyboard();
    _lastBoardTiles = {};
    _lastOpponentTiles = {};
    await refreshState();
    startPolling();
  } catch(e){
    alert("Join failed: " + getErrorMessage(e));
  }
}

// nickname live update for leaderboard display
els.nickname.addEventListener("input", (e) => {
  const v = e.target.value.trim().slice(0,24);
  store.nickname = v;
  state.nickname = v || state.nickname;
  if (window._lastLeaderboard) {
    for (let i = 0; i < window._lastLeaderboard.length; i++){
      if (window._lastLeaderboard[i].player_id === state.player_id){
        window._lastLeaderboard[i].nickname = v;
        break;
      }
    }
    renderLeaderboard(window._lastLeaderboard);
  }
});

// small leaderboard cache wrapper
function cacheLeaderboard(list){
  window._lastLeaderboard = Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
}
const _origRenderLeaderboard = renderLeaderboard;
renderLeaderboard = function(list){
  cacheLeaderboard(list);
  _origRenderLeaderboard(list);
};

// color-blind mode
function applyCBMode(){
  if (store.colorBlind){
    document.body.classList.add("cb");
    els.cbMode.checked = true;
  } else {
    document.body.classList.remove("cb");
    els.cbMode.checked = false;
  }
}
els.cbMode.addEventListener("change", () => {
  store.colorBlind = els.cbMode.checked;
  applyCBMode();
});
applyCBMode();

// wire UI events
els.newRoomBtn.addEventListener("click", createRoom);
els.joinRoomBtn.addEventListener("click", joinRoom);
els.guessBtn.addEventListener("click", submitGuess);
els.guessInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter"){ submitGuess(); }
});
els.nickname.value = store.nickname || state.nickname;
els.youId.textContent = `Your ID: ${state.player_id.slice(0,8)}`;
els.roomCodeInput.value = state.room_id || "";

// Auto-join if we have stored session
if (state.room_id && state.token){
  resetKeyboard();
  _lastBoardTiles = {};
  _lastOpponentTiles = {};
  refreshState().then(startPolling);
}