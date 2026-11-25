// The Chowka Bhara room relay.
//
// One Durable Object per room. Every player keeps a WebSocket open to it, and
// it forwards small JSON game messages between the host and the guests. The
// host's browser still runs the actual game; the relay only keeps the room,
// the seats, and the messages moving.
//
// Phones drop connections all the time (switching apps, locking the screen,
// changing networks), so a dropped connection is never treated as leaving.
// Each player holds a private key. Reconnecting with the same key gets the
// same seat back. If the host is away, the room waits GRACE_MS for them before
// it closes, and join requests wait in a queue until they return.

interface Env {
  ROOMS: DurableObjectNamespace;
  SITE_ORIGIN: string;
}

type Role = 'host' | 'guest';
type Attachment = { id: string; role: Role; since: number };
type Member = { id: string; key: string; name: string; approved: boolean };
type RoomData = { hostKey: string; hostId: string; hostName: string; locked: boolean; members: Member[]; hostGoneAt?: number };

// Six characters from an alphabet without look-alikes (no 0/O, 1/I/L).
const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const KEY = /^[a-f0-9]{32}$/;
const MAX_MESSAGE = 131_072;
const MAX_SEATED = 3; // the host plus three guests fill the board
const MAX_WAITING = 6;
const GRACE_MS = 30 * 60_000; // how long a room waits for its host
// A dying network can leave a socket that looks open but carries nothing.
// Pages ping every 15 s while visible; a socket silent for longer than
// SILENT_MS is treated as dropped. The alarm checks every CHECK_MS while
// anyone is connected.
const SILENT_MS = 45_000;
const CHECK_MS = 20_000;

// Close codes the client treats as final (it does not retry these).
const CLOSED = { notFound: 4004, taken: 4009, full: 4010, declined: 4003, ended: 4000, replaced: 4001, invalid: 4400 };

function send(socket: WebSocket, value: unknown) {
  try { socket.send(JSON.stringify(value)); } catch { /* The socket is already closing. */ }
}

const cleanName = (value: string | null) => (value ?? '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Player';

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const code = url.pathname.match(/^\/room\/([A-Z0-9]{6})$/)?.[1];
    if (!code || !CODE.test(code)) return new Response('Unknown room', { status: 404 });
    const origins = env.SITE_ORIGIN.split(',').map((origin) => origin.trim());
    if (!origins.includes(request.headers.get('Origin') ?? '')) return new Response('Origin denied', { status: 403 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
};

export class Room implements DurableObject {
  constructor(private state: DurableObjectState) {
    // Answer keep-alive pings without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private sockets() {
    return this.state.getWebSockets().map((socket) => ({ socket, who: socket.deserializeAttachment() as Attachment | null }))
      .filter((entry): entry is { socket: WebSocket; who: Attachment } => !!entry.who);
  }
  private socketsOf(id: string) { return this.sockets().filter(({ who }) => who.id === id).map(({ socket }) => socket); }
  private online(id: string) { return this.socketsOf(id).length > 0; }
  private load() { return this.state.storage.get<RoomData>('room'); }
  private save(room: RoomData) { return this.state.storage.put('room', room); }

  // Refuse a connection with a reason the page can show. A plain HTTP error
  // would reach the browser only as an anonymous failed WebSocket.
  private refuse(reason: keyof typeof CLOSED) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    send(server, { type: 'error', reason });
    server.close(CLOSED[reason], reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  private memberView(room: RoomData) {
    return room.members.map(({ id, name, approved }) => ({ id, name, approved, online: this.online(id) }));
  }

  private tellHost(room: RoomData, value: unknown) {
    for (const socket of this.socketsOf(room.hostId)) send(socket, value);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const key = url.searchParams.get('key') ?? '';
    if ((role !== 'host' && role !== 'guest') || !KEY.test(key)) return this.refuse('invalid');
    const name = cleanName(url.searchParams.get('name'));
    let room = await this.load();

    let id: string;
    if (role === 'host') {
      if (!room) {
        if (url.searchParams.get('create') !== '1') return this.refuse('notFound');
        room = { hostKey: key, hostId: crypto.randomUUID(), hostName: name, locked: false, members: [] };
      } else if (room.hostKey !== key) return this.refuse('taken');
      room.hostName = name;
      id = room.hostId;
    } else {
      if (!room) return this.refuse('notFound');
      let member = room.members.find((entry) => entry.key === key);
      if (!member) {
        const seated = room.members.filter((entry) => entry.approved).length;
        const waiting = room.members.length - seated;
        if (room.locked || seated >= MAX_SEATED || waiting >= MAX_WAITING) return this.refuse('full');
        member = { id: crypto.randomUUID(), key, name, approved: false };
        room.members.push(member);
      } else member.name = name;
      id = member.id;
    }
    if (role === 'host') delete room.hostGoneAt;
    await this.save(room);

    const [client, server] = Object.values(new WebSocketPair());
    // An older socket for the same seat (a frozen tab, a lost network) is
    // replaced quietly by this one.
    for (const old of this.socketsOf(id)) {
      old.serializeAttachment(null);
      try { old.close(CLOSED.replaced, 'Reconnected elsewhere'); } catch { /* already closed */ }
    }
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, role, since: Date.now() } satisfies Attachment);
    await this.schedule(room);

    if (role === 'host') {
      send(server, { type: 'welcome', id, role, hostId: id, locked: room.locked, members: this.memberView(room) });
      for (const member of room.members) for (const socket of this.socketsOf(member.id))
        send(socket, { type: 'host', online: true, name: room.hostName });
    } else {
      const member = room.members.find((entry) => entry.id === id)!;
      send(server, { type: 'welcome', id, role, hostId: room.hostId, hostName: room.hostName,
        approved: member.approved, hostOnline: this.online(room.hostId) });
      this.tellHost(room, { type: 'member', member: { id, name: member.name, approved: member.approved, online: true } });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return socket.close(1009, 'Message too large');
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw); } catch { return socket.close(1003, 'Invalid message'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.close(1003, 'Invalid message');
    const who = socket.deserializeAttachment() as Attachment | null;
    const room = await this.load();
    if (!who || !room) return;

    if (who.role === 'host') {
      const to = typeof message.to === 'string' ? message.to : '';
      if (message.type === 'msg') {
        const data = message.data;
        if (!data || typeof data !== 'object') return;
        const targets = to === '*' ? room.members.filter((m) => m.approved) : room.members.filter((m) => m.approved && m.id === to);
        const wire = JSON.stringify({ type: 'msg', from: room.hostId, data });
        for (const member of targets) for (const target of this.socketsOf(member.id)) {
          try { target.send(wire); } catch { /* closing */ }
        }
      } else if (message.type === 'decision') {
        const member = room.members.find((m) => m.id === to);
        if (!member || member.approved) return;
        if (message.accept === true && room.members.filter((m) => m.approved).length < MAX_SEATED) {
          member.approved = true;
          await this.save(room);
          for (const target of this.socketsOf(member.id)) send(target, { type: 'approved' });
          send(socket, { type: 'member', member: { id: member.id, name: member.name, approved: true, online: this.online(member.id) } });
        } else {
          room.members = room.members.filter((m) => m !== member);
          await this.save(room);
          for (const target of this.socketsOf(member.id)) { send(target, { type: 'error', reason: 'declined' }); target.close(CLOSED.declined, 'declined'); }
          send(socket, { type: 'gone', id: member.id });
        }
      } else if (message.type === 'remove') {
        const member = room.members.find((m) => m.id === to);
        if (!member) return;
        room.members = room.members.filter((m) => m !== member);
        await this.save(room);
        for (const target of this.socketsOf(member.id)) { send(target, { type: 'error', reason: 'replaced' }); target.close(CLOSED.replaced, 'Seat replaced'); }
        send(socket, { type: 'gone', id: member.id });
      } else if (message.type === 'lock' || message.type === 'unlock') {
        room.locked = message.type === 'lock';
        await this.save(room);
      } else if (message.type === 'close') {
        await this.end();
      }
      return;
    }

    // A guest can only talk to the host, and only once let in.
    const member = room.members.find((m) => m.id === who.id);
    if (!member) return;
    if (message.type === 'name' && typeof message.name === 'string') {
      member.name = cleanName(message.name);
      await this.save(room);
      this.tellHost(room, { type: 'rename', id: member.id, name: member.name });
    } else if (message.type === 'msg' && member.approved && message.data && typeof message.data === 'object') {
      this.tellHost(room, { type: 'msg', from: member.id, data: message.data });
    } else if (message.type === 'leave') {
      room.members = room.members.filter((m) => m !== member);
      await this.save(room);
      this.tellHost(room, { type: 'gone', id: member.id });
      socket.serializeAttachment(null);
      socket.close(CLOSED.ended, 'left');
    }
  }

  async webSocketClose(socket: WebSocket) { await this.dropped(socket); }
  async webSocketError(socket: WebSocket) { await this.dropped(socket); }

  // A connection went away. That is not leaving: the seat is kept.
  private async dropped(socket: WebSocket) {
    const who = socket.deserializeAttachment() as Attachment | null;
    socket.serializeAttachment(null);
    if (!who) return;
    const room = await this.load();
    if (!room || this.online(who.id)) return;
    if (who.role === 'host') {
      for (const member of room.members) for (const target of this.socketsOf(member.id))
        send(target, { type: 'host', online: false, name: room.hostName });
      room.hostGoneAt = Date.now();
      await this.save(room);
      await this.schedule(room);
    } else {
      const member = room.members.find((m) => m.id === who.id);
      if (member) this.tellHost(room, { type: 'member', member: { id: member.id, name: member.name, approved: member.approved, online: false } });
    }
  }

  // One alarm does two jobs: it closes sockets that went silent, and it ends
  // the room once its host has been away for GRACE_MS.
  private async schedule(room: RoomData) {
    const times: number[] = [];
    if (this.sockets().length) times.push(Date.now() + CHECK_MS);
    if (room.hostGoneAt) times.push(room.hostGoneAt + GRACE_MS);
    else if (!this.online(room.hostId)) times.push(Date.now() + GRACE_MS);
    await this.state.storage.setAlarm(Math.min(...times));
  }

  async alarm() {
    const now = Date.now();
    for (const { socket, who } of this.sockets()) {
      const last = Math.max(who.since, this.state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0);
      if (now - last <= SILENT_MS) continue;
      try { socket.close(1001, 'Silent'); } catch { /* already gone */ }
      await this.dropped(socket);
    }
    const room = await this.load();
    if (!room) return;
    if (!this.online(room.hostId) && now >= (room.hostGoneAt ?? now) + GRACE_MS - 1000) { await this.end(); return; }
    await this.schedule(room);
  }

  private async end() {
    for (const { socket } of this.sockets()) {
      send(socket, { type: 'error', reason: 'ended' });
      socket.serializeAttachment(null);
      try { socket.close(CLOSED.ended, 'Room closed'); } catch { /* closing */ }
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}
