/*
Client-side SPA logic for multi-player Wordle.

Modifications added:
- Live update of leaderboard when the user changes the nickname input.
- Leaderboard visual ranks: gold/silver/bronze/white.
- Help section colored labels for Hit/Present/Miss.
- Keeps previously implemented fixes (keyboard reset, immediate reveal on any winner, flip-once animation).
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
    return res.json();
  }
};

// Simple storage for identity and session
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

// UI elements
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
  cbMode: document.getElementById("cbMode")
};

// Build on-screen keyboard
const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "⟵ZXCVBNM⏎"];
let keyState = {}; // letter -> miss/present/hit

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

// Reset keyboard visual state and internal state
function resetKeyboard(){
  keyState = {};
  for (const btn of els.keyboard.querySelectorAll(".key")) {
    btn.classList.remove("miss","present","hit");
  }
}

// Update a key color with priority (miss < present < hit)
function setKeyColor(letter, mark){
  const priority = { "miss": 1, "present": 2, "hit": 3 };
  const cur = keyState[letter] || null;
  if (!cur || priority[mark] > priority[cur]) {
    keyState[letter] = mark;
  }
  for (const btn of els.keyboard.querySelectorAll(".key")) {
    const t = btn.textContent.toUpperCase();
    const l = (t === "ENTER" || t === "BACK") ? "" : t;
    if (l && keyState[l]) {
      btn.classList.remove("miss","present","hit");
      btn.classList.add(keyState[l]);
    }
  }
}

// Helper to track previous board tiles across renders for flip-once animation
window._lastBoardTiles = null;
window._lastOpponentTiles = null;

// Build your board tiles. We render rows and apply marks.
// Animation: we only flip tiles that show a newly revealed mark compared to previously recorded tile metadata.
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
        // Determine previous data from cache
        const key = `${r}-${c}`;
        const prev = window._lastBoardTiles && window._lastBoardTiles[key];
        const prevLetter = prev ? prev.letter : null;
        const prevMark = prev ? prev.mark : null;
        const shouldFlip = !(prevLetter === ch && prevMark === mark);
        tile.textContent = ch;
        tile.classList.add(mark);
        if (shouldFlip){
          tile.classList.add("flip");
          tile.addEventListener("animationend", () => { tile.classList.remove("flip"); }, { once: true });
        }
        tile.setAttribute("data-last-letter", ch);
        tile.setAttribute("data-last-mark", mark);
        setKeyColor(ch, mark);
      } else {
        tile.textContent = "";
      }
      els.board.appendChild(tile);
    }
  }
  // After render, cache tiles
  cacheCurrentBoardTiles();
}

function cacheCurrentBoardTiles(){
  const nodes = els.board.querySelectorAll(".tile");
  const cache = {};
  const cols = 5;
  for (let i = 0; i < nodes.length; i++){
    const r = Math.floor(i / cols);
    const c = i % cols;
    const key = `${r}-${c}`;
    const letter = nodes[i].getAttribute("data-last-letter");
    const mark = nodes[i].getAttribute("data-last-mark");
    if (letter || mark){
      cache[key] = { letter: letter, mark: mark };
    } else {
      cache[key] = null;
    }
  }
  window._lastBoardTiles = cache;
}

// Render opponents boards. Use cache to animate flip only when tile changes.
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
          const key = `${op.player_id}-${r}-${c}`;
          const prev = window._lastOpponentTiles && window._lastOpponentTiles[key];
          const prevLetter = prev ? prev.letter : null;
          const prevMark = prev ? prev.mark : null;
          const shouldFlip = !(prevLetter === ch && prevMark === mark);
          tile.textContent = ch;
          tile.classList.add(mark);
          if (shouldFlip){
            tile.classList.add("flip");
            tile.addEventListener("animationend", () => { tile.classList.remove("flip"); }, { once: true });
          }
          window._lastOpponentTiles = window._lastOpponentTiles || {};
          window._lastOpponentTiles[key] = { letter: ch, mark: mark };
        }
        b.appendChild(tile);
      }
    }
    card.appendChild(b);
    els.opponentBoards.appendChild(card);
  }
}

// Render status text
function renderStatus(){
  els.roomId.textContent = state.room_id || "-";
  els.maxRounds.textContent = String(state.max_rounds);
  els.yourStatus.textContent = `Status: ${state.you_status.toUpperCase()} • Rounds Used: ${state.you_rounds_used}/${state.max_rounds}`;
}

// Render leaderboard with special colors and local nickname override for current player
function renderLeaderboard(list){
  els.leaderboard.innerHTML = "";
  if (!Array.isArray(list)) return;
  // If the user changed their nickname locally, ensure leaderboard reflects that for their entry
  const localNick = store.nickname || state.nickname;
  list.forEach((e, i) => {
    const li = document.createElement("li");
    // Apply rank class
    const rankClass = i === 0 ? "lead-1" : (i === 1 ? "lead-2" : (i === 2 ? "lead-3" : "lead-rest"));
    li.classList.add(rankClass);
    // If this entry matches current player_id, show the local nickname immediately
    const displayName = (e.player_id === state.player_id) ? localNick : e.nickname;
    li.textContent = `#${i+1} ${displayName} -- W:${e.wins} L:${e.losses}` + (e.fastest_win ? ` • Best:${e.fastest_win}` : "");
    els.leaderboard.appendChild(li);
  });
}

// Wire help section colored labels (no index.html change required)
function applyHelpColors(){
  // Find the help list under sidebar (assumes the exact list order from index.html)
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  // We will replace the existing help list content with colored labels
  const helpHeader = sidebar.querySelector("h3:nth-of-type(2)");
  const helpList = sidebar.querySelector("ul");
  if (!helpList) return;
  // Clear any existing items and add colored ones
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
  // Clear input early for UX
  els.guessInput.value = "";
  try{
    const res = await api.guess({ room_id: state.room_id, player_id: state.player_id, token: state.token, guess });
    // Update immediately by refetching state
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

// Track the last state to detect when a "new game" starts or room changed
let _last_room_id = null;
let _last_reveal = false;
let _last_winner_ids = [];

// Refresh state from server and render; implements immediate game-over on any player's win.
async function refreshState(){
  if (!state.room_id || !state.token) return;
  try{
    const s = await api.state({ room_id: state.room_id, player_id: state.player_id, token: state.token });
    const room_changed = (_last_room_id !== s.room_id);
    const reveal_changed = (_last_reveal !== s.reveal_answer);
    state.max_rounds = s.max_rounds;
    state.players = s.players;
    state.you_status = s.you_status;
    state.you_rounds_used = s.you_rounds_used;
    state.game_over = s.game_over;
    state.winner_ids = s.winner_ids || [];
    state.reveal_answer = s.reveal_answer;
    state.answer = s.answer || null;

    if (room_changed || ( _last_reveal === true && s.reveal_answer === false )){
      resetKeyboard();
      window._lastBoardTiles = null;
      window._lastOpponentTiles = null;
      els.banner.classList.add("hidden");
    }

    // Immediate UX reveal if any winner exists
    const anyWinner = (s.winner_ids && s.winner_ids.length > 0);
    if (anyWinner){
      state.game_over = true;
      state.reveal_answer = true;
      if (!state.answer && s.answer) state.answer = s.answer;
    }

    renderStatus();
    renderYourBoard();
    renderOpponents();
    // Leaderboard: use server-provided leaderboard from state (api.state returns leaderboard)
    renderLeaderboard(s.leaderboard || []);
    // Local override: if user changed nickname input, ensure it reflects immediately on leaderboard
    // Handled in renderLeaderboard by checking state.player_id and store.nickname

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
    _last_winner_ids = s.winner_ids || [];
  } catch(e){
    console.error("State error:", e);
  }
}

// Polling loop
let pollTimer = null;
function startPolling(){
  stopPolling();
  pollTimer = setInterval(refreshState, 1000);
}
function stopPolling(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer=null; }
}

async function createRoom(){
  const nickname = els.nickname.value.trim() || state.nickname;
  try{
    const res = await api.join({ room_id: null, player_id: state.player_id, nickname, max_rounds: 6, spectate: false });
    state.room_id = res.room_id;
    state.token = res.token;
    state.max_rounds = res.max_rounds;
    store.room = state.room_id;
    store.token = state.token;
    store.nickname = nickname;
    state.you_status = "playing";
    els.roomCodeInput.value = state.room_id;
    resetKeyboard();
    window._lastBoardTiles = null;
    window._lastOpponentTiles = null;
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
    store.token = state.token;
    store.nickname = nickname;
    state.you_status = spectate ? "spectating" : "playing";
    resetKeyboard();
    window._lastBoardTiles = null;
    window._lastOpponentTiles = null;
    await refreshState();
    startPolling();
  } catch(e){
    alert("Join failed: " + getErrorMessage(e));
  }
}

// Update local nickname when user edits the name input and ensure leaderboard updates immediately
els.nickname.addEventListener("input", (e) => {
  const v = e.target.value.trim().slice(0,24);
  store.nickname = v;
  state.nickname = v || state.nickname;
  // If the leaderboard currently displayed, re-render last known leaderboard by fetching latest from server-state
  // Quick local update: if an entry matches current player_id, update its displayed name immediately.
  // We will re-render from last fetched leaderboard if available (we keep lastLeaderboard)
  if (window._lastLeaderboard) {
    // update the entry matching player_id
    for (let i = 0; i < window._lastLeaderboard.length; i++){
      if (window._lastLeaderboard[i].player_id === state.player_id){
        window._lastLeaderboard[i].nickname = v;
        break;
      }
    }
    renderLeaderboard(window._lastLeaderboard);
  }
});

// Keep a copy of the last leaderboard returned by the server for immediate local updates
function cacheLeaderboard(list){
  window._lastLeaderboard = Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
}

// Wire UI events
els.newRoomBtn.addEventListener("click", createRoom);
els.joinRoomBtn.addEventListener("click", joinRoom);
els.guessBtn.addEventListener("click", submitGuess);
els.guessInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter"){ submitGuess(); }
});
els.nickname.value = store.nickname || state.nickname;
els.youId.textContent = `Your ID: ${state.player_id.slice(0,8)}`;
els.roomCodeInput.value = state.room_id || "";

// Color-blind mode
function applyCBMode(){
  const root = document.documentElement;
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

// Auto-join if we have stored session
if (state.room_id && state.token){
  resetKeyboard();
  refreshState().then(startPolling);
}

// Intercept renderLeaderboard calls from refreshState to cache results
// Modify refreshState slightly to cache leaderboard; To ensure cache always used, override renderLeaderboard call location:
// We already call renderLeaderboard in refreshState; augment caching there by changing renderLeaderboard invocations to cache first.
// So we wrap the original renderLeaderboard to also cache:
const _origRenderLeaderboard = renderLeaderboard;
renderLeaderboard = function(list){
  cacheLeaderboard(list);
  _origRenderLeaderboard(list);
};