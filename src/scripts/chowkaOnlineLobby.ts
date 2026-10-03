type Colour = 'blue' | 'red' | 'yellow' | 'green';
type Seat = { id: string; name: string; colour: Colour; ready: boolean };
type Lobby = { type: 'lobby'; seats: Seat[]; bots: number };
type GamePlayer = { id: string; name: string; colour: Colour; level: 'hard' | null; style: 'balanced' };
type GameConfig = { players: GamePlayer[] };
type Wire = { type: string; id?: string; from?: string; to?: string; role?: string; signal?: RTCSessionDescriptionInit | RTCIceCandidateInit; accept?: boolean };

const colours: Colour[] = ['blue', 'red', 'yellow', 'green'];
const colourPaint: Record<Colour, string> = { blue: '#3277cf', red: '#e54e38', yellow: '#f0b51e', green: '#38a65a' };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nameInput = $<HTMLInputElement>('name');
const status = $<HTMLParagraphElement>('status');
const roomView = $('room');
const entry = $('entry');
const linkInput = $<HTMLInputElement>('link');
const botInput = $<HTMLSelectElement>('bots');
const seatsList = $<HTMLOListElement>('seats');
const requests = $('requests');
const connections = $<HTMLUListElement>('connections');
const startButton = $<HTMLButtonElement>('start-game');
const frame = $<HTMLIFrameElement>('game-frame');
const matchNote = $('match-note');
const matchAlert = $('match-alert');
const matchAlertText = $('match-alert-text');
const hostRecovery = $('host-recovery');
const params = new URLSearchParams(location.hash.slice(1));
const invitedRoom = params.get('room');
const reopening = params.has('host');
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const relay = local ? `ws://${location.hostname}:8787` : import.meta.env.PUBLIC_CHOWKA_SIGNAL_URL;
const roomPattern = /^[a-f0-9]{32}$/;

let room = '';
let hosting = false;
let self = '';
let socket: WebSocket | null = null;
let hostId = '';
let lobby: Lobby = { type: 'lobby', seats: [], bots: 3 };
const peers = new Map<string, { pc: RTCPeerConnection; channel: RTCDataChannel; pending: RTCIceCandidateInit[] }>();
let gameStarted = false;
let gameReady = false;
let gameConfig: GameConfig | null = null;
const pendingSnapshots: unknown[] = [];
const offline = new Set<string>();
let latestSnapshot: Record<string, unknown> | null = null;
let fullHistoryStates: unknown[] = [];
let fullHistoryLabels: string[] = [];
let retryTimer: number | undefined;

function roomKey(role: 'host' | 'guest') { return `chowka-online:${room}:${role}`; }
function savedKey(role: 'host' | 'guest') {
  try {
    const saved = JSON.parse(localStorage.getItem(roomKey(role)) ?? 'null');
    if (saved && typeof saved.token === 'string' && /^[a-f0-9]{32}$/.test(saved.token)
      && Date.now() - saved.time < 86_400_000) return saved.token as string;
  } catch { /* Private browsing can disable storage. */ }
  return '';
}
function connectionKey(role: 'host' | 'guest') {
  const existing = role === 'guest' ? savedKey(role) : '';
  if (existing) return existing;
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
  if (role === 'guest') {
    try { localStorage.setItem(roomKey(role), JSON.stringify({ token, time: Date.now() })); } catch { /* Reconnection needs storage. */ }
  }
  return token;
}

function say(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
}
function send(message: Wire) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function cleanName() { return nameInput.value.trim().slice(0, 24) || 'Player'; }
function closePeers() { for (const { pc } of peers.values()) pc.close(); peers.clear(); }
function inviteLink() { return `${location.origin}${location.pathname}#room=${room}`; }

function render() {
  seatsList.replaceChildren();
  connections.replaceChildren();
  const occupied = new Set(lobby.seats.map((s) => s.colour));
  for (const seat of lobby.seats) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'colour';
    dot.style.background = colourPaint[seat.colour];
    li.append(dot, document.createTextNode(`${seat.name}${seat.id === self ? ' (you)' : ''}`));
    if (seat.id === self) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Your colour');
      for (const colour of colours) {
        const option = new Option(colour[0].toUpperCase() + colour.slice(1), colour);
        option.disabled = colour !== seat.colour && occupied.has(colour);
        select.add(option);
      }
      select.value = seat.colour;
      select.onchange = () => {
        if (hosting) setColour(self, select.value as Colour);
        else peers.get(hostId)?.channel.send(JSON.stringify({ type: 'colour', colour: select.value }));
      };
      li.append(select);
    } else li.append(document.createTextNode(` · ${seat.colour}`));
    seatsList.append(li);

    const connection = document.createElement('li');
    const indicator = document.createElement('span');
    indicator.className = seat.ready ? 'ready' : 'waiting';
    indicator.textContent = seat.ready ? '● Connected' : '○ Connecting';
    connection.append(document.createTextNode(seat.name + ' · '), indicator);
    connections.append(connection);
  }
  const available = colours.filter((colour) => !occupied.has(colour));
  for (const colour of available.slice(0, lobby.bots)) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'colour';
    dot.style.background = colourPaint[colour];
    li.append(dot, document.createTextNode(`${colour[0].toUpperCase() + colour.slice(1)} bot`));
    seatsList.append(li);
  }
  botInput.value = String(lobby.bots);
  [...botInput.options].forEach((o) => { o.disabled = Number(o.value) + lobby.seats.length > 4 || Number(o.value) + lobby.seats.length < 2; });
  startButton.hidden = !hosting || gameStarted;
  startButton.disabled = lobby.seats.length + lobby.bots < 2 || lobby.seats.length + lobby.bots > 4 || lobby.seats.some((s) => !s.ready);
}

function broadcast() {
  render();
  const data = JSON.stringify(lobby);
  for (const { channel } of peers.values()) if (channel.readyState === 'open') channel.send(data);
}

function sendCatchup(channel: RTCDataChannel) {
  if (!latestSnapshot) return;
  // Data channels can reject one giant history message late in a long game.
  // Small ordered chunks let the guest rebuild history before live updates.
  const chunkSize = 16;
  for (let offset = 0; offset < fullHistoryStates.length; offset += chunkSize) {
    channel.send(JSON.stringify({ type: 'snapshot', snapshot: { ...latestSnapshot,
      historyOffset: offset,
      historyStates: fullHistoryStates.slice(offset, offset + chunkSize),
      historyLabels: fullHistoryLabels.slice(offset, offset + chunkSize) } }));
  }
}

function setColour(id: string, colour: Colour) {
  if (!colours.includes(colour) || lobby.seats.some((s) => s.id !== id && s.colour === colour)) return;
  const seat = lobby.seats.find((s) => s.id === id);
  if (seat) { seat.colour = colour; broadcast(); }
}

function onData(id: string, raw: string) {
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { return; }
  if (hosting) {
    if (gameStarted) {
      if (data.type === 'command' && frame.contentWindow && JSON.stringify(data).length < 2048)
        frame.contentWindow.postMessage({ source: 'chowka-online', type: 'command', from: id, command: data.command }, location.origin);
      return;
    }
    const seat = lobby.seats.find((s) => s.id === id);
    if (!seat) return;
    if (data.type === 'name' && typeof data.name === 'string') { seat.name = data.name.trim().slice(0, 24) || 'Player'; broadcast(); }
    if (data.type === 'colour' && typeof data.colour === 'string') setColour(id, data.colour as Colour);
  } else if (data.type === 'start' && Array.isArray(data.players)) {
    openGame({ players: data.players as GamePlayer[] });
  } else if (data.type === 'restart' && Array.isArray(data.players)) {
    openGame({ players: data.players as GamePlayer[] }, true);
  } else if (data.type === 'pause' && gameStarted) {
    showOffline(String(data.name ?? 'A player'), false);
  } else if (data.type === 'resume' && gameStarted) {
    clearOffline();
  } else if (data.type === 'players' && gameStarted && Array.isArray(data.players)) {
    gameConfig = { players: data.players as GamePlayer[] };
    frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'players', players: gameConfig.players }, location.origin);
  } else if (data.type === 'snapshot' && gameStarted) {
    if (gameReady) frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'snapshot', snapshot: data.snapshot }, location.origin);
    else pendingSnapshots.push(data.snapshot);
  } else if (data.type === 'end' && gameStarted) {
    endMatch('The host ended the match.');
  } else if (data.type === 'lobby' && Array.isArray(data.seats) && typeof data.bots === 'number') {
    lobby = data as Lobby;
    render();
  }
}

async function addIce(id: string, candidate: RTCIceCandidateInit) {
  const peer = peers.get(id);
  if (!peer) return;
  if (!peer.pc.remoteDescription) peer.pending.push(candidate);
  else await peer.pc.addIceCandidate(candidate);
}

async function setRemote(id: string, description: RTCSessionDescriptionInit) {
  const peer = peers.get(id);
  if (!peer) return;
  await peer.pc.setRemoteDescription(description);
  for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate);
}

function createPeer(id: string, initiator: boolean) {
  peers.get(id)?.pc.close();
  peers.delete(id);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  const channel = initiator ? pc.createDataChannel('lobby') : null;
  const peer = { pc, channel: channel as RTCDataChannel, pending: [] as RTCIceCandidateInit[] };
  peers.set(id, peer);
  const setupChannel = (data: RTCDataChannel) => {
    peer.channel = data;
    data.onopen = () => {
      if (hosting) {
        const seat = lobby.seats.find((s) => s.id === id);
        if (seat) seat.ready = true;
        broadcast();
        if (gameStarted && gameConfig) {
          offline.delete(id);
          data.send(JSON.stringify({ type: 'start', players: gameConfig.players }));
          sendCatchup(data);
          if (offline.size) data.send(JSON.stringify({ type: 'pause', name: offlineNames() }));
          else if (!offline.size) resumeMatch();
        }
      } else {
        data.send(JSON.stringify({ type: 'name', name: cleanName() }));
        say('Connected directly to the host. Choose your colour.');
      }
    };
    data.onmessage = (event) => onData(id, String(event.data));
    data.onclose = () => {
      if (peers.get(id)?.pc !== pc) return;
      if (gameStarted && hosting) markOffline(id);
      else if (gameStarted) {
        say('Connection to the host lost. Trying to reconnect…', true);
        socket?.close();
      }
      else if (hosting) { const seat = lobby.seats.find((s) => s.id === id); if (seat) { seat.ready = false; broadcast(); } }
      else say('Connection to host ended.');
    };
  };
  if (channel) setupChannel(channel);
  else pc.ondatachannel = (event) => setupChannel(event.channel);
  pc.onicecandidate = (event) => { if (event.candidate) send({ type: 'signal', to: id, signal: { type: 'ice', ...event.candidate.toJSON() } as RTCIceCandidateInit & { type: 'ice' } }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') say('Direct connection failed on this network. Try another network.'); };
  return pc;
}

async function signal(id: string, value: Record<string, unknown>) {
  if (value.type === 'ice') { await addIce(id, value as RTCIceCandidateInit); return; }
  if (value.type === 'offer' && hosting) {
    const pc = createPeer(id, false);
    await setRemote(id, value as unknown as RTCSessionDescriptionInit);
    await pc.setLocalDescription(await pc.createAnswer());
    send({ type: 'signal', to: id, signal: pc.localDescription! });
  } else if (value.type === 'answer' && !hosting) await setRemote(id, value as unknown as RTCSessionDescriptionInit);
}

function requestJoin(id: string) {
  const row = document.createElement('div');
  row.className = 'request';
  const text = document.createElement('span');
  text.textContent = 'A friend wants to join.';
  const accept = document.createElement('button');
  accept.className = 'btn primary';
  accept.textContent = 'Let in';
  const decline = document.createElement('button');
  decline.className = 'btn';
  decline.textContent = 'Decline';
  accept.onclick = () => { send({ type: 'decision', to: id, accept: true }); row.remove(); };
  decline.onclick = () => { send({ type: 'decision', to: id, accept: false }); row.remove(); };
  row.append(text, accept, decline);
  requests.append(row);
}

function offlineNames() {
  return [...offline].map((id) => lobby.seats.find((seat) => seat.id === id)?.name ?? 'A player').join(', ');
}

function showOffline(name: string, controls: boolean) {
  matchAlert.hidden = false;
  matchAlertText.textContent = `${name} is offline. The match is paused while they reconnect.`;
  hostRecovery.hidden = !controls;
}

function clearOffline() {
  matchAlert.hidden = true;
  hostRecovery.hidden = true;
}

function tellGuests(message: Record<string, unknown>) {
  const wire = JSON.stringify(message);
  for (const { channel } of peers.values()) if (channel.readyState === 'open') channel.send(wire);
}

function markOffline(id: string) {
  if (!gameStarted || !lobby.seats.some((seat) => seat.id === id) || offline.has(id)) return;
  offline.add(id);
  const seat = lobby.seats.find((entry) => entry.id === id);
  if (seat) seat.ready = false;
  showOffline(offlineNames(), true);
  frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'pause' }, location.origin);
  tellGuests({ type: 'pause', name: offlineNames() });
}

function resumeMatch() {
  if (!gameStarted || offline.size) return;
  clearOffline();
  frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'resume' }, location.origin);
  tellGuests({ type: 'resume' });
}

function replaceMissingWithBots() {
  if (!hosting || !gameConfig || !offline.size) return false;
  const missing = new Set(offline);
  gameConfig = { players: gameConfig.players.map((player) => missing.has(player.id)
    ? { ...player, id: '', name: `${player.colour[0].toUpperCase()}${player.colour.slice(1)} bot`, level: 'hard' }
    : player) };
  for (const id of missing) {
    send({ type: 'remove-guest', to: id });
    peers.get(id)?.pc.close();
    peers.delete(id);
    lobby.seats = lobby.seats.filter((seat) => seat.id !== id);
  }
  offline.clear();
  return true;
}

$<HTMLButtonElement>('continue-bot').onclick = () => {
  if (!replaceMissingWithBots() || !gameConfig) return;
  frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'players', players: gameConfig.players }, location.origin);
  tellGuests({ type: 'players', players: gameConfig.players });
  resumeMatch();
};

$<HTMLButtonElement>('restart-bot').onclick = () => {
  if (!replaceMissingWithBots() || !gameConfig) return;
  tellGuests({ type: 'restart', players: gameConfig.players });
  openGame(gameConfig, true);
};

function endMatch(message: string) {
  if (!gameStarted) return;
  matchNote.textContent = message;
  frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'end' }, location.origin);
  if (hosting) for (const { channel } of peers.values()) {
    if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'end' }));
  }
  gameStarted = false;
  offline.clear();
  clearOffline();
}

function openGame(config: GameConfig, restart = false) {
  if (gameStarted && !restart) return;
  gameStarted = true;
  gameReady = false;
  gameConfig = config;
  latestSnapshot = null;
  fullHistoryStates = [];
  fullHistoryLabels = [];
  pendingSnapshots.length = 0;
  offline.clear();
  clearOffline();
  $('entry').hidden = true;
  $('room').hidden = true;
  $('lobby-card').hidden = true;
  $('match').hidden = false;
  document.querySelector('h1')!.textContent = 'Chowka Bhara with friends';
  document.querySelector('.intro')?.setAttribute('hidden', '');
  frame.src = '/playroom/chowka-bhara/?online=1';
}

startButton.onclick = () => {
  if (!hosting || gameStarted || startButton.disabled) return;
  const people = lobby.seats.map((seat) => ({ id: seat.id, name: seat.name, colour: seat.colour, level: null, style: 'balanced' as const }));
  const used = new Set(people.map((seat) => seat.colour));
  const bots = colours.filter((colour) => !used.has(colour)).slice(0, lobby.bots)
    .map((colour) => ({ id: '', name: `${colour[0].toUpperCase()}${colour.slice(1)}`, colour, level: 'hard' as const, style: 'balanced' as const }));
  const config: GameConfig = { players: [...people, ...bots] };
  if (config.players.length < 2 || config.players.length > 4) return;
  send({ type: 'lock' });
  for (const { channel } of peers.values()) if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'start', players: config.players }));
  openGame(config);
};

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.source !== 'chowka-game') return;
  if (event.data.type === 'ready' && gameStarted && gameConfig) {
    gameReady = true;
    frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'init', hosting, self, players: gameConfig.players }, location.origin);
    for (const snapshot of pendingSnapshots.splice(0))
      frame.contentWindow?.postMessage({ source: 'chowka-online', type: 'snapshot', snapshot }, location.origin);
  } else if (event.data.type === 'snapshot' && hosting && gameStarted) {
    const snapshot = event.data.snapshot as Record<string, unknown>;
    const offset = snapshot?.historyOffset;
    if (typeof offset === 'number' && Array.isArray(snapshot.historyStates) && Array.isArray(snapshot.historyLabels)) {
      if (offset === 0) { fullHistoryStates = []; fullHistoryLabels = []; }
      if (offset === fullHistoryStates.length) {
        fullHistoryStates.push(...snapshot.historyStates);
        fullHistoryLabels.push(...snapshot.historyLabels as string[]);
      }
      latestSnapshot = { ...snapshot, historyOffset: 0,
        historyStates: [...fullHistoryStates], historyLabels: [...fullHistoryLabels] };
    }
    const wire = JSON.stringify({ type: 'snapshot', snapshot: event.data.snapshot });
    for (const { channel } of peers.values()) if (channel.readyState === 'open') channel.send(wire);
  } else if (event.data.type === 'command' && !hosting && gameStarted) {
    const channel = peers.get(hostId)?.channel;
    if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'command', command: event.data.command }));
  } else if (event.data.type === 'height' && gameStarted && Number.isFinite(event.data.height)) {
    frame.style.height = `${Math.max(500, Math.min(4000, event.data.height))}px`;
  }
});

function connect(role: 'host' | 'guest') {
  if (!relay) { say('The online relay is not configured yet. Use the local test commands in the README.'); return; }
  hosting = role === 'host';
  const url = `${relay}/room/${room}?role=${role}&token=${connectionKey(role)}`;
  const failedToConnect = () => {
    if (gameStarted) {
      showOffline('The room connection', false);
      say('Could not reconnect yet. The room may have ended or your seat may have been replaced.', true);
      return;
    }
    entry.hidden = false;
    roomView.hidden = true;
    if (role === 'host') {
      room = '';
      history.replaceState(null, '', location.pathname + location.search);
      $<HTMLButtonElement>('create').textContent = 'Try creating room again';
      say('Could not create the room. The connection service may be unavailable or at its daily limit. Please try again later.', true);
    } else {
      $<HTMLButtonElement>('join').textContent = 'Try joining room again';
      say('Could not join this room. It may be closed or full, or the connection service may be unavailable. Please try again later.', true);
    }
  };
  let nextSocket: WebSocket;
  try { nextSocket = new WebSocket(url); }
  catch { failedToConnect(); return; }
  socket = nextSocket;
  let receivedHello = false;
  say('Connecting to the room…');
  nextSocket.onopen = () => { if (socket === nextSocket) say(hosting ? 'Room ready. Share the link.' : 'Waiting for the host to let you in.'); };
  nextSocket.onerror = () => { if (socket === nextSocket) say('Could not reach the room connection service.', true); };
  nextSocket.onclose = () => {
    if (socket !== nextSocket) return;
    socket = null;
    closePeers();
    if (gameStarted && !hosting) {
      showOffline('The host connection', false);
      say('Connection lost. Trying to reconnect…', true);
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => connect('guest'), 2000);
    } else if (gameStarted) endMatch('The room connection ended.');
    else if (!receivedHello) failedToConnect();
    else say('Room connection ended. Refresh to try again.', true);
  };
  nextSocket.onmessage = async (event) => {
    if (socket !== nextSocket) return;
    let message: Wire;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    try {
      if (message.type === 'hello' && message.id) {
        receivedHello = true;
        self = message.id;
        if (hosting) { lobby.seats = [{ id: self, name: cleanName(), colour: 'blue', ready: true }]; broadcast(); }
      } else if (message.type === 'join-request' && hosting && message.id) requestJoin(message.id);
      else if (message.type === 'approved' && message.id && hosting) {
        const colour = colours.find((c) => !lobby.seats.some((s) => s.colour === c));
        if (colour) { lobby.seats.push({ id: message.id, name: 'Joining player', colour, ready: false }); lobby.bots = Math.min(lobby.bots, 4 - lobby.seats.length); broadcast(); }
      } else if (message.type === 'approved' && !hosting) {
        say('Joining the host directly…');
        // The relay identifies the host when the guest first joins the room.
        if (!hostId) return;
        const pc = createPeer(hostId, true);
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: 'signal', to: hostId, signal: pc.localDescription! });
      } else if (message.type === 'signal' && message.from && message.signal) {
        if (!hosting && !hostId) hostId = message.from;
        await signal(message.from, message.signal as Record<string, unknown>);
      } else if (message.type === 'guest-left' && hosting && message.id) {
        if (gameStarted) { markOffline(message.id); return; }
        send({ type: 'remove-guest', to: message.id });
        peers.get(message.id)?.pc.close(); peers.delete(message.id);
        lobby.seats = lobby.seats.filter((s) => s.id !== message.id);
        lobby.bots = Math.min(3, Math.max(lobby.bots, 2 - lobby.seats.length));
        broadcast();
      } else if (message.type === 'guest-return' && hosting && message.id) {
        // The relay kept this person's seat and verified their private room key.
        if (!gameStarted && !lobby.seats.some((seat) => seat.id === message.id)) {
          const colour = colours.find((c) => !lobby.seats.some((seat) => seat.colour === c));
          if (colour) { lobby.seats.push({ id: message.id, name: 'Returning player', colour, ready: false }); broadcast(); }
        }
        say(`${lobby.seats.find((seat) => seat.id === message.id)?.name ?? 'A player'} is reconnecting…`);
      } else if (message.type === 'host-left') {
        if (gameStarted) endMatch('The host left. This match has ended.');
        else say('The host left. This room has ended.');
      }
      else if (message.type === 'rejected') say('The host declined your request.');
      else if (message.type === 'host' && message.id) hostId = message.id;
    } catch { say('The connection could not be completed. Refresh and try again.'); }
  };
  if (!gameStarted) {
    entry.hidden = true;
    roomView.hidden = false;
  }
  linkInput.value = inviteLink();
  $('bot-control').hidden = !hosting;
  $('guest-note').hidden = hosting;
}

if (invitedRoom && roomPattern.test(invitedRoom)) {
  room = invitedRoom;
  $<HTMLButtonElement>('join').hidden = reopening;
  $<HTMLButtonElement>('create').hidden = !reopening;
  if (reopening) {
    $<HTMLButtonElement>('create').textContent = 'Reopen room';
    say('The host tab was refreshed. Reopen the room and share the link again.');
  } else say('Enter your name to ask the host to join.');
}
if (!relay) {
  $<HTMLButtonElement>('create').disabled = true;
  $<HTMLButtonElement>('join').disabled = true;
  say('Online rooms are not available on this deployment yet.');
}
$<HTMLButtonElement>('create').onclick = () => {
  if (!room) room = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
  location.hash = `room=${room}&host`;
  connect('host');
};
$<HTMLButtonElement>('join').onclick = () => connect('guest');
if (invitedRoom && roomPattern.test(invitedRoom) && !reopening && savedKey('guest')) connect('guest');
$<HTMLButtonElement>('copy').onclick = async () => {
  await navigator.clipboard.writeText(inviteLink());
  $<HTMLButtonElement>('copy').textContent = 'Copied';
};
botInput.onchange = () => { if (hosting) { lobby.bots = Number(botInput.value); broadcast(); } };
nameInput.onchange = () => {
  if (hosting) { const seat = lobby.seats.find((s) => s.id === self); if (seat) { seat.name = cleanName(); broadcast(); } }
  else if (peers.get(hostId)?.channel.readyState === 'open') peers.get(hostId)!.channel.send(JSON.stringify({ type: 'name', name: cleanName() }));
};
window.addEventListener('beforeunload', () => { socket?.close(); closePeers(); });
