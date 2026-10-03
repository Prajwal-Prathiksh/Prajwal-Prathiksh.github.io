interface Env {
  ROOMS: DurableObjectNamespace;
  SITE_ORIGIN: string;
}

type Peer = { id: string; role: 'host' | 'guest'; approved: boolean; locked?: boolean; token?: string };
type Reservation = { id: string; token: string; approved: boolean };

const ROOM = /^[a-f0-9]{32}$/;
const MAX_MESSAGE = 32_768;
const TOKEN = /^[a-f0-9]{32}$/;

function send(socket: WebSocket, value: unknown) {
  socket.send(JSON.stringify(value));
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const room = url.pathname.match(/^\/room\/([a-f0-9]{32})$/)?.[1];
    if (!room || !ROOM.test(room)) return new Response('Unknown room', { status: 404 });
    if (!env.SITE_ORIGIN.split(',').map((origin) => origin.trim()).includes(request.headers.get('Origin') ?? ''))
      return new Response('Origin denied', { status: 403 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class Room implements DurableObject {
  constructor(private state: DurableObjectState) {}

  private peers() {
    return this.state.getWebSockets().map((socket) => ({ socket, peer: socket.deserializeAttachment() as Peer }));
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    if (role !== 'host' && role !== 'guest') return new Response('Invalid role', { status: 400 });
    const suppliedToken = url.searchParams.get('token');
    if (suppliedToken && !TOKEN.test(suppliedToken)) return new Response('Invalid room key', { status: 400 });
    // Older cached pages do not send a key. Let them play, but they cannot resume.
    const token = suppliedToken ?? crypto.randomUUID().replaceAll('-', '');
    const peers = this.peers();
    if (role === 'host' && peers.some(({ peer }) => peer.role === 'host')) return new Response('Host already connected', { status: 409 });
    const reservations = await this.state.storage.get<Reservation[]>('reservations') ?? [];
    const returning = role === 'guest' ? reservations.find((entry) => entry.token === token) : undefined;
    const host = peers.find(({ peer }) => peer.role === 'host');
    if (role === 'guest' && (!host || (!returning && (host.peer.locked || reservations.length >= 3))))
      return new Response('Room closed or full', { status: 409 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peer: Peer = { id: returning?.id ?? crypto.randomUUID(), role,
      approved: role === 'host' || returning?.approved === true, token };
    if (role === 'guest' && !returning) {
      reservations.push({ id: peer.id, token, approved: false });
      await this.state.storage.put('reservations', reservations);
    }
    this.state.acceptWebSocket(server);
    server.serializeAttachment(peer);
    for (const old of peers.filter(({ peer: other }) => other.id === peer.id)) old.socket.close(1001, 'Reconnected');
    send(server, { type: 'hello', id: peer.id, role });
    if (role === 'guest') {
      if (host) {
        send(server, { type: 'host', id: host.peer.id });
        if (peer.approved) {
          send(server, { type: 'approved' });
          send(host.socket, { type: 'guest-return', id: peer.id });
        } else send(host.socket, { type: 'join-request', id: peer.id });
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return socket.close(1009, 'Message too large');
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw); } catch { return socket.close(1003, 'Invalid message'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.close(1003, 'Invalid message');
    const sender = socket.deserializeAttachment() as Peer;
    const peers = this.peers();
    if (sender.role === 'host' && message.type === 'lock') {
      sender.locked = true;
      socket.serializeAttachment(sender);
      return;
    }
    if (sender.role === 'host' && message.type === 'decision' && typeof message.to === 'string') {
      const guest = peers.find(({ peer }) => peer.id === message.to && peer.role === 'guest');
      if (!guest) return;
      if (message.accept === true) {
        guest.peer.approved = true;
        guest.socket.serializeAttachment(guest.peer);
        const reservations = await this.state.storage.get<Reservation[]>('reservations') ?? [];
        const reservation = reservations.find((entry) => entry.id === guest.peer.id);
        if (reservation) { reservation.approved = true; await this.state.storage.put('reservations', reservations); }
        send(guest.socket, { type: 'approved' });
        send(socket, { type: 'approved', id: guest.peer.id });
      } else {
        const reservations = await this.state.storage.get<Reservation[]>('reservations') ?? [];
        await this.state.storage.put('reservations', reservations.filter((entry) => entry.id !== guest.peer.id));
        send(guest.socket, { type: 'rejected' });
        guest.socket.close(1008, 'Host declined');
      }
      return;
    }
    if (sender.role === 'host' && message.type === 'remove-guest' && typeof message.to === 'string') {
      const reservations = await this.state.storage.get<Reservation[]>('reservations') ?? [];
      await this.state.storage.put('reservations', reservations.filter((entry) => entry.id !== message.to));
      const guest = peers.find(({ peer }) => peer.role === 'guest' && peer.id === message.to);
      if (guest) guest.socket.close(1008, 'Seat replaced');
      return;
    }
    if (message.type !== 'signal' || !sender.approved || typeof message.to !== 'string') return;
    const target = peers.find(({ peer }) => peer.id === message.to && peer.approved);
    if (!target || (sender.role === 'guest' && target.peer.role !== 'host')) return;
    const signal = message.signal;
    if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return;
    const value = signal as Record<string, unknown>;
    if (value.type !== 'offer' && value.type !== 'answer' && value.type !== 'ice') return;
    send(target.socket, { type: 'signal', from: sender.id, signal: value });
  }

  async webSocketClose(socket: WebSocket) { await this.leave(socket); }
  async webSocketError(socket: WebSocket) { await this.leave(socket); }

  private async leave(socket: WebSocket) {
    const peer = socket.deserializeAttachment() as Peer;
    if (!peer) return;
    const others = this.peers().filter(({ socket: other }) => other !== socket);
    if (others.some(({ peer: other }) => other.id === peer.id)) return;
    if (peer.role === 'host') {
      await this.state.storage.delete('reservations');
      for (const { socket: other } of others) {
        send(other, { type: 'host-left' });
        other.close(1001, 'Host left');
      }
    } else {
      const host = others.find(({ peer: other }) => other.role === 'host');
      if (!host) { await this.state.storage.delete('reservations'); return; }
      if (!peer.approved) {
        const reservations = await this.state.storage.get<Reservation[]>('reservations') ?? [];
        await this.state.storage.put('reservations', reservations.filter((entry) => entry.id !== peer.id));
      }
      send(host.socket, { type: 'guest-left', id: peer.id });
    }
  }
}
