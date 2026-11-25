// The online link: one WebSocket to the room relay (worker/chowka-signal.ts).
//
// Phones freeze background tabs, and Safari drops their sockets within
// seconds of switching apps. This link expects that: it keeps a private key
// for the seat, reconnects on its own with back-off, reconnects at once when
// the page becomes visible or the network returns, and pings so a socket that
// silently died is noticed. The relay keeps the seat while we are away.

export type Role = 'host' | 'guest';
export type MemberInfo = { id: string; name: string; approved: boolean; online: boolean };
export type LinkState = 'connecting' | 'online' | 'reconnecting' | 'closed';

export type RelayEvents = {
  welcome(info: { id: string; hostId: string; hostName?: string; approved?: boolean; hostOnline?: boolean; members?: MemberInfo[] }): void;
  member(member: MemberInfo): void;
  gone(id: string): void;
  rename(id: string, name: string): void;
  host(online: boolean, name: string): void;
  approved(): void;
  data(from: string, data: Record<string, unknown>): void;
  state(state: LinkState, reason?: string): void;
};

// Reasons the relay gives when it refuses or ends a connection. These are final.
const FINAL = new Set(['notFound', 'taken', 'full', 'declined', 'ended', 'replaced', 'invalid']);

export class RelayLink {
  self = '';
  hostId = '';
  private socket: WebSocket | null = null;
  private create: boolean;
  private retry = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private pongTimer = 0;
  private openTimer = 0;
  private finished = false;
  private lastTick = Date.now();
  private tickTimer = 0;
  private reason = '';
  private readonly wake = () => this.check();
  private readonly onVisible = () => { if (document.visibilityState === 'visible') this.check(); };

  constructor(
    private opts: { base: string; code: string; role: Role; key: string; name: string; create: boolean },
    private on: RelayEvents,
  ) {
    this.create = opts.create;
  }

  start() {
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.wake);
    window.addEventListener('pageshow', this.wake);
    window.addEventListener('focus', this.wake);
    // A frozen page's timers stop. A long gap between ticks means we just woke up.
    this.tickTimer = window.setInterval(() => {
      const now = Date.now();
      if (now - this.lastTick > 6000) this.check();
      this.lastTick = now;
    }, 2000);
    this.connect();
  }

  get open() { return this.socket?.readyState === WebSocket.OPEN; }

  send(to: string, data: Record<string, unknown>) { this.raw({ type: 'msg', to, data }); }
  decide(to: string, accept: boolean) { this.raw({ type: 'decision', to, accept }); }
  remove(to: string) { this.raw({ type: 'remove', to }); }
  lock(locked: boolean) { this.raw({ type: locked ? 'lock' : 'unlock' }); }
  rename(name: string) { this.opts.name = name; if (this.opts.role === 'guest') this.raw({ type: 'name', name }); }

  /** The host ends the room for everyone, or a guest gives up their seat. */
  leave() {
    this.raw({ type: this.opts.role === 'host' ? 'close' : 'leave' });
    this.stop('left');
  }

  stop(reason = 'stopped') {
    this.finished = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.tickTimer);
    this.clearTimers();
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.wake);
    window.removeEventListener('pageshow', this.wake);
    window.removeEventListener('focus', this.wake);
    const socket = this.socket;
    this.socket = null;
    // Let a final message flush before closing.
    if (socket) window.setTimeout(() => socket.close(1000, reason), 50);
  }

  private raw(value: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }

  private clearTimers() {
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.pongTimer);
    window.clearTimeout(this.openTimer);
  }

  private url() {
    const q = new URLSearchParams({ role: this.opts.role, key: this.opts.key, name: this.opts.name });
    if (this.create) q.set('create', '1');
    return `${this.opts.base}/room/${this.opts.code}?${q}`;
  }

  private connect() {
    if (this.finished) return;
    window.clearTimeout(this.retryTimer);
    this.clearTimers();
    const old = this.socket;
    this.socket = null;
    if (old) { old.onclose = old.onmessage = old.onerror = old.onopen = null; try { old.close(); } catch { /* gone */ } }
    this.on.state(this.retry ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try { socket = new WebSocket(this.url()); }
    catch { this.later(); return; }
    this.socket = socket;
    this.reason = '';
    // iOS can leave a new socket stuck "connecting" after waking. Give up and retry.
    this.openTimer = window.setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) { this.retry = Math.max(this.retry, 1); this.connect(); }
    }, 8000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      window.clearTimeout(this.openTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 15_000);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (event.data === 'pong') { window.clearTimeout(this.pongTimer); return; }
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      switch (message.type) {
        case 'welcome': {
          this.retry = 0;
          this.create = false;
          this.self = String(message.id);
          this.hostId = String(message.hostId);
          this.on.state('online');
          this.on.welcome(message as Parameters<RelayEvents['welcome']>[0]);
          break;
        }
        case 'member': this.on.member(message.member as MemberInfo); break;
        case 'gone': this.on.gone(String(message.id)); break;
        case 'rename': this.on.rename(String(message.id), String(message.name)); break;
        case 'host': this.on.host(message.online === true, String(message.name ?? 'The host')); break;
        case 'approved': this.on.approved(); break;
        case 'msg':
          if (message.data && typeof message.data === 'object') this.on.data(String(message.from), message.data as Record<string, unknown>);
          break;
        case 'error': this.reason = String(message.reason); break;
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (FINAL.has(this.reason)) {
        this.finished = true;
        this.stop(this.reason);
        this.on.state('closed', this.reason);
      } else this.later();
    };
  }

  private later() {
    if (this.finished) return;
    this.on.state('reconnecting');
    const delay = Math.min(8000, 400 * 2 ** this.retry++);
    // A hidden page is frozen anyway; the visibility event reconnects it.
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private ping() {
    if (!this.open) return;
    this.socket!.send('ping');
    window.clearTimeout(this.pongTimer);
    this.pongTimer = window.setTimeout(() => { this.retry = Math.max(this.retry, 1); this.connect(); }, 6000);
  }

  /** Called when the page wakes: make sure the socket is really alive. */
  private check() {
    if (this.finished) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) {
      this.retry = Math.min(this.retry, 1);
      this.connect();
    } else if (this.open) this.ping();
  }
}
