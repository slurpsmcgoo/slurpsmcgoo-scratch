// Transports: how peers reach the room host. PeerJS (WebRTC, across the
// internet) for real games, BroadcastChannel (tabs of one browser) for
// development, and in-memory for tests. All look the same to the room.

import { CFG } from '../config.ts';

export interface Link {
  send(msg: unknown): void;
  onMessage(fn: (msg: unknown) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

export interface HostTransport {
  onLink(fn: (link: Link) => void): void;
  close(): void;
}

export interface Transport {
  host(room: string): Promise<HostTransport>;
  join(room: string): Promise<Link>;
}

/** A pair of linked endpoints. Messages are delivered asynchronously, like a network. */
function linkPair(): [Link, Link] {
  const make = () => ({ msg: [] as ((m: unknown) => void)[], close: [] as (() => void)[], closed: false });
  const a = make();
  const b = make();
  const end = (me: typeof a, them: typeof a): Link => ({
    send(m) {
      if (me.closed) return;
      const copy = JSON.parse(JSON.stringify(m));
      queueMicrotask(() => them.msg.forEach((f) => f(copy)));
    },
    onMessage: (f) => void me.msg.push(f),
    onClose: (f) => void me.close.push(f),
    close() {
      if (me.closed) return;
      me.closed = them.closed = true;
      queueMicrotask(() => [...me.close, ...them.close].forEach((f) => f()));
    },
  });
  return [end(a, b), end(b, a)];
}

export function memoryTransport(): Transport {
  const hosts = new Map<string, (l: Link) => void>();
  return {
    async host(room) {
      if (hosts.has(room)) throw new Error('room taken');
      let cb: (l: Link) => void = () => {};
      hosts.set(room, (l) => cb(l));
      return { onLink: (f) => void (cb = f), close: () => void hosts.delete(room) };
    },
    async join(room) {
      const h = hosts.get(room);
      if (!h) throw new Error('no such room');
      const [mine, theirs] = linkPair();
      h(theirs);
      return mine;
    },
  };
}

interface BcMsg {
  from: string;
  to: string;
  kind: 'connect' | 'welcome' | 'msg' | 'close';
  data?: unknown;
}

/** Tabs of one browser, through a BroadcastChannel per room. */
export function broadcastTransport(): Transport {
  return {
    async host(room) {
      const ch = new BroadcastChannel(`kubb-${room}`);
      const links = new Map<string, { msg: ((m: unknown) => void)[]; close: (() => void)[] }>();
      let onLink: (l: Link) => void = () => {};
      ch.onmessage = (e: MessageEvent<BcMsg>) => {
        const m = e.data;
        if (m.to !== 'host') return;
        if (m.kind === 'connect') {
          const h = { msg: [] as ((m: unknown) => void)[], close: [] as (() => void)[] };
          links.set(m.from, h);
          ch.postMessage({ from: 'host', to: m.from, kind: 'welcome' } satisfies BcMsg);
          onLink({
            send: (data) => ch.postMessage({ from: 'host', to: m.from, kind: 'msg', data } satisfies BcMsg),
            onMessage: (f) => void h.msg.push(f),
            onClose: (f) => void h.close.push(f),
            close: () => ch.postMessage({ from: 'host', to: m.from, kind: 'close' } satisfies BcMsg),
          });
        } else if (m.kind === 'msg') links.get(m.from)?.msg.forEach((f) => f(m.data));
        else if (m.kind === 'close') {
          links.get(m.from)?.close.forEach((f) => f());
          links.delete(m.from);
        }
      };
      return { onLink: (f) => void (onLink = f), close: () => ch.close() };
    },
    join(room) {
      return new Promise((resolve, reject) => {
        const ch = new BroadcastChannel(`kubb-${room}`);
        const me = Math.random().toString(36).slice(2);
        const msg: ((m: unknown) => void)[] = [];
        const close: (() => void)[] = [];
        const timer = setTimeout(() => {
          ch.close();
          reject(new Error('No game with that code in this browser'));
        }, 2500);
        ch.onmessage = (e: MessageEvent<BcMsg>) => {
          const m = e.data;
          if (m.to !== me) return;
          if (m.kind === 'welcome') {
            clearTimeout(timer);
            resolve({
              send: (data) => ch.postMessage({ from: me, to: 'host', kind: 'msg', data } satisfies BcMsg),
              onMessage: (f) => void msg.push(f),
              onClose: (f) => void close.push(f),
              close: () => {
                ch.postMessage({ from: me, to: 'host', kind: 'close' } satisfies BcMsg);
                ch.close();
              },
            });
          } else if (m.kind === 'msg') msg.forEach((f) => f(m.data));
          else if (m.kind === 'close') close.forEach((f) => f());
        };
        ch.postMessage({ from: me, to: 'host', kind: 'connect' } satisfies BcMsg);
      });
    },
  };
}

/** WebRTC through PeerJS. Its public server only introduces peers; game data goes directly between browsers. */
export function peerTransport(): Transport {
  const id = (room: string) => CFG.net.peerPrefix + room.toLowerCase();
  return {
    async host(room) {
      const { Peer } = await import('peerjs');
      return new Promise((resolve, reject) => {
        const peer = new Peer(id(room));
        let onLink: (l: Link) => void = () => {};
        peer.on('open', () => resolve({ onLink: (f) => void (onLink = f), close: () => peer.destroy() }));
        peer.on('error', (err) => reject(new Error(err.type === 'unavailable-id' ? 'That room code is taken' : `Network: ${err.type}`)));
        peer.on('connection', (conn) => {
          conn.on('open', () => {
            onLink({
              send: (m) => void conn.send(m),
              onMessage: (f) => void conn.on('data', f),
              onClose: (f) => void conn.on('close', f),
              close: () => conn.close(),
            });
          });
        });
      });
    },
    async join(room) {
      const { Peer } = await import('peerjs');
      return new Promise((resolve, reject) => {
        const peer = new Peer();
        const timer = setTimeout(() => {
          peer.destroy();
          reject(new Error('Could not reach that game. Check the code, or try another network.'));
        }, 15000);
        peer.on('error', (err) => {
          clearTimeout(timer);
          peer.destroy();
          reject(new Error(err.type === 'peer-unavailable' ? 'No game with that code' : `Network: ${err.type}`));
        });
        peer.on('open', () => {
          const conn = peer.connect(id(room), { reliable: true, serialization: 'json' });
          conn.on('open', () => {
            clearTimeout(timer);
            resolve({
              send: (m) => void conn.send(m),
              onMessage: (f) => void conn.on('data', f),
              onClose: (f) => void conn.on('close', f),
              close: () => {
                conn.close();
                peer.destroy();
              },
            });
          });
        });
      });
    },
  };
}

/** Short, unambiguous room codes. */
export function roomCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}
