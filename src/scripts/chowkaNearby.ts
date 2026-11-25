// The nearby link: direct WebRTC data channels on the same Wi-Fi or hotspot,
// with no internet and no server.
//
// WebRTC needs the two phones to swap a connection offer and answer once.
// Online, a server carries those. Here they travel as QR codes instead:
//   1. The host shows an offer as a link in a QR code. The guest scans it with
//      the phone's Camera, which opens this page (saved offline by the service
//      worker) with the offer in the URL fragment.
//   2. The guest's page shows its answer as a QR code, and the host scans it.
// The phones then talk directly over the local network. There are no ICE
// servers: STUN would need the internet, and phones on one network can reach
// each other by their local addresses.

export type NearbyEvents = {
  peer(id: string, name: string, online: boolean): void;
  data(from: string, data: Record<string, unknown>): void;
};

type Offer = { v: 1; r: string; o: string; n: string; s: string };
type Answer = { v: 1; r: string; o: string; g: string; n: string; s: string };

const PREFIX = 'CB1.';
export const HOST_ID = 'host';

// ---- Packing connection descriptions small enough for a comfortable QR ----

function toBase64Url(bytes: Uint8Array) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(text: string) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// Lines a data-channel connection does not need. Dropping them keeps the QR small.
function trimSdp(sdp: string) {
  return sdp.split(/\r?\n/).filter((line) => line
    && !line.startsWith('a=extmap-allow-mixed')
    && !line.startsWith('a=msid-semantic')
    && !(line.startsWith('a=candidate:') && / tcp /i.test(line))).join('\r\n') + '\r\n';
}

// The compact form. A data-channel description only needs the ICE username
// and password, the DTLS fingerprint, the DTLS role and the addresses; the
// other side rebuilds a standard description around them. That shrinks an
// invite link from about 600 characters to about 200, so its QR code has far
// fewer, larger squares and scans easily from one phone screen to another.
//
//   CB2.<kind>~<room>~<offer>~<guest>~<name>~<role>~<ufrag>~<pwd>~<fingerprint>~<addresses>
const COMPACT = 'CB2.';
const ROLES: Record<string, string> = { actpass: 'c', active: 'a', passive: 'p' };
const ROLE_NAMES = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [v, k]));
const TYPES: Record<string, string> = { host: 'h', srflx: 's', prflx: 'p', relay: 'r' };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
const PRIORITY: Record<string, number> = { host: 2122260223, prflx: 1853824767, srflx: 1686052607, relay: 41885439 };
// ICE passwords use + and /, which URLs and QR text can mangle. They never use - or _.
const iceOut = (text: string) => text.replace(/\+/g, '-').replace(/\//g, '_');
const iceIn = (text: string) => text.replace(/-/g, '+').replace(/_/g, '/');

function compact(value: Offer | Answer): string | null {
  const sdp = value.s;
  const line = (key: string) => sdp.match(new RegExp(`^a=${key}:(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const ufrag = line('ice-ufrag');
  const pwd = line('ice-pwd');
  const [alg, hex] = line('fingerprint').split(' ');
  const role = ROLES[line('setup')];
  if (!ufrag || !pwd || alg?.toLowerCase() !== 'sha-256' || !hex || !role || (line('mid') || '0') !== '0'
    || (line('sctp-port') || '5000') !== '5000' || /[~,@]/.test(ufrag + pwd)) return null;
  const fingerprint = toBase64Url(Uint8Array.from(hex.split(':'), (h) => parseInt(h, 16)));
  const addresses = [...sdp.matchAll(/^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (\w+)/gim)]
    .map(([, ip, port, type]) => ({ ip, port, type: TYPES[type] }))
    .filter((c) => c.type && !/[~,@]/.test(c.ip))
    // Plain IPv4 addresses first: they work on the most networks.
    .sort((x, y) => Number(/^\d+\.\d+\.\d+\.\d+$/.test(y.ip)) - Number(/^\d+\.\d+\.\d+\.\d+$/.test(x.ip)))
    .slice(0, 4)
    .map((c) => `${c.type}${c.port}@${c.ip}`);
  if (!addresses.length) return null;
  const answer = 'g' in value;
  const name = encodeURIComponent(value.n).replace(/~/g, '%7E');
  return COMPACT + [answer ? 'a' : 'o', value.r, value.o, answer ? value.g : '', name, role, iceOut(ufrag), iceOut(pwd), fingerprint, addresses.join(',')].join('~');
}

function expand(text: string): Offer | Answer | null {
  const [kind, r, o, g, name, role, ufrag, pwd, fingerprint, addresses] = text.slice(COMPACT.length).split('~');
  if ((kind !== 'o' && kind !== 'a') || !r || !o || !ROLE_NAMES[role] || !ufrag || !pwd || !fingerprint || !addresses) return null;
  const hex = [...fromBase64Url(fingerprint)].map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const candidates = addresses.split(',').map((entry, i) => {
    const match = entry.match(/^([hspr])(\d+)@(.+)$/);
    if (!match) return '';
    const type = TYPE_NAMES[match[1]];
    return `a=candidate:${i + 1} 1 udp ${PRIORITY[type]} ${match[3]} ${match[2]} typ ${type}${type === 'host' ? '' : ' raddr 0.0.0.0 rport 0'} generation 0`;
  }).filter(Boolean);
  const s = [
    'v=0', `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...candidates,
    `a=ice-ufrag:${iceIn(ufrag)}`, `a=ice-pwd:${iceIn(pwd)}`, 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${hex}`, `a=setup:${ROLE_NAMES[role]}`, 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ].join('\r\n') + '\r\n';
  let n = 'Player';
  try { n = decodeURIComponent(name); } catch { /* keep the default */ }
  return kind === 'a' ? { v: 1, r, o, g, n, s } : { v: 1, r, o, n, s };
}

export async function pack(value: Offer | Answer) {
  const small = compact(value);
  if (small) return small;
  // Anything unusual travels in full, compressed.
  const json = new TextEncoder().encode(JSON.stringify(value));
  return PREFIX + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function unpack<T extends Offer | Answer>(text: string): Promise<T | null> {
  try {
    const raw = text.trim();
    if (raw.startsWith(COMPACT)) return expand(raw) as T | null;
    const body = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : '';
    if (!body) return null;
    const json = new TextDecoder().decode(await pipe(fromBase64Url(body), new DecompressionStream('deflate-raw')));
    const value = JSON.parse(json);
    return value && value.v === 1 && typeof value.s === 'string' ? value as T : null;
  } catch { return null; }
}

/** True for a reply code in either form. */
export const isReply = (text: string) => /^CB[12]\./.test(text.trim());

const randomId = (bytes = 8) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');

// Wait until the browser has listed its local addresses in the description.
async function gathered(pc: RTCPeerConnection) {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
      pc.addEventListener('icegatheringstatechange', done);
      // Host addresses come almost at once; never stall the QR on stragglers.
      window.setTimeout(resolve, 2500);
    });
  }
  return trimSdp(pc.localDescription!.sdp);
}

function wire(channel: RTCDataChannel, from: string, on: NearbyEvents) {
  channel.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data));
      if (data && typeof data === 'object') on.data(from, data);
    } catch { /* ignore */ }
  };
}

// ---- Host ----

export class NearbyHost {
  readonly self = HOST_ID;
  readonly hostId = HOST_ID;
  private peers = new Map<string, { pc: RTCPeerConnection; channel: RTCDataChannel; name: string }>();
  private invites = new Map<string, { pc: RTCPeerConnection; channel: RTCDataChannel }>();

  constructor(readonly room: string, private hostName: string, private on: NearbyEvents) {}

  rename(name: string) { this.hostName = name; }

  /** A fresh invite link for one more player. Each link connects one phone. */
  async invite(base: string) {
    // Only the newest few invites stay valid, so stale codes cannot pile up.
    for (const [id, old] of [...this.invites].slice(0, -2)) { old.pc.close(); this.invites.delete(id); }
    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel('chowka', { ordered: true });
    const offerId = randomId(4);
    this.invites.set(offerId, { pc, channel });
    await pc.setLocalDescription(await pc.createOffer());
    const sdp = await gathered(pc);
    const payload = await pack({ v: 1, r: this.room, o: offerId, n: this.hostName, s: sdp });
    return `${base}#join=${payload}`;
  }

  /**
   * Takes the text from a guest's reply code. Resolves with the guest once
   * the direct connection opens, or rejects with a reason to show.
   */
  async accept(text: string): Promise<{ id: string; name: string }> {
    const answer = await unpack<Answer>(text);
    if (!answer || !answer.g || !answer.o) throw new Error('That is not a Chowka Bhara reply code.');
    if (answer.r !== this.room) throw new Error('That reply is for a different game.');
    const invite = this.invites.get(answer.o);
    if (!invite) throw new Error('That reply is for an older code. Ask them to scan the new one.');
    this.invites.delete(answer.o);
    const { pc, channel } = invite;
    const id = answer.g.slice(0, 32);
    const name = (answer.n || 'Player').slice(0, 24);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.s });
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Could not reach their phone. Are you both on the same Wi-Fi or hotspot?')), 15_000);
      channel.onopen = () => { window.clearTimeout(timer); resolve(); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') { window.clearTimeout(timer); reject(new Error('The connection failed. Check you are on the same network and try again.')); }
      };
    }).catch((error) => { pc.close(); throw error; });
    // A returning player replaces their old, dead connection.
    const old = this.peers.get(id);
    if (old && old.pc !== pc) { old.channel.onclose = null; old.pc.close(); }
    this.peers.set(id, { pc, channel, name });
    wire(channel, id, this.on);
    channel.onclose = () => { if (this.peers.get(id)?.pc === pc) this.on.peer(id, name, false); };
    pc.onconnectionstatechange = () => {
      if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && this.peers.get(id)?.pc === pc) this.on.peer(id, name, false);
    };
    this.on.peer(id, name, true);
    return { id, name };
  }

  send(to: string, data: Record<string, unknown>) {
    const text = JSON.stringify(data);
    for (const [id, { channel }] of this.peers) {
      if ((to === '*' || to === id) && channel.readyState === 'open') channel.send(text);
    }
  }

  isOnline(id: string) { return this.peers.get(id)?.channel.readyState === 'open'; }

  drop(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.channel.onclose = null;
    peer.pc.close();
    this.peers.delete(id);
  }

  stop() {
    for (const { pc } of [...this.peers.values(), ...this.invites.values()]) pc.close();
    this.peers.clear();
    this.invites.clear();
  }
}

// ---- Guest ----

export class NearbyGuest {
  readonly hostId = HOST_ID;
  private channel: RTCDataChannel | null = null;
  private pc: RTCPeerConnection | null = null;

  private constructor(readonly self: string, readonly room: string, readonly hostName: string) {}

  /** Reads an invite and prepares the reply code to show the host. */
  static async join(payload: string, self: string, name: string, on: NearbyEvents & { open(): void }) {
    const offer = await unpack<Offer>(payload);
    if (!offer || !offer.o || !offer.r) throw new Error('This invite code could not be read. Ask the host for a new one.');
    const guest = new NearbyGuest(self, offer.r, (offer.n || 'The host').slice(0, 24));
    const pc = new RTCPeerConnection({ iceServers: [] });
    guest.pc = pc;
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      guest.channel = channel;
      wire(channel, HOST_ID, on);
      channel.onopen = () => on.open();
      channel.onclose = () => { if (guest.pc === pc) on.peer(HOST_ID, guest.hostName, false); };
    };
    pc.onconnectionstatechange = () => {
      if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && guest.pc === pc) on.peer(HOST_ID, guest.hostName, false);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.s });
    await pc.setLocalDescription(await pc.createAnswer());
    const sdp = await gathered(pc);
    const reply = await pack({ v: 1, r: offer.r, o: offer.o, g: self, n: name.slice(0, 24), s: sdp });
    return { guest, reply };
  }

  get open() { return this.channel?.readyState === 'open'; }

  send(_to: string, data: Record<string, unknown>) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(data));
  }

  stop() {
    const pc = this.pc;
    this.pc = null;
    pc?.close();
  }
}

export { randomId };
