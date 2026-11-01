// The app: menus, the 3D stage, and whichever game is running (local,
// practice, or online as host or client). Wires input, view, HUD and sound to
// the game controller.

import { CFG, sceneDef } from './config.ts';
import { Sound } from './audio/audio.ts';
import { GameController, type ControllerEvent } from './game/controller.ts';
import { bacOf, drunkEffects } from './game/bac.ts';
import { DesktopInput } from './input/desktop.ts';
import { XRInput } from './input/xr.ts';
import type { PlayerSpec } from './net/protocol.ts';
import { RoomClient, RoomHost, inviteLink } from './net/room.ts';
import { broadcastTransport, peerTransport, roomCode, type Transport } from './net/transport.ts';
import { scenario, type ScenarioName } from './debug/scenarios.ts';
import { Stage } from './render/stage.ts';
import { GameView, emptyOverlay } from './render/view.ts';
import { createGame } from './sim/setup.ts';
import type { GameState, Player, TeamId } from './types.ts';
import { toast } from './ui/dom.ts';
import { Hud } from './ui/hud.ts';
import { Menu, type LobbyModel } from './ui/menu.ts';
import { loadSettings, resolveQuality, saveSettings, type Settings } from './ui/settings.ts';

type Mode = { kind: 'menu' } | { kind: 'local'; specs: PlayerSpec[]; setting: string; beer: boolean } | { kind: 'practice' } | { kind: 'host'; room: RoomHost; code: string } | { kind: 'client'; room: RoomClient; code: string };

export class App {
  readonly settings: Settings = loadSettings();
  readonly stage: Stage;
  readonly sound = new Sound();
  readonly input: DesktopInput;
  readonly xr: XRInput;
  readonly menu: Menu;
  readonly hud: Hud;
  ctl: GameController | null = null;
  view: GameView | null = null;
  /** Computer players having a game behind the menu. */
  private demo: { ctl: GameController; view: GameView } | null = null;
  mode: Mode = { kind: 'menu' };
  private clientId = Math.random().toString(36).slice(2, 10);
  private last = performance.now();
  private unsub: (() => void) | null = null;
  private transport: Transport;
  private fps = 0;
  private vignette = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'vision vignette' }));
  private glow = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'vision glow' }));
  private overTimer = 0;
  private debugEl: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.stage = new Stage(canvas, resolveQuality(this.settings));
    this.stage.setSetting(this.settings.setting);
    this.sound.volume = this.settings.volume;
    const params = new URLSearchParams(location.search);
    this.transport = params.get('net') === 'local' ? broadcastTransport() : peerTransport();

    this.input = new DesktopInput(this.stage, () => this.ctl, this.settings, {
      thrown: (speed) => this.sound.whoosh(speed),
      message: (t) => toast(t, 'bad'),
      key: (k) => this.onKey(k),
    });
    this.xr = new XRInput(this.stage, () => this.ctl, (t) => toast(t, 'bad'));
    this.menu = new Menu(ui, this.settings, {
      practice: () => this.startPractice(),
      local: (specs, setting, beer) => this.startLocal(specs, setting, beer),
      host: (name) => void this.host(name),
      join: (code, name) => void this.join(code, name),
      settingsChanged: (s) => this.applySettings(s),
    });
    this.hud = new Hud(ui, {
      menu: () => this.toMenu(),
      settings: () => this.openSettingsInGame(),
      overview: () => this.input.toggleOverview(),
      zoom: () => this.input.toggleZoom(),
      rematch: () => this.rematch(),
      drink: () => this.drink(),
      autoRaise: () => this.input.autoRaise(),
      raise: (end) => this.input.raise(end),
    });
    void XRInput.supported().then((ok) => {
      if (!ok) return;
      this.menu.enterVR = () => void this.xr.enter().catch((e) => toast(String(e), 'bad'));
      if (this.mode.kind === 'menu') this.showMain();
    });
    if (params.has('debug')) this.debugEl = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'debug' }));
    addEventListener('pointerdown', () => this.sound.unlock(), { once: false });

    const join = /join=([A-Z0-9]{5})/i.exec(location.hash);
    if (join) this.menu.showOnline(join[1]!.toUpperCase());
    else this.showMain();
    this.startDemo();
    this.stage.renderer.setAnimationLoop(() => this.frame());
    (window as unknown as Record<string, unknown>).__kubb = {
      app: this,
      CFG,
      scenario: (name: ScenarioName, setting?: string) => this.startState(scenario(name, this.clientId, setting)),
    };
  }

  private showMain(): void {
    this.menu.showMain();
  }

  private applySettings(s: Settings): void {
    saveSettings(s);
    if (this.demo && s.setting !== this.stage.setting) this.startDemo();
    this.stage.setQuality(resolveQuality(s));
    this.sound.setVolume(s.volume);
    this.view?.setPaint(s.kubbPaint);
    this.demo?.view.setPaint(s.kubbPaint);
  }

  private onKey(k: string): boolean {
    if (k === 'unlock') {
      this.sound.unlock();
      return false;
    }
    if (!this.ctl) return false;
    if (k === 'escape') {
      this.toMenu();
      return true;
    }
    if (k === 'v') {
      this.input.toggleOverview();
      return true;
    }
    if (k === 'b' && this.ctl.state.beer) {
      this.drink();
      return true;
    }
    if (k === 'm') {
      this.settings.mode = this.settings.mode === 'flick' ? 'meter' : 'flick';
      this.applySettings(this.settings);
      toast(this.settings.mode === 'flick' ? 'Flick throwing' : 'Power meter');
      return true;
    }
    if (k === 'p') {
      this.settings.preview = !this.settings.preview;
      this.applySettings(this.settings);
      toast(this.settings.preview ? 'Training wheels on' : 'Training wheels off');
      return true;
    }
    if (this.mode.kind === 'practice') {
      if (k === 't') {
        this.input.practiceKind = this.input.practiceKind === 'baton' ? 'kubb' : 'baton';
        toast(this.input.practiceKind === 'baton' ? 'Throwing batons' : 'Tossing kubbs');
        return true;
      }
      if (k === 'r') {
        this.ctl.resync(createGame(this.ctl.state.players, { practice: true, setting: this.ctl.state.setting }));
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ games

  private localPlayers(specs: PlayerSpec[]): Player[] {
    return specs.map((p, i) => ({ id: `p${i}`, name: p.name || `Player ${i + 1}`, team: p.team, kind: p.kind, skill: p.skill, owner: this.clientId, look: i * 3 + 1 }));
  }

  private startLocal(specs: PlayerSpec[], setting: string, beer = false): void {
    const first: TeamId = Math.random() < 0.5 ? 0 : 1;
    this.mode = { kind: 'local', specs, setting, beer };
    this.begin(new GameController(createGame(this.localPlayers(specs), { setting, first, beer }), this.clientId));
  }

  private drink(): void {
    const err = this.ctl?.drink();
    if (err) toast(err, 'bad');
  }

  /** Beer mode: blur, vignette, sway and a wandering aim for whoever is playing here. */
  private applyDrunkVision(): void {
    const s = this.ctl?.state;
    const me = s?.beer ? this.ctl!.localDrinker() : null;
    const bac = me ? bacOf(s!, me.id).bac : 0;
    const e = drunkEffects(bac);
    const B = CFG.beer;
    const blur = Math.max(0, (bac - (B.sweetSpot + B.sweetHalfWidth * 0.5)) * B.blurPerBac);
    this.stage.canvas.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px) saturate(${(1 + e.impairment * 0.25).toFixed(2)})` : '';
    this.vignette.style.opacity = String(Math.min(1, e.impairment * 0.6));
    this.glow.style.opacity = String(e.flow > 0.5 ? (e.flow - 0.5) * 2 : 0);
    this.stage.rig.sway = bac > 0.03 ? 0.004 + e.impairment * 0.035 : 0;
    const t = performance.now() / 1000;
    const amp = e.impairment * B.swayMeters;
    this.input.drunk = { impairment: e.impairment, flow: e.flow, sway: [Math.sin(t * 0.7) * amp, Math.sin(t * 0.53 + 1) * amp] };
  }

  private startPractice(): void {
    this.mode = { kind: 'practice' };
    const me: PlayerSpec = { name: this.settings.name || 'You', team: 0, kind: 'human', skill: 'medium' };
    this.begin(new GameController(createGame(this.localPlayers([me]), { practice: true, setting: this.settings.setting }), this.clientId));
  }

  private startDemo(): void {
    this.stopDemo();
    const bots = this.localPlayers([
      { name: 'Astrid', team: 0, kind: 'bot', skill: 'medium' },
      { name: 'Bjorn', team: 1, kind: 'bot', skill: 'medium' },
      { name: 'Freya', team: 0, kind: 'bot', skill: 'easy' },
      { name: 'Leif', team: 1, kind: 'bot', skill: 'hard' },
    ]);
    const ctl = new GameController(createGame(bots, { setting: this.settings.setting }), `demo-${this.clientId}`);
    this.stage.setSetting(this.settings.setting);
    const view = new GameView(this.stage, ctl, (e) => {
      if (e.impact.strength > 0.8) this.stage.dust.puff(e.impact.p, e.impact.strength, this.stage.env!.surface);
    }, false);
    view.setPaint(this.settings.kubbPaint);
    this.demo = { ctl, view };
  }

  private stopDemo(): void {
    this.demo?.view.dispose();
    this.demo?.ctl.dispose();
    this.demo = null;
  }

  private begin(ctl: GameController): void {
    this.stopDemo();
    this.endGame();
    this.ctl = ctl;
    this.stage.setSetting(ctl.state.setting);
    this.sound.setSurface(sceneDef(ctl.state.setting).surface);
    this.view = new GameView(this.stage, ctl, (e) => {
      this.sound.impact(e.impact);
      if (e.impact.strength > 0.8) this.stage.dust.puff(e.impact.p, e.impact.strength, this.stage.env!.surface);
      if (e.impact.strength > 0.6) this.stage.env?.bubbles?.(e.impact.p, Math.min(20, Math.ceil(e.impact.strength * 4)));
    });
    this.view.setPaint(this.settings.kubbPaint);
    this.unsub = ctl.on((e) => this.onGameEvent(e));
    this.input.reset();
    this.menu.hide();
    this.hud.show(true);
    this.hud.hideGameOver();
  }

  private onGameEvent(e: ControllerEvent): void {
    if (e.type === 'botWindup') return;
    if (e.type === 'throwStart' && !this.ctl?.isLocal(this.ctl.state.players.find((p) => p.id === e.action.player)!)) {
      const v = e.action.intent.v;
      this.sound.whoosh(Math.hypot(...v));
    }
    if (e.type === 'applied' && e.action.type === 'drink') {
      this.sound.canCrack();
      return;
    }
    if (e.type === 'replaced') {
      this.input.reset();
      if (e.state.phase !== 'over') this.hud.hideGameOver();
    }
    if (e.type !== 'applied') return;
    const s = e.state;
    for (const ev of s.events) {
      if (ev.type === 'turn') {
        this.sound.turnChime();
        this.input.reset();
      }
      if (ev.type === 'win') continue;
      if (['knocked', 'baselinePenalty', 'penaltyKubb', 'rethrow', 'stacked', 'advantage', 'turn'].includes(ev.type)) {
        toast(ev.text, ev.type === 'knocked' ? 'good' : ev.type === 'baselinePenalty' || ev.type === 'penaltyKubb' ? 'bad' : 'info');
      }
    }
    if (s.phase === 'over' && s.winner !== null) {
      const win = s.events.find((x) => x.type === 'win');
      this.sound.cheer();
      const ctl = this.ctl;
      clearTimeout(this.overTimer);
      this.overTimer = window.setTimeout(() => {
        if (this.ctl === ctl && ctl?.state.phase === 'over') this.hud.gameOver(s.winner!, win?.text ?? '', this.mode.kind !== 'client');
      }, 1200);
    }
  }

  private rematch(): void {
    if (this.mode.kind === 'local') this.startLocal(this.mode.specs, this.mode.setting, this.mode.beer);
    else if (this.mode.kind === 'host') {
      const room = this.mode.room;
      room.ctl?.dispose();
      room.ctl = null;
      room.start();
    }
  }

  private endGame(): void {
    clearTimeout(this.overTimer);
    this.unsub?.();
    this.unsub = null;
    this.view?.dispose();
    this.view = null;
    if (this.ctl && this.mode.kind !== 'host' && this.mode.kind !== 'client') this.ctl.dispose();
    this.ctl = null;
  }

  toMenu(): void {
    this.endGame();
    if (this.mode.kind === 'host' || this.mode.kind === 'client') this.mode.room.close();
    this.mode = { kind: 'menu' };
    history.replaceState(null, '', location.pathname + location.search);
    this.hud.show(false);
    this.stage.rig.mode = 'menu';
    this.stage.setSetting(this.settings.setting);
    this.showMain();
    this.startDemo();
  }

  private openSettingsInGame(): void {
    if (!this.ctl) return;
    this.ctl.paused = this.mode.kind === 'local' || this.mode.kind === 'practice';
    this.input.enabled = false;
    this.menu.showSettings(() => {
      this.menu.hide();
      this.input.enabled = true;
      if (this.ctl) this.ctl.paused = false;
    });
  }

  // ------------------------------------------------------------ online

  private async host(name: string): Promise<void> {
    const code = roomCode();
    let cancelled = false;
    this.menu.showBusy('Opening a room…', () => {
      cancelled = true;
      this.toMenu();
    });
    try {
      const t = await this.transport.host(code);
      if (cancelled) return t.close();
      const room = new RoomHost(t, this.clientId, name);
      this.mode = { kind: 'host', room, code };
      room.setSetting(this.settings.setting);
      room.addPlayer({ name, team: 0, kind: 'human', skill: 'medium' });
      const refresh = (peers = 0) => {
        if (this.mode.kind === 'host' && !room.ctl) this.menu.showLobby(this.lobbyModel(room, code, peers));
      };
      let peers = 0;
      room.onLobby = () => refresh(peers);
      room.onPeers = (n) => refresh((peers = n));
      room.onStart = (ctl) => this.begin(ctl);
      history.replaceState(null, '', `#join=${code}`);
      refresh();
    } catch (e) {
      this.menu.showError((e as Error).message);
    }
  }

  private lobbyModel(room: RoomHost | RoomClient, code: string, peers: number): LobbyModel {
    const isHost = room instanceof RoomHost;
    const info = isHost ? { players: room.players, setting: room.setting, hostName: room.hostName, beer: room.beer } : room.lobby!;
    return {
      isHost,
      code,
      link: inviteLink(code),
      myClient: this.clientId,
      players: info.players,
      setting: info.setting,
      hostName: info.hostName,
      peers,
      addMe: (name, team) => (isHost ? room.addPlayer({ name, team, kind: 'human', skill: 'medium' }) : room.addPlayer(name, team)),
      addBot: (team, skill) => isHost && room.addPlayer({ name: botNameFor(info.players.length), team, kind: 'bot', skill }),
      remove: (id) => room.removePlayer(id),
      setSetting: (n) => isHost && room.setSetting(n),
      beer: info.beer,
      setBeer: (on) => isHost && room.setBeer(on),
      start: () => isHost && room.start(),
      leave: () => this.toMenu(),
    };
  }

  private async join(code: string, name: string): Promise<void> {
    let cancelled = false;
    this.menu.showBusy(`Joining ${code}…`, () => {
      cancelled = true;
      this.toMenu();
    });
    try {
      const link = await this.transport.join(code);
      if (cancelled) return link.close();
      const room = new RoomClient(link, this.clientId, name);
      this.mode = { kind: 'client', room, code };
      let added = false;
      room.onLobby = (info) => {
        if (!added) {
          added = true;
          const counts = [0, 1].map((t) => info.players.filter((p) => p.team === t).length);
          room.addPlayer(name, counts[0]! <= counts[1]! ? 0 : 1);
        }
        if (!room.ctl) this.menu.showLobby(this.lobbyModel(room, code, 0));
      };
      room.onStart = (ctl) => this.begin(ctl);
      room.onClose = () => {
        if (this.mode.kind === 'client') {
          this.toMenu();
          toast('Disconnected from the host', 'bad', 4000);
        }
      };
      room.onDesync = () => console.warn('kubb: resynced to the host state');
    } catch (e) {
      this.menu.showError((e as Error).message);
    }
  }

  /** Called by tests and the console: start a game from a given state. */
  startState(state: GameState): void {
    this.mode = { kind: 'local', specs: [], setting: state.setting, beer: state.beer };
    this.begin(new GameController(state, this.clientId));
  }

  // ------------------------------------------------------------ loop

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;
    this.step(dt);
  }

  /** Advance everything by dt and draw. Public so the console (and agents) can drive a hidden tab. */
  step(dt: number): void {
    this.applyDrunkVision();
    if (this.demo) {
      this.demo.ctl.update(dt);
      this.demo.view.update(dt, emptyOverlay());
      if (this.demo.ctl.state.phase === 'over') this.startDemo();
    }
    if (this.ctl) {
      this.ctl.update(dt);
      this.input.update(dt);
      this.view?.update(dt, this.input.overlay);
      this.hud.update(this.ctl, this.input, this.settings);
    }
    this.xr.update();
    this.sound.update(dt);
    this.stage.update(dt);
    this.stage.render();
    if (this.debugEl) {
      const s = this.ctl?.state;
      this.debugEl.textContent = `${this.fps.toFixed(0)} fps · ${this.stage.renderer.info.render.calls} draws · ${s ? `${s.phase} seq ${s.seq}` : 'menu'}${this.ctl?.session.sim ? ` · sim step ${this.ctl.session.sim.steps}` : ''}`;
    }
  }
}

function botNameFor(i: number): string {
  const names = ['Astrid', 'Bjorn', 'Freya', 'Leif', 'Sigrid', 'Ulf', 'Ingrid', 'Erik'];
  return names[i % names.length]!;
}
