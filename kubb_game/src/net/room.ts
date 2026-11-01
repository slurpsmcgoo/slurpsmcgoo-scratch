// A room: the host owns the roster and the authoritative game; clients add
// their own players, then mirror the game. During play every action goes
// through the host, which relays it to everyone in one order. Each peer
// simulates every throw itself (deterministically); after each throw the host
// sends its state's hash, and the full state for any peer that disagrees.

import { GameController, type AimInfo, type NetPort } from '../game/controller.ts';
import { hashState } from '../sim/hash.ts';
import { createGame } from '../sim/setup.ts';
import type { Action, GameState, Player, TeamId } from '../types.ts';
import type { PlayerSpec, ToClient, ToHost } from './protocol.ts';
import type { HostTransport, Link } from './transport.ts';

export interface LobbyInfo {
  players: Player[];
  setting: string;
  hostName: string;
  beer: boolean;
}

export class RoomHost implements NetPort {
  readonly isHost = true;
  players: Player[] = [];
  setting = 'park';
  beer = false;
  ctl: GameController | null = null;
  onLobby: (info: LobbyInfo) => void = () => {};
  onStart: (ctl: GameController) => void = () => {};
  onPeers: (n: number) => void = () => {};
  private links = new Map<Link, string>();
  private names = new Map<string, string>();
  private nextId = 0;
  /** Work that must wait until no throw is in flight. */
  private inbox: { link: Link; client: string; action: Action }[] = [];
  private joiners: Link[] = [];
  private dropped: string[] = [];

  constructor(
    private readonly transport: HostTransport,
    readonly clientId: string,
    readonly hostName: string,
  ) {
    transport.onLink((link) => this.accept(link));
  }

  private accept(link: Link): void {
    link.onMessage((m) => this.handle(link, m as ToHost));
    link.onClose(() => this.drop(link));
  }

  private send(link: Link, m: ToClient): void {
    link.send(m);
  }

  private broadcast(m: ToClient, except?: Link): void {
    for (const l of this.links.keys()) if (l !== except) l.send(m);
  }

  private handle(link: Link, m: ToHost): void {
    if (m.t === 'hello') {
      this.links.set(link, m.client);
      this.names.set(m.client, m.name);
      this.onPeers(this.links.size);
      if (this.ctl) {
        // Mid-game: send the state once no throw is in flight, so it includes every relayed action.
        this.joiners.push(link);
        this.settle();
      } else this.send(link, this.lobbyMessage());
      return;
    }
    const client = this.links.get(link);
    if (!client) return;
    if (m.t === 'addPlayer' && !this.ctl) this.addPlayer({ name: m.name, team: m.team, kind: 'human', skill: 'medium' }, client);
    else if (m.t === 'removePlayer' && !this.ctl) {
      const p = this.players.find((x) => x.id === m.id);
      if (p && p.owner === client) this.removePlayer(p.id);
    } else if (m.t === 'action' && this.ctl) {
      this.inbox.push({ link, client, action: m.action });
      this.settle();
    } else if (m.t === 'aim' && this.ctl) {
      this.ctl.receiveAim(m.aim);
      this.broadcast({ t: 'aim', aim: m.aim }, link);
    }
  }

  private drop(link: Link): void {
    const client = this.links.get(link);
    this.links.delete(link);
    this.onPeers(this.links.size);
    if (!client) return;
    if (!this.ctl) {
      this.players = this.players.filter((p) => p.owner !== client);
      this.lobbyChanged();
      return;
    }
    // Mid-game: computer players take over for whoever left (once the throw in flight lands).
    this.dropped.push(client);
    this.settle();
  }

  /**
   * Do the waiting work, in order, whenever no throw is in flight: welcome late
   * joiners, hand dropped players to the computer, then relay queued actions.
   * Only actions the host accepts are relayed; a rejected sender gets the host's state.
   */
  private settle(): void {
    const ctl = this.ctl;
    if (!ctl || ctl.session.busy) return;
    for (const link of this.joiners.splice(0)) if (this.links.has(link)) this.send(link, { t: 'start', state: ctl.state });
    if (this.dropped.length) {
      const gone = new Set(this.dropped.splice(0));
      const s = ctl.state;
      if (s.players.some((p) => gone.has(p.owner))) {
        const next: GameState = {
          ...s,
          players: s.players.map((p) => (gone.has(p.owner) ? { ...p, kind: 'bot', owner: this.clientId, name: `${p.name} (CPU)` } : p)),
        };
        ctl.resync(next);
        this.broadcast({ t: 'sync', seq: next.seq, hash: hashState(next), state: next });
      }
    }
    while (this.inbox.length && !ctl.session.busy) {
      const { link, client, action } = this.inbox.shift()!;
      const p = ctl.state.players.find((x) => x.id === action.player);
      const err = !p || p.owner !== client ? 'not your player' : ctl.session.check(action);
      if (err) {
        this.send(link, { t: 'resync', state: ctl.state });
        continue;
      }
      // Relay first: applying it may emit the host's sync, which must follow the action.
      this.broadcast({ t: 'action', action, seq: ctl.session.nextSeq });
      ctl.receive(action);
    }
  }

  private lobbyMessage(): ToClient {
    return { t: 'lobby', players: this.players, setting: this.setting, hostName: this.hostName, beer: this.beer };
  }

  private lobbyChanged(): void {
    this.broadcast(this.lobbyMessage());
    this.onLobby({ players: this.players, setting: this.setting, hostName: this.hostName, beer: this.beer });
  }

  addPlayer(spec: PlayerSpec, owner = this.clientId): void {
    this.players.push({
      id: `p${this.nextId++}`,
      name: spec.name.slice(0, 18) || 'Player',
      team: spec.team,
      kind: spec.kind,
      skill: spec.skill,
      owner,
      look: this.nextId * 7 + this.players.length,
    });
    this.lobbyChanged();
  }

  removePlayer(id: string): void {
    this.players = this.players.filter((p) => p.id !== id);
    this.lobbyChanged();
  }

  setTeam(id: string, team: TeamId): void {
    const p = this.players.find((x) => x.id === id);
    if (p) p.team = team;
    this.lobbyChanged();
  }

  setBeer(on: boolean): void {
    this.beer = on;
    this.lobbyChanged();
  }

  setSetting(name: string): void {
    this.setting = name;
    this.lobbyChanged();
  }

  start(first: TeamId = Math.random() < 0.5 ? 0 : 1): GameController {
    const state = createGame(this.players, { setting: this.setting, first, beer: this.beer });
    this.ctl = new GameController(state, this.clientId, this);
    const ctl = this.ctl;
    ctl.on((e) => {
      if (e.type === 'applied') {
        const s = ctl.state;
        this.broadcast({ t: 'sync', seq: s.seq, hash: hashState(s), state: s });
        // Let the session finish emitting before starting queued work.
        queueMicrotask(() => this.ctl === ctl && this.settle());
      }
    });
    this.broadcast({ t: 'start', state });
    this.onStart(this.ctl);
    return this.ctl;
  }

  hasPendingWork(): boolean {
    return this.inbox.length > 0 || this.joiners.length > 0 || this.dropped.length > 0;
  }

  /** NetPort: our own (and our bots') actions go to everyone. */
  sendAction(a: Action, seq: number): void {
    this.broadcast({ t: 'action', action: a, seq });
  }

  sendAim(aim: AimInfo): void {
    this.broadcast({ t: 'aim', aim });
  }

  close(): void {
    for (const l of this.links.keys()) l.close();
    this.transport.close();
    this.ctl?.dispose();
  }
}

export class RoomClient implements NetPort {
  readonly isHost = false;
  ctl: GameController | null = null;
  lobby: LobbyInfo | null = null;
  onLobby: (info: LobbyInfo) => void = () => {};
  onStart: (ctl: GameController) => void = () => {};
  onClose: () => void = () => {};
  onDesync: () => void = () => {};
  private pending = new Map<number, { hash: string; state: GameState }>();

  constructor(
    private readonly link: Link,
    readonly clientId: string,
    readonly name: string,
  ) {
    link.onMessage((m) => this.handle(m as ToClient));
    link.onClose(() => this.onClose());
    this.send({ t: 'hello', client: clientId, name });
  }

  private send(m: ToHost): void {
    this.link.send(m);
  }

  private handle(m: ToClient): void {
    if (m.t === 'lobby') {
      this.lobby = { players: m.players, setting: m.setting, hostName: m.hostName, beer: m.beer };
      this.onLobby(this.lobby);
    } else if (m.t === 'start') {
      if (this.ctl) {
        this.ctl.resync(m.state);
        return;
      }
      this.ctl = new GameController(m.state, this.clientId, this);
      this.ctl.on((e) => {
        if (e.type === 'applied' || e.type === 'replaced') this.checkSync();
      });
      this.onStart(this.ctl);
    } else if (m.t === 'action') this.ctl?.receive(m.action, m.seq);
    else if (m.t === 'aim') this.ctl?.receiveAim(m.aim);
    else if (m.t === 'resync') this.ctl?.resync(m.state);
    else if (m.t === 'sync') {
      this.pending.set(m.seq, { hash: m.hash, state: m.state });
      this.checkSync();
    }
  }

  /**
   * When idle, compare with the host's newest state at or past ours: the same seq
   * must hash the same; a later seq means we missed something, so take it.
   */
  private checkSync(): void {
    const ctl = this.ctl;
    if (!ctl || ctl.session.busy) return;
    const seq = ctl.state.seq;
    let best = -1;
    for (const k of this.pending.keys()) if (k >= seq && k > best) best = k;
    for (const k of [...this.pending.keys()]) if (k <= best || k < seq) {
      if (k !== best) this.pending.delete(k);
    }
    if (best < 0) return;
    const want = this.pending.get(best)!;
    this.pending.delete(best);
    if (best > seq || hashState(ctl.state) !== want.hash) {
      this.onDesync();
      ctl.resync(want.state);
    }
  }

  addPlayer(name: string, team: TeamId): void {
    this.send({ t: 'addPlayer', name, team });
  }

  removePlayer(id: string): void {
    this.send({ t: 'removePlayer', id });
  }

  sendAction(a: Action): void {
    this.send({ t: 'action', action: a });
  }

  sendAim(aim: AimInfo): void {
    this.send({ t: 'aim', aim });
  }

  close(): void {
    this.link.close();
    this.ctl?.dispose();
  }
}

export function inviteLink(code: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = `join=${code}`;
  return url.toString();
}
