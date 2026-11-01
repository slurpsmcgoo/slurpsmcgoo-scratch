// Host and client over the in-memory transport: a whole game, with the
// client's human driven by bot logic, must end with identical states.

import { beforeAll, describe, expect, it } from 'vitest';
import { botAction } from '../src/bot/bot.ts';
import type { GameController } from '../src/game/controller.ts';
import { RoomClient, RoomHost } from '../src/net/room.ts';
import { memoryTransport } from '../src/net/transport.ts';
import { hashState } from '../src/sim/hash.ts';
import { createRng } from '../src/sim/rng.ts';
import { ready } from './helpers.ts';

beforeAll(ready);

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('network room', () => {
  it('lobby: clients add players, the host sees them', async () => {
    const net = memoryTransport();
    const host = new RoomHost(await net.host('ROOM1'), 'h', 'Hosty');
    const client = new RoomClient(await net.join('ROOM1'), 'c', 'Cleo');
    await flush();
    client.addPlayer('Cleo', 1);
    host.addPlayer({ name: 'Bot', team: 0, kind: 'bot', skill: 'easy' });
    await flush();
    expect(host.players.map((p) => `${p.name}:${p.owner}`).sort()).toEqual(['Bot:h', 'Cleo:c']);
    expect(client.lobby?.players.length).toBe(2);
  });

  it('host and client stay in sync through a whole game', async () => {
    const net = memoryTransport();
    const host = new RoomHost(await net.host('ROOM2'), 'h', 'Hosty');
    const client = new RoomClient(await net.join('ROOM2'), 'c', 'Cleo');
    let cctl: GameController | null = null;
    client.onStart = (c) => (cctl = c);
    await flush();
    host.addPlayer({ name: 'Hal', team: 0, kind: 'bot', skill: 'hard' });
    client.addPlayer('Cleo', 1);
    client.addPlayer('Cleo2', 1);
    await flush();
    const hctl = host.start(0);
    hctl.botDelays = false;
    await flush();
    expect(cctl).not.toBeNull();
    const c = cctl as unknown as GameController;
    c.session.timeScale = hctl.session.timeScale = 400;
    let desyncs = 0;
    client.onDesync = () => desyncs++;
    const rng = createRng(5);
    let n = 0;
    for (let i = 0; i < 20000 && hctl.state.phase !== 'over'; i++) {
      hctl.update(0.05);
      c.update(0.05);
      const me = c.localHuman();
      if (me) {
        const a = botAction(c.state, me.player, rng, 'x');
        const { id: _id, player: _p, ...input } = a;
        expect(c.act(input)).toBeNull();
        n++;
      }
      await flush();
    }
    for (let i = 0; i < 50; i++) {
      hctl.update(0.05);
      c.update(0.05);
      await flush();
    }
    expect(hctl.state.phase).toBe('over');
    expect(n).toBeGreaterThan(3);
    expect(hashState(c.state)).toBe(hashState(hctl.state));
    expect(desyncs).toBe(0);
  });

  it('a peer joining mid-throw ends up with the host state', async () => {
    const net = memoryTransport();
    const host = new RoomHost(await net.host('ROOM3'), 'h', 'Hosty');
    host.addPlayer({ name: 'A', team: 0, kind: 'bot', skill: 'hard' });
    host.addPlayer({ name: 'B', team: 1, kind: 'bot', skill: 'hard' });
    const hctl = host.start(0);
    hctl.botDelays = false;
    while (!hctl.session.sim) hctl.update(0.01);
    const client = new RoomClient(await net.join('ROOM3'), 'c', 'Late');
    let cctl: GameController | null = null;
    client.onStart = (c) => (cctl = c);
    for (let i = 0; i < 120; i++) {
      hctl.update(0.05);
      (cctl as GameController | null)?.update(0.05);
      await flush();
    }
    // Stop the host's bots and let the throw in flight land.
    hctl.bots = false;
    for (let i = 0; i < 400 && hctl.session.busy; i++) {
      hctl.update(0.05);
      await flush();
    }
    await flush();
    const c = cctl as unknown as GameController;
    for (let i = 0; i < 2000 && (c.session.busy || c.state.seq !== hctl.state.seq); i++) {
      c.update(0.05);
      await flush();
    }
    expect(c.state.seq).toBe(hctl.state.seq);
    expect(hashState(c.state)).toBe(hashState(hctl.state));
  });

  it('a peer leaving mid-throw keeps the throw, and a computer takes over', async () => {
    const net = memoryTransport();
    const host = new RoomHost(await net.host('ROOM4'), 'h', 'Hosty');
    const link = await net.join('ROOM4');
    const client = new RoomClient(link, 'c', 'Cleo');
    await flush();
    host.addPlayer({ name: 'Hal', team: 0, kind: 'bot', skill: 'hard' });
    client.addPlayer('Cleo', 1);
    await flush();
    const hctl = host.start(0);
    hctl.botDelays = false;
    while (!hctl.session.sim) hctl.update(0.01);
    const before = hctl.state.seq;
    let lowest = Infinity;
    let landed = false;
    hctl.on((e) => {
      if (e.type === 'applied') landed = true;
      if (landed) lowest = Math.min(lowest, hctl.state.seq);
    });
    link.close();
    await flush();
    for (let i = 0; i < 300 && !landed; i++) hctl.update(0.05);
    await flush();
    // The throw in flight counts, and nothing rolls the host back to before it.
    expect(lowest).toBe(before + 1);
    expect(hctl.state.seq).toBeGreaterThanOrEqual(before + 1);
    expect(hctl.state.players.find((p) => p.team === 1)).toMatchObject({ kind: 'bot', owner: 'h' });
  });
});
