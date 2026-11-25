// Chowka Bhara with friends: the lobby and match session.
//
// The host's browser runs the real game (in the iframe) and every other phone
// mirrors it. This file is the session layer between them. It does not care
// how messages travel; a "link" carries them:
//   - online: RelayLink, a WebSocket to the Cloudflare room relay
//   - nearby: NearbyHost / NearbyGuest, direct WebRTC on the local network
// Both links report the same things (who is here, who dropped, messages), so
// seats, the lobby, catch-up, pausing and bot takeover work the same way.
//
// The host also saves the room and the latest game snapshot on the device, so
// a host tab that iOS reloads in the background picks up where it left off.
import { RelayLink, type MemberInfo, type LinkState } from './chowkaRelay';
import { NearbyHost, NearbyGuest, HOST_ID, randomId, unpack, isReply } from './chowkaNearby';
import { qrSvg, QrScanner } from './chowkaQr';

type Colour = 'blue' | 'red' | 'yellow' | 'green';
type Seat = { id: string; name: string; colour: Colour; ready: boolean };
type Board = 5 | 7;
type Lobby = { type: 'lobby'; seats: Seat[]; bots: number; board: Board; hostName?: string };
type GamePlayer = { id: string; name: string; colour: Colour; level: 'hard' | null; style: 'balanced' };
type GameConfig = { players: GamePlayer[]; board: Board };
type Snapshot = Record<string, unknown>;
type Mode = 'online' | 'nearby';
type SavedHost = { mode: Mode; code: string; key: string; self: string; name: string; lobby: Lobby; config: GameConfig | null; snapshot: Snapshot | null; time: number };
type Data = Record<string, unknown>;

const boardOf = (value: unknown): Board => value === 7 ? 7 : 5;
const colours: Colour[] = ['blue', 'red', 'yellow', 'green'];
const colourPaint: Record<Colour, string> = { blue: '#3277cf', red: '#e54e38', yellow: '#f0b51e', green: '#38a65a' };
const title = (colour: string) => colour[0].toUpperCase() + colour.slice(1);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- Elements ----
const nameInput = $<HTMLInputElement>('name');
const entry = $('entry');
const entryStatus = $('entry-status');
const roomView = $('room');
const status = $('status');
const linkStateEl = $('link-state');
const seatsList = $<HTMLOListElement>('seats');
const requestsEl = $('requests');
const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
const startButton = $<HTMLButtonElement>('start-game');
const frame = $<HTMLIFrameElement>('game-frame');
const matchNote = $('match-note');
const matchAlert = $('match-alert');
const matchAlertText = $('match-alert-text');
const scannerDialog = $<HTMLDialogElement>('scanner');
const scannerStatus = $('scanner-status');
const reconnectDialog = $<HTMLDialogElement>('match-reconnect');

// ---- Small helpers ----
const store = {
  get<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } },
  set(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  del(key: string) { try { localStorage.removeItem(key); } catch { /* Private browsing. */ } },
};
const hexKey = () => randomId(16);
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
const normaliseCode = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
const validCode = (code: string) => /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code);
const prettyCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
const pageBase = `${location.origin}/playroom/chowka-bhara/online/`;
const HOST_TTL = 3 * 60 * 60_000;

const evenTable = (players: number) => players === 2 || players === 4;
const fitBots = (people: number, wanted: number) => {
  const allowed = [3, 2, 1, 0].filter((n) => evenTable(people + n));
  return allowed.length ? allowed.reduce((best, n) => Math.abs(n - wanted) < Math.abs(best - wanted) ? n : best) : 0;
};

const relayBase = (() => {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const raw = import.meta.env.PUBLIC_CHOWKA_SIGNAL_URL || (local ? `ws://${location.hostname}:8787` : '');
  if (!raw) return '';
  const url = new URL(raw, location.href);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.href.replace(/\/$/, '');
})();

// ---- Session state ----
let mode: Mode | null = null;
let hosting = false;
let self = '';
let code = ''; // online room code, or the nearby game's id
let hostKey = '';
let hostName = 'The host';
let relay: RelayLink | null = null;
let nearbyHost: NearbyHost | null = null;
let nearbyGuest: NearbyGuest | null = null;
let hostOnline = true;

let lobby: Lobby = { type: 'lobby', seats: [], bots: 3, board: 5 };
let gameStarted = false;
let gameReady = false;
let gameConfig: GameConfig | null = null;
let restoreSnapshot: Snapshot | null = null;
const frameQueue: Data[] = [];
const offline = new Set<string>();
let latestSnapshot: Snapshot | null = null;
let fullHistoryStates: unknown[] = [];
let fullHistoryLabels: string[] = [];
const requests = new Map<string, HTMLElement>();

function cleanName() { return nameInput.value.trim().replace(/\s+/g, ' ').slice(0, 24) || 'Player'; }
nameInput.value = store.get<string>('chowka-name') ?? '';

function say(message: string, error = false, el: HTMLElement = roomView.hidden ? entryStatus : status) {
  el.textContent = message;
  el.classList.toggle('error', error);
  el.setAttribute('role', error ? 'alert' : 'status');
}

function showLinkState(state: LinkState | 'direct' | 'lost') {
  const text = { connecting: 'Connecting…', online: '● Connected', reconnecting: 'Reconnecting…', closed: 'Closed', direct: '● Direct link', lost: 'Disconnected' }[state];
  linkStateEl.hidden = false;
  linkStateEl.textContent = text;
  linkStateEl.className = `link-state ${state === 'online' || state === 'direct' ? 'online' : state === 'reconnecting' || state === 'connecting' ? 'reconnecting' : ''}`;
}

// ---- Sending, whichever link is active ----
function sendTo(to: string, data: Data) {
  relay?.send(to, data);
  nearbyHost?.send(to, data);
  nearbyGuest?.send(to, data);
}
const toHost = (data: Data) => sendTo(relay?.hostId || HOST_ID, data);
const tellGuests = (data: Data) => sendTo('*', data);

function postFrame(message: Data) {
  if (gameReady && frame.contentWindow) frame.contentWindow.postMessage({ source: 'chowka-online', ...message }, location.origin);
  else frameQueue.push(message);
}

// ---- Host: saving the room on this device ----
let saveTimer = 0;
const savedKey = (m: Mode, c: string) => `chowka-host:${m}:${c}`;
function saveHostNow() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  if (!hosting || !mode || !code) return;
  const saved: SavedHost = { mode, code, key: hostKey, self, name: cleanName(), lobby, config: gameStarted ? gameConfig : null,
    snapshot: gameStarted ? latestSnapshot : null, time: Date.now() };
  if (!store.set(savedKey(mode, code), saved)) {
    // Storage full: keep the room without the long move history.
    store.set(savedKey(mode, code), { ...saved, snapshot: null });
  }
}
function saveHost() { if (!saveTimer) saveTimer = window.setTimeout(saveHostNow, 1500); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveHostNow(); });
window.addEventListener('pagehide', saveHostNow);
function forgetHost() {
  if (mode && code) store.del(savedKey(mode, code));
  // Clear out rooms older than a day while we are here.
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('chowka-host:') && !key.startsWith('chowka-online:') && !key.startsWith('chowka-nearby:')) continue;
      const value = store.get<{ time?: number }>(key);
      if (!value?.time || Date.now() - value.time > 86_400_000) store.del(key);
    }
  } catch { /* storage unavailable */ }
}

// ---- Rendering the lobby ----
function render() {
  seatsList.replaceChildren();
  const occupied = new Set(lobby.seats.map((s) => s.colour));
  for (const seat of lobby.seats) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'colour';
    dot.style.background = colourPaint[seat.colour];
    const isHost = seat.id === (hosting ? self : (relay?.hostId || HOST_ID));
    li.append(dot, document.createTextNode(`${seat.name}${seat.id === self ? ' (you)' : ''}${isHost ? ' · host' : ''}`));
    if (seat.id === self) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Your colour');
      for (const colour of colours) {
        const option = new Option(title(colour), colour);
        option.disabled = colour !== seat.colour && occupied.has(colour);
        select.add(option);
      }
      select.value = seat.colour;
      select.onchange = () => {
        if (hosting) setColour(self, select.value as Colour);
        else toHost({ type: 'colour', colour: select.value });
      };
      li.append(select);
    }
    const presence = document.createElement('span');
    presence.className = `presence ${seat.ready ? 'on' : 'off'}`;
    presence.textContent = seat.ready ? '● Here' : '○ Away';
    li.append(presence);
    seatsList.append(li);
  }
  const available = colours.filter((colour) => !occupied.has(colour));
  for (const colour of available.slice(0, lobby.bots)) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'colour';
    dot.style.background = colourPaint[colour];
    const label = document.createElement('span');
    label.className = 'bot';
    label.textContent = `${title(colour)} · computer`;
    li.append(dot, label);
    seatsList.append(li);
  }
  for (const radio of radios('bots')) {
    const allowed = evenTable(Number(radio.value) + lobby.seats.length);
    radio.checked = Number(radio.value) === lobby.bots;
    radio.disabled = !hosting || !allowed;
    radio.closest('label')!.hidden = !allowed;
  }
  for (const radio of radios('board')) {
    radio.checked = Number(radio.value) === boardOf(lobby.board);
    radio.disabled = !hosting;
  }
  $('board-note').textContent = boardOf(lobby.board) === 7 ? 'Three rings and six pawns each.' : 'The classic board, four pawns each.';
  $('bot-control').hidden = !hosting;
  $('guest-note').hidden = hosting;
  startButton.hidden = !hosting || gameStarted;
  const waitingOn = lobby.seats.filter((s) => !s.ready).map((s) => s.name);
  startButton.disabled = !evenTable(lobby.seats.length + lobby.bots) || waitingOn.length > 0;
  startButton.title = waitingOn.length ? `Waiting for ${waitingOn.join(', ')}` : '';
  for (const [, row] of requests) {
    const accept = row.querySelector<HTMLButtonElement>('.accept');
    if (accept) accept.disabled = lobby.seats.length >= 4 || gameStarted;
  }
}

function broadcast() {
  render();
  if (hosting) {
    tellGuests({ ...lobby, hostName: cleanName() });
    saveHost();
  }
}

function setColour(id: string, colour: Colour) {
  if (!colours.includes(colour) || lobby.seats.some((s) => s.id !== id && s.colour === colour)) return;
  const seat = lobby.seats.find((s) => s.id === id);
  if (seat) { seat.colour = colour; broadcast(); }
}

// ---- Host: people arriving and leaving ----
function seatFor(id: string, name?: string) {
  let seat = lobby.seats.find((s) => s.id === id);
  if (!seat && !gameStarted) {
    const colour = colours.find((c) => !lobby.seats.some((s) => s.colour === c));
    if (!colour) return null;
    seat = { id, name: name || 'Player', colour, ready: false };
    lobby.seats.push(seat);
    lobby.bots = fitBots(lobby.seats.length, lobby.bots);
  }
  if (seat && name) seat.name = name;
  return seat ?? null;
}

// Mid-match, a phone the host does not know (private browsing, or a friend
// taking over) steps into the first seat whose player is away.
function takeOverAwaySeat(id: string, name?: string) {
  if (!gameStarted || !gameConfig || mode !== 'nearby' || !offline.size) return;
  const old = [...offline][0];
  const seat = lobby.seats.find((s) => s.id === old);
  if (!seat) return;
  seat.id = id;
  if (name) seat.name = name;
  gameConfig = { ...gameConfig, players: gameConfig.players.map((p) => p.id === old ? { ...p, id, name: name || p.name } : p) };
  offline.delete(old);
  nearbyHost?.drop(old);
  postFrame({ type: 'players', players: gameConfig.players });
  tellGuests({ type: 'players', players: gameConfig.players });
}

function peerUp(id: string, name?: string) {
  if (!lobby.seats.some((s) => s.id === id)) takeOverAwaySeat(id, name);
  const seat = seatFor(id, name);
  if (!seat) return false;
  seat.ready = true;
  if (gameStarted && gameConfig) {
    offline.delete(id);
    sendTo(id, { type: 'start', players: gameConfig.players, board: gameConfig.board, hostName: cleanName() });
    sendCatchup(id);
    if (offline.size) sendTo(id, { type: 'pause', name: offlineNames() });
    else resumeMatch();
    say(`${seat.name} is back.`);
  }
  broadcast();
  return true;
}

function peerDown(id: string, name?: string) {
  const seat = seatFor(id, name);
  if (!seat) return;
  seat.ready = false;
  if (gameStarted) markOffline(id);
  broadcast();
}

function removeSeat(id: string) {
  if (gameStarted) { markOffline(id); return; }
  lobby.seats = lobby.seats.filter((s) => s.id !== id);
  lobby.bots = fitBots(lobby.seats.length, lobby.bots);
  broadcast();
}

function showRequest(member: MemberInfo) {
  let row = requests.get(member.id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'request';
    const text = document.createElement('span');
    const accept = document.createElement('button');
    accept.className = 'btn primary accept';
    accept.textContent = 'Let in';
    const decline = document.createElement('button');
    decline.className = 'btn';
    decline.textContent = 'Decline';
    accept.onclick = () => { relay?.decide(member.id, true); clearRequest(member.id); };
    decline.onclick = () => { relay?.decide(member.id, false); clearRequest(member.id); };
    row.append(text, accept, decline);
    requests.set(member.id, row);
    requestsEl.append(row);
  }
  row.querySelector('span')!.textContent = `${member.name} wants to join${member.online ? '.' : ' (away right now).'}`;
  render();
}
function clearRequest(id: string) { requests.get(id)?.remove(); requests.delete(id); }

function onHostData(from: string, data: Data) {
  if (gameStarted) {
    if (data.type === 'command' && JSON.stringify(data).length < 2048) postFrame({ type: 'command', from, command: data.command });
    return;
  }
  const seat = lobby.seats.find((s) => s.id === from);
  if (!seat) return;
  if (data.type === 'name' && typeof data.name === 'string') {
    const before = seat.name;
    seat.name = data.name.trim().slice(0, 24) || 'Player';
    if (status.textContent === `${before} joined.`) say(`${seat.name} joined.`);
    broadcast();
  }
  if (data.type === 'colour' && typeof data.colour === 'string') setColour(from, data.colour as Colour);
}

// ---- Host: catch-up, pausing, bots ----
function sendCatchup(to: string) {
  if (!latestSnapshot) return;
  // Long histories go in small ordered chunks so no single message is huge.
  const chunk = 16;
  for (let offset = 0; offset < Math.max(1, fullHistoryStates.length); offset += chunk) {
    sendTo(to, { type: 'snapshot', snapshot: { ...latestSnapshot, historyOffset: offset,
      historyStates: fullHistoryStates.slice(offset, offset + chunk), historyLabels: fullHistoryLabels.slice(offset, offset + chunk) } });
  }
}

function offlineNames() {
  return [...offline].map((id) => lobby.seats.find((seat) => seat.id === id)?.name ?? 'A player').join(', ');
}

function showAlert(text: string, which: 'host' | 'guest' | 'nearby' | null) {
  matchAlert.hidden = false;
  matchAlertText.textContent = text;
  $('host-recovery').hidden = which !== 'host' && which !== 'nearby';
  $('nearby-recovery').hidden = which !== 'nearby';
  $('guest-recovery').hidden = which !== 'guest';
}
function clearAlert() { matchAlert.hidden = true; }

function markOffline(id: string) {
  if (!gameStarted || !gameConfig?.players.some((p) => p.id === id) || offline.has(id)) return;
  offline.add(id);
  const seat = lobby.seats.find((s) => s.id === id);
  if (seat) seat.ready = false;
  showAlert(`${offlineNames()} ${offline.size > 1 ? 'are' : 'is'} away. The match is paused until they're back.`, mode === 'nearby' ? 'nearby' : 'host');
  postFrame({ type: 'pause' });
  tellGuests({ type: 'pause', name: offlineNames() });
}

function resumeMatch() {
  if (!gameStarted || offline.size) return;
  clearAlert();
  postFrame({ type: 'resume' });
  tellGuests({ type: 'resume' });
}

function replaceMissingWithBots() {
  if (!hosting || !gameConfig || !offline.size) return false;
  const missing = new Set(offline);
  gameConfig = { ...gameConfig, players: gameConfig.players.map((player) => missing.has(player.id)
    ? { ...player, id: '', name: `${title(player.colour)} bot`, level: 'hard' }
    : player) };
  for (const id of missing) {
    relay?.remove(id);
    nearbyHost?.drop(id);
    lobby.seats = lobby.seats.filter((seat) => seat.id !== id);
  }
  offline.clear();
  saveHost();
  return true;
}

$<HTMLButtonElement>('continue-bot').onclick = () => {
  if (!replaceMissingWithBots() || !gameConfig) return;
  postFrame({ type: 'players', players: gameConfig.players });
  tellGuests({ type: 'players', players: gameConfig.players });
  resumeMatch();
};
$<HTMLButtonElement>('restart-bot').onclick = () => {
  if (!replaceMissingWithBots() || !gameConfig) return;
  tellGuests({ type: 'restart', players: gameConfig.players, board: gameConfig.board });
  openGame(gameConfig, { restart: true });
};

// ---- The game frame ----
function endMatch(message: string) {
  if (!gameStarted) return;
  matchNote.textContent = message;
  postFrame({ type: 'end' });
  if (hosting) tellGuests({ type: 'end' });
  gameStarted = false;
  offline.clear();
  clearAlert();
  if (hosting) forgetHost();
}

function openGame(config: GameConfig, opts: { restart?: boolean; restore?: Snapshot | null } = {}) {
  if (gameStarted && !opts.restart) return;
  gameStarted = true;
  gameReady = false;
  gameConfig = config;
  restoreSnapshot = opts.restore ?? null;
  // A restored game starts from its saved snapshot until the frame sends a new one.
  latestSnapshot = restoreSnapshot;
  fullHistoryStates = Array.isArray(restoreSnapshot?.historyStates) ? [...restoreSnapshot.historyStates as unknown[]] : [];
  fullHistoryLabels = Array.isArray(restoreSnapshot?.historyLabels) ? [...restoreSnapshot.historyLabels as string[]] : [];
  frameQueue.length = 0;
  if (!opts.restore) offline.clear();
  clearAlert();
  entry.hidden = true;
  roomView.hidden = true;
  $('match').hidden = false;
  document.querySelector('h1')!.textContent = 'Chowka Bhara with friends';
  document.querySelector('.intro')?.setAttribute('hidden', '');
  matchNote.textContent = hosting
    ? `You're hosting${mode === 'online' ? ` room ${prettyCode(code)}` : ''}. If you switch apps, the game waits for you.`
    : `${hostName} is hosting this match.`;
  frame.src = '/playroom/chowka-bhara/?online=1';
  if (hosting) saveHost();
}

startButton.onclick = () => {
  if (!hosting || gameStarted || startButton.disabled) return;
  const people = lobby.seats.map((seat) => ({ id: seat.id, name: seat.name, colour: seat.colour, level: null, style: 'balanced' as const }));
  const used = new Set(people.map((seat) => seat.colour));
  const bots = colours.filter((colour) => !used.has(colour)).slice(0, lobby.bots)
    .map((colour) => ({ id: '', name: title(colour), colour, level: 'hard' as const, style: 'balanced' as const }));
  const config: GameConfig = { players: [...people, ...bots], board: boardOf(lobby.board) };
  if (!evenTable(config.players.length)) return;
  relay?.lock(true);
  tellGuests({ type: 'start', players: config.players, board: config.board, hostName: cleanName() });
  openGame(config);
};

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.source !== 'chowka-game') return;
  if (event.data.type === 'ready' && gameStarted && gameConfig) {
    gameReady = true;
    frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'init', hosting, self, players: gameConfig.players,
      board: gameConfig.board, restore: hosting ? restoreSnapshot : null }, location.origin);
    restoreSnapshot = null;
    for (const message of frameQueue.splice(0)) frame.contentWindow?.postMessage({ source: 'chowka-online', ...message }, location.origin);
    if (hosting && offline.size) postFrame({ type: 'pause' });
  } else if (event.data.type === 'snapshot' && hosting && gameStarted) {
    const snapshot = event.data.snapshot as Snapshot;
    const offset = snapshot?.historyOffset;
    if (typeof offset === 'number' && Array.isArray(snapshot.historyStates) && Array.isArray(snapshot.historyLabels)) {
      if (offset === 0) { fullHistoryStates = []; fullHistoryLabels = []; }
      if (offset === fullHistoryStates.length) {
        fullHistoryStates.push(...snapshot.historyStates);
        fullHistoryLabels.push(...snapshot.historyLabels as string[]);
      }
      latestSnapshot = { ...snapshot, historyOffset: 0, historyStates: fullHistoryStates, historyLabels: fullHistoryLabels };
    }
    tellGuests({ type: 'snapshot', snapshot });
    saveHost();
  } else if (event.data.type === 'command' && !hosting && gameStarted) {
    toHost({ type: 'command', command: event.data.command });
  } else if (event.data.type === 'height' && gameStarted && Number.isFinite(event.data.height)) {
    frame.style.height = `${Math.max(500, Math.min(4000, event.data.height))}px`;
  }
});

// ---- Guest: messages from the host ----
function onGuestData(data: Data) {
  if (typeof data.hostName === 'string') hostName = data.hostName.slice(0, 24);
  if (data.type === 'start' && Array.isArray(data.players)) {
    openGame({ players: data.players as GamePlayer[], board: boardOf(data.board) });
  } else if (data.type === 'restart' && Array.isArray(data.players)) {
    openGame({ players: data.players as GamePlayer[], board: boardOf(data.board) }, { restart: true });
  } else if (data.type === 'pause' && gameStarted) {
    showAlert(`${String(data.name ?? 'A player')} is away. The match is paused until they're back.`, null);
    postFrame({ type: 'pause' });
  } else if (data.type === 'resume' && gameStarted) {
    clearAlert();
    postFrame({ type: 'resume' });
  } else if (data.type === 'players' && gameStarted && Array.isArray(data.players)) {
    gameConfig = { players: data.players as GamePlayer[], board: gameConfig?.board ?? 5 };
    postFrame({ type: 'players', players: gameConfig.players });
  } else if (data.type === 'snapshot' && gameStarted) {
    postFrame({ type: 'snapshot', snapshot: data.snapshot });
  } else if (data.type === 'end' && gameStarted) {
    endMatch(`${hostName} ended the match.`);
  } else if (data.type === 'lobby' && Array.isArray(data.seats) && typeof data.bots === 'number') {
    const first = !lobby.seats.some((s) => s.id === self);
    lobby = data as Lobby;
    render();
    if (!gameStarted && first) say('You are in. Pick your colour; the host starts the game.');
  }
}

function hostPresence(online: boolean) {
  const was = hostOnline;
  hostOnline = online;
  if (online) {
    if (gameStarted) clearAlert();
    else if (!was) say(`${hostName} is back.`);
    return;
  }
  const text = mode === 'online'
    ? `${hostName} stepped away. The room waits for them, and the game carries on when they're back.`
    : `Lost the connection to ${hostName}. Ask them to show a code to reconnect, then scan it.`;
  if (gameStarted) showAlert(text, mode === 'nearby' ? 'guest' : null);
  else say(text);
  if (mode === 'nearby') {
    $('rescan').hidden = gameStarted;
    showLinkState('lost');
  }
}

// ---- Room view setup ----
function showRoom(kind: 'online-host' | 'online-guest' | 'nearby-host' | 'nearby-guest') {
  entry.hidden = true;
  roomView.hidden = gameStarted;
  $('room-kind').textContent = kind.startsWith('online') ? 'Online room' : 'Nearby game';
  $('online-invite').hidden = kind !== 'online-host' && kind !== 'online-guest';
  $('invite-qr').hidden = true;
  $('share').hidden = $('copy').hidden = $('show-qr').hidden = false;
  if (kind === 'online-guest') { $('share').hidden = $('show-qr').hidden = true; }
  $('nearby-invite').hidden = kind !== 'nearby-host';
  $('nearby-reply').hidden = kind !== 'nearby-guest';
  $('rescan').hidden = true;
  $('leave').textContent = hosting ? 'Close room' : 'Leave';
  render();
}

function resetToEntry(message = '', error = false) {
  relay?.stop(); relay = null;
  nearbyHost?.stop(); nearbyHost = null;
  nearbyGuest?.stop(); nearbyGuest = null;
  stopScanner();
  mode = null; hosting = false; self = ''; code = '';
  lobby = { type: 'lobby', seats: [], bots: 3, board: 5 };
  for (const id of [...requests.keys()]) clearRequest(id);
  if (gameStarted) { gameStarted = false; frame.src = 'about:blank'; }
  $('match').hidden = true;
  roomView.hidden = true;
  entry.hidden = false;
  linkStateEl.hidden = true;
  document.querySelector('h1')!.textContent = 'Play with friends';
  document.querySelector('.intro')?.removeAttribute('hidden');
  history.replaceState(null, '', location.pathname);
  say(message, error, entryStatus);
}

// ---- Online: host ----
function relayReasonText(reason: string | undefined, role: 'host' | 'guest') {
  switch (reason) {
    case 'notFound': return role === 'host' ? 'That room has closed. Create a new one.' : 'No room with that code. It may have closed, or the code has a typo.';
    case 'full': return 'That room is full, or its game has already started.';
    case 'declined': return 'The host declined your request.';
    case 'ended': return role === 'host' ? 'The room has closed.' : 'The host closed the room.';
    case 'replaced': return 'This seat was opened in another tab or the host gave it to someone else.';
    default: return 'Could not reach the room service. Check your internet and try again.';
  }
}

function hostOnlineRoom(roomCode: string, key: string, create: boolean) {
  if (!relayBase) { say('Online rooms are not set up on this copy of the site.', true); return; }
  mode = 'online'; hosting = true; code = roomCode; hostKey = key;
  history.replaceState(null, '', `#host=${code}`);
  $('room-code').textContent = prettyCode(code);
  showRoom('online-host');
  let welcomed = false;
  relay = new RelayLink({ base: relayBase, code, role: 'host', key, name: cleanName(), create }, {
    welcome(info) {
      welcomed = true;
      self = info.id;
      const mine = lobby.seats.find((s) => s.id === self);
      if (!mine) lobby.seats.unshift({ id: self, name: cleanName(), colour: colours.find((c) => !lobby.seats.some((s) => s.colour === c)) ?? 'blue', ready: true });
      else { mine.ready = true; mine.name = cleanName(); }
      for (const member of info.members ?? []) {
        if (!member.approved) { if (!gameStarted) showRequest(member); continue; }
        if (member.online) peerUp(member.id, member.name);
        else peerDown(member.id, member.name);
      }
      // Seats whose player the relay no longer knows (removed while away).
      for (const seat of lobby.seats) if (seat.id !== self && !(info.members ?? []).some((m) => m.id === seat.id)) removeSeat(seat.id);
      if (!gameStarted) say(lobby.seats.length > 1 ? 'Room ready.' : 'Room ready. Share the code or the invite.');
      broadcast();
    },
    member(member) {
      if (!member.approved) {
        if (gameStarted) return;
        showRequest(member);
        if (member.online) say(`${member.name} wants to join.`);
        return;
      }
      clearRequest(member.id);
      if (member.online) peerUp(member.id, member.name);
      else peerDown(member.id, member.name);
    },
    gone(id) { clearRequest(id); if (lobby.seats.some((s) => s.id === id)) removeSeat(id); render(); },
    rename(id, name) {
      const seat = lobby.seats.find((s) => s.id === id);
      if (seat && !gameStarted) { seat.name = name; broadcast(); }
      const row = requests.get(id);
      if (row) row.querySelector('span')!.textContent = `${name} wants to join.`;
    },
    host() { /* We are the host. */ },
    approved() { /* Only guests are approved. */ },
    data: onHostData,
    state(state, reason) {
      showLinkState(state);
      if (state === 'closed') {
        if (reason === 'taken' && !welcomed && create) { relay = null; hostOnlineRoom(newCode(), key, true); return; }
        forgetHost();
        if (gameStarted) { endMatch(relayReasonText(reason, 'host')); return; }
        resetToEntry(relayReasonText(reason, 'host'), reason !== 'left');
      } else if (state === 'reconnecting' && !gameStarted) say('Reconnecting to the room… your room is kept while you are away.');
    },
  });
  relay.start();
}

$<HTMLButtonElement>('create').onclick = () => {
  store.set('chowka-name', cleanName());
  lobby = { type: 'lobby', seats: [], bots: 3, board: 5 };
  hostOnlineRoom(newCode(), hexKey(), true);
};

const inviteLink = () => `${pageBase}#room=${code}`;
$<HTMLButtonElement>('share').onclick = async () => {
  const data = { title: 'Chowka Bhara', text: `Join my Chowka Bhara game. Room code ${prettyCode(code)}`, url: inviteLink() };
  if (navigator.share) {
    try { await navigator.share(data); return; }
    catch (error) { if ((error as Error).name === 'AbortError') return; }
  }
  await copyText(inviteLink(), $<HTMLButtonElement>('share'));
};
$<HTMLButtonElement>('copy').onclick = () => copyText(inviteLink(), $<HTMLButtonElement>('copy'));
$<HTMLButtonElement>('show-qr').onclick = () => {
  const box = $('invite-qr');
  box.hidden = !box.hidden;
  $('show-qr').setAttribute('aria-expanded', String(!box.hidden));
  $('show-qr').textContent = box.hidden ? 'Show QR' : 'Hide QR';
  if (!box.hidden) box.innerHTML = qrSvg(inviteLink(), `Invite code for room ${code}`);
};

async function copyText(text: string, button: HTMLButtonElement) {
  const label = button.textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
  catch { window.prompt('Copy this:', text); }
  window.setTimeout(() => { button.textContent = label; }, 1800);
}

// ---- Online: guest ----
function guestKeyFor(roomCode: string) {
  const saved = store.get<{ key: string; time: number }>(`chowka-online:${roomCode}:guest`);
  if (saved && /^[a-f0-9]{32}$/.test(saved.key) && Date.now() - saved.time < 86_400_000) {
    store.set(`chowka-online:${roomCode}:guest`, { key: saved.key, time: Date.now() });
    return saved.key;
  }
  const key = hexKey();
  store.set(`chowka-online:${roomCode}:guest`, { key, time: Date.now() });
  return key;
}

function joinOnline(roomCode: string) {
  if (!relayBase) { say('Online rooms are not set up on this copy of the site.', true); return; }
  store.set('chowka-name', cleanName());
  mode = 'online'; hosting = false; code = roomCode;
  history.replaceState(null, '', `#room=${code}`);
  $('room-code').textContent = prettyCode(code);
  lobby = { type: 'lobby', seats: [], bots: 0, board: 5 };
  showRoom('online-guest');
  say('Connecting to the room…');
  relay = new RelayLink({ base: relayBase, code, role: 'guest', key: guestKeyFor(code), name: cleanName(), create: false }, {
    welcome(info) {
      self = info.id;
      hostName = info.hostName ?? hostName;
      hostPresence(info.hostOnline !== false);
      if (!info.approved) say(`Asked ${hostName} to let you in. Waiting…${info.hostOnline === false ? ` (${hostName} is away right now.)` : ''}`);
      else if (!gameStarted && info.hostOnline !== false) say('Back in the room.');
    },
    member() { /* Only the host hears about members. */ },
    gone() { /* Only the host hears this. */ },
    rename() { /* Only the host hears this. */ },
    host(online, name) { hostName = name; hostPresence(online); },
    approved() { say(`${hostName} let you in.`); },
    data: (_from, data) => onGuestData(data),
    state(state, reason) {
      showLinkState(state);
      if (state === 'closed') {
        store.del(`chowka-online:${code}:guest`);
        if (gameStarted) { endMatch(relayReasonText(reason, 'guest')); showAlert(relayReasonText(reason, 'guest'), null); return; }
        resetToEntry(relayReasonText(reason, 'guest'), reason !== 'left');
      } else if (state === 'reconnecting') {
        if (gameStarted) showAlert('Reconnecting…', null);
        else say('Reconnecting…');
      }
    },
  });
  relay.start();
}

$<HTMLFormElement>('join-form').onsubmit = (event) => {
  event.preventDefault();
  const typed = normaliseCode($<HTMLInputElement>('code-input').value);
  if (!validCode(typed)) { say('Room codes are six letters and numbers, like KQ7M2X.', true, entryStatus); return; }
  joinOnline(typed);
};

// ---- Nearby: host ----
let inviting: Promise<void> | null = null;
async function refreshInvite(target: HTMLElement = $('offer-qr')) {
  if (!nearbyHost) return;
  if (lobby.seats.length >= 4 && !offline.size) {
    target.innerHTML = '<p class="muted">All four seats are taken.</p>';
    $<HTMLInputElement>('offer-link').value = '';
    return;
  }
  target.innerHTML = '<p class="muted">Making a code…</p>';
  // A used code must never be offered again.
  $<HTMLInputElement>('offer-link').value = '';
  const job = nearbyHost.invite(pageBase).then((link) => {
    target.innerHTML = qrSvg(link, 'Invite code for this nearby game');
    $<HTMLInputElement>('offer-link').value = link;
  }).catch(() => {
    target.innerHTML = '<p class="muted">This browser could not make a direct connection code.</p>';
  });
  inviting = job;
  await job;
}

async function hostNearby(room: string, restored = false) {
  mode = 'nearby'; hosting = true; code = room; self = HOST_ID; hostKey = '';
  history.replaceState(null, '', `#nearby-host=${code}`);
  const mine = lobby.seats.find((s) => s.id === HOST_ID);
  if (!mine) lobby.seats.unshift({ id: HOST_ID, name: cleanName(), colour: 'blue', ready: true });
  else { mine.ready = true; mine.name = cleanName(); }
  nearbyHost = new NearbyHost(code, cleanName(), {
    peer(id, name, online) {
      if (online) {
        if (!peerUp(id, name)) { nearbyHost?.drop(id); say(`${name} could not join: the seats are full.`, true); }
      } else peerDown(id, name);
    },
    data: onHostData,
  });
  showRoom('nearby-host');
  showLinkState('direct');
  // Allowing the camera up front lets the browser offer its plain local
  // address instead of a private .local name, which some hotspots cannot
  // resolve. The host needs the camera to scan replies anyway.
  try {
    say('Allow the camera so you can scan your friends\' codes.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    await refreshInvite();
    for (const track of stream.getTracks()) track.stop();
  } catch {
    await refreshInvite();
  }
  say(restored ? 'Your friends need to scan a new code to reconnect.' : 'Show the code to a friend.');
  broadcast();
}

$<HTMLButtonElement>('nearby-host').onclick = () => {
  store.set('chowka-name', cleanName());
  lobby = { type: 'lobby', seats: [], bots: 3, board: 5 };
  hostNearby(randomId(4));
};

async function acceptReply(text: string, after?: () => void) {
  if (!nearbyHost) return;
  if (inviting) await inviting;
  say('Connecting to their phone…');
  try {
    const { name } = await nearbyHost.accept(text);
    say(`${name} joined.`);
    after?.();
    await refreshInvite();
  } catch (error) {
    say((error as Error).message, true);
    await refreshInvite();
  }
}

$<HTMLButtonElement>('scan-reply').onclick = () => openScanner('Scan the code on their phone', (text) => {
  if (!isReply(text)) { scannerStatus.textContent = 'That is not a reply code. Scan the code on your friend\'s phone.'; return false; }
  acceptReply(text);
  return true;
});
$<HTMLFormElement>('paste-reply').onsubmit = (event) => {
  event.preventDefault();
  const field = $<HTMLTextAreaElement>('reply-text');
  const text = field.value.trim();
  if (text) { field.value = ''; acceptReply(text); }
};

// A dropped player rejoins mid-match by scanning a fresh code.
$<HTMLButtonElement>('match-invite').onclick = async () => {
  const body = $('reconnect-body');
  body.innerHTML = '<p>1. They scan this with their Camera.</p><div class="qr-box" id="reconnect-qr"></div><p>2. Then you scan theirs.</p><button class="btn primary" id="reconnect-scan" type="button">Scan their code</button>';
  reconnectDialog.showModal();
  await refreshInvite($('reconnect-qr'));
  $<HTMLButtonElement>('reconnect-scan').onclick = () => {
    reconnectDialog.close();
    openScanner('Scan the code on their phone', (text) => {
      if (!isReply(text)) return false;
      acceptReply(text);
      return true;
    });
  };
};
$<HTMLButtonElement>('reconnect-close').onclick = () => reconnectDialog.close();

// ---- Nearby: guest ----
function nearbyGuestId(room: string) {
  const key = `chowka-nearby:${room}`;
  const saved = store.get<{ id: string; time: number }>(key);
  const id = saved?.id && /^[a-f0-9]{16}$/.test(saved.id) ? saved.id : randomId(8);
  store.set(key, { id, time: Date.now() });
  return id;
}

async function joinNearby(payload: string) {
  const offer = await unpack<{ v: 1; r: string; o: string; n: string; s: string }>(payload);
  if (!offer?.r) { resetToEntry('That code could not be read. Ask the host to show a new one.', true); return; }
  // Rejoining from inside a running match keeps the match on screen.
  const rejoin = gameStarted && mode === 'nearby' && code === offer.r;
  nearbyGuest?.stop();
  mode = 'nearby'; hosting = false; code = offer.r; hostName = offer.n || 'The host';
  history.replaceState(null, '', location.pathname);
  self = nearbyGuestId(code);
  if (!rejoin) {
    lobby = { type: 'lobby', seats: [], bots: 0, board: 5 };
    showRoom('nearby-guest');
  }
  $('reply-host').textContent = hostName;
  replyName.value = nameInput.value;
  say('Making your reply code…');
  try {
    const { guest, reply } = await NearbyGuest.join(payload, self, cleanName(), {
      open() {
        $('nearby-reply').hidden = true;
        $('rescan').hidden = true;
        showLinkState('direct');
        hostPresence(true);
        toHost({ type: 'name', name: cleanName() });
        if (!gameStarted) say(`Connected to ${hostName}. Pick your colour; the host starts the game.`);
      },
      peer(_id, _name, online) { if (!online) hostPresence(false); },
      data: (_from, data) => onGuestData(data),
    });
    nearbyGuest = guest;
    if (rejoin) {
      $('reconnect-body').innerHTML = `<p>Show this to ${hostName} so they can scan it.</p><div class="qr-box">${qrSvg(reply, 'Your reply code')}</div>`;
      reconnectDialog.showModal();
      const close = window.setInterval(() => { if (guest.open) { reconnectDialog.close(); window.clearInterval(close); } }, 300);
    } else {
      $('reply-qr').innerHTML = qrSvg(reply, 'Your reply code');
      $<HTMLInputElement>('reply-copy').value = reply;
      say(`Waiting for ${hostName} to scan your code.`);
    }
  } catch (error) {
    say((error as Error).message, true);
  }
}
$<HTMLButtonElement>('copy-offer').onclick = () => copyText($<HTMLInputElement>('offer-link').value, $<HTMLButtonElement>('copy-offer'));
$<HTMLButtonElement>('copy-reply').onclick = () => copyText($<HTMLInputElement>('reply-copy').value, $<HTMLButtonElement>('copy-reply'));

// ---- The scanner ----
let scanner: QrScanner | null = null;
function stopScanner() { scanner?.stop(); scanner = null; if (scannerDialog.open) scannerDialog.close(); }
function openScanner(heading: string, onCode: (text: string) => boolean) {
  $('scanner-title').textContent = heading;
  scannerStatus.textContent = 'Starting the camera…';
  scannerDialog.showModal();
  scanner = new QrScanner($<HTMLVideoElement>('scanner-video'), (text) => {
    const done = onCode(text);
    if (done) window.setTimeout(stopScanner, 0);
    return done;
  });
  scanner.start().then(() => { scannerStatus.textContent = 'Hold the code inside the frame.'; })
    .catch(() => { scannerStatus.textContent = 'The camera is not available. Allow camera access, or paste the code instead.'; });
}
$<HTMLButtonElement>('scanner-close').onclick = stopScanner;
scannerDialog.addEventListener('close', () => { scanner?.stop(); scanner = null; });

// Scanning from the entry screen accepts any of our codes.
// Invite payloads are read raw: URLSearchParams would turn + into a space.
const joinPayloadIn = (hash: string) => hash.match(/(?:^|[#&])join=([^&]*)/)?.[1] ?? '';

function scannedInvite(text: string) {
  const hash = text.includes('#') ? text.slice(text.indexOf('#') + 1) : '';
  const params = new URLSearchParams(hash);
  const join = joinPayloadIn(hash);
  const room = normaliseCode(params.get('room') ?? '');
  if (join) { store.set('chowka-name', cleanName()); joinNearby(join); return true; }
  if (validCode(room)) { joinOnline(room); return true; }
  scannerStatus.textContent = 'That is not a Chowka Bhara invite.';
  return false;
}
$<HTMLButtonElement>('scan-join').onclick = () => openScanner('Scan the host\'s code', scannedInvite);
$<HTMLButtonElement>('rescan-button').onclick = () => openScanner('Scan the host\'s new code', scannedInvite);
$<HTMLButtonElement>('match-rescan').onclick = () => openScanner('Scan the host\'s new code', scannedInvite);

// ---- Leaving ----
$<HTMLButtonElement>('leave').onclick = () => {
  if (hosting && lobby.seats.length > 1 && !window.confirm('Close the room for everyone?')) return;
  forgetHost();
  if (relay) relay.leave();
  relay = null;
  if (!hosting && mode === 'online') store.del(`chowka-online:${code}:guest`);
  resetToEntry(hosting ? 'Room closed.' : 'You left the room.');
};

// ---- Lobby controls ----
$('bots').addEventListener('change', (event) => {
  if (hosting) { lobby.bots = Number((event.target as HTMLInputElement).value); broadcast(); }
});
$('board').addEventListener('change', (event) => {
  if (hosting) { lobby.board = boardOf(Number((event.target as HTMLInputElement).value)); broadcast(); }
});
// The reply screen has its own name box, for guests who arrive from the Camera.
const replyName = $<HTMLInputElement>('reply-name');
replyName.addEventListener('input', () => { nameInput.value = replyName.value; });
replyName.addEventListener('change', () => nameInput.dispatchEvent(new Event('change')));
nameInput.onchange = () => {
  store.set('chowka-name', cleanName());
  if (hosting) {
    const seat = lobby.seats.find((s) => s.id === self);
    if (seat) { seat.name = cleanName(); broadcast(); }
    nearbyHost?.rename(cleanName());
  } else if (mode === 'online') relay?.rename(cleanName());
  else if (mode === 'nearby') toHost({ type: 'name', name: cleanName() });
};
window.addEventListener('beforeunload', saveHostNow);

// ---- Offline readiness ----
async function checkOffline() {
  const el = $('offline-ready');
  if (!('serviceWorker' in navigator) || !('caches' in window)) return;
  el.hidden = false;
  try {
    const page = await caches.match(new URL('/playroom/chowka-bhara/online/index.html', location.origin).href, { ignoreSearch: true });
    const game = await caches.match(new URL('/playroom/chowka-bhara/index.html', location.origin).href, { ignoreSearch: true });
    if (page && game) {
      el.textContent = '✓ Saved on this phone. Nearby games work without internet.';
      el.classList.add('ok');
      return;
    }
  } catch { /* caches can be blocked */ }
  el.textContent = 'Saves itself for offline play after a first visit with internet. Everyone should open it once beforehand.';
  navigator.serviceWorker.ready.then(() => window.setTimeout(checkOffline, 4000)).catch(() => {});
}
checkOffline();

// ---- Arriving at the page ----
function restoreHost(m: Mode, roomCode: string) {
  const saved = store.get<SavedHost>(savedKey(m, roomCode));
  if (!saved || Date.now() - saved.time > HOST_TTL) return false;
  if (saved.name && !nameInput.value) nameInput.value = saved.name;
  lobby = { ...saved.lobby, seats: saved.lobby.seats.map((s) => ({ ...s, ready: false })) };
  code = roomCode;
  if (saved.config) {
    hosting = true; mode = m; self = saved.self;
    openGame(saved.config, { restore: saved.snapshot });
    // Everyone else counts as away until their link says they are back.
    for (const player of saved.config.players) if (player.id && player.id !== saved.self) markOffline(player.id);
  }
  if (m === 'online') hostOnlineRoom(roomCode, saved.key, false);
  else hostNearby(roomCode, true);
  return true;
}

const params = new URLSearchParams(location.hash.slice(1));
const invitedRoom = params.get('room');
const hostRoom = params.get('host');
const nearbyRoom = params.get('nearby-host');
const joinPayload = joinPayloadIn(location.hash.slice(1));

if (hostRoom && validCode(hostRoom)) {
  if (!restoreHost('online', hostRoom)) resetToEntry('That room has closed. Create a new one.');
} else if (nearbyRoom && /^[a-f0-9]{8}$/.test(nearbyRoom)) {
  if (!restoreHost('nearby', nearbyRoom)) resetToEntry('That nearby game has ended. Host a new one.');
} else if (joinPayload) {
  joinNearby(joinPayload);
} else if (invitedRoom) {
  const typed = normaliseCode(invitedRoom);
  if (validCode(typed)) {
    $<HTMLInputElement>('code-input').value = typed;
    // A returning guest (refresh, or iOS reloading the tab) goes straight back in.
    if (store.get(`chowka-online:${typed}:guest`)) joinOnline(typed);
    else {
      say(`You're invited to room ${prettyCode(typed)}. Enter your name, then tap Join.`, false, entryStatus);
      $('mode-online').classList.add('highlight');
      nameInput.focus();
    }
  } else say('This invite link is from an older version of the game. Ask your friend for a new link.', true, entryStatus);
} else if (location.hash === '#nearby' || location.hash === '#online') {
  $(`mode-${location.hash.slice(1)}`).classList.add('highlight');
}

if (!relayBase) {
  $<HTMLButtonElement>('create').disabled = true;
  $<HTMLButtonElement>('join').disabled = true;
  $('mode-online').querySelector('p')!.textContent = 'Online rooms are not set up on this copy of the site.';
}
