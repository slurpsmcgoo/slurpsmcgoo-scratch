// In-game HUD: score, whose turn and what to do, power and arc, buttons.

import { CFG } from '../config.ts';
import type { GameController } from '../game/controller.ts';
import { bacOf, drunkEffects, drunkLabel } from '../game/bac.ts';
import type { DesktopInput } from '../input/desktop.ts';
import { batonsForTurn } from '../sim/setup.ts';
import { kubbsToThrow, standingCounts } from '../sim/rules.ts';
import type { TeamId } from '../types.ts';
import { h } from './dom.ts';
import type { Settings } from './settings.ts';

export interface HudActions {
  menu(): void;
  settings(): void;
  overview(): void;
  zoom(): void;
  rematch(): void;
  drink(): void;
  autoRaise(): void;
  raise(end: 0 | 1): void;
}

export class Hud {
  readonly root: HTMLElement;
  private score: HTMLElement[];
  private status: HTMLElement;
  private hint: HTMLElement;
  private power: HTMLElement;
  private powerFill: HTMLElement;
  private powerTick: HTMLElement;
  private loft: HTMLElement;
  private raiseBar: HTMLElement;
  private over: HTMLElement;
  private last = '';
  private beer: HTMLElement;
  private beerFill: HTMLElement;
  private beerText: HTMLElement;
  private beerKey = '';

  constructor(host: HTMLElement, private readonly act: HudActions) {
    this.score = [0, 1].map((t) => h('div', { class: `score team${t}` }));
    this.status = h('div', { class: 'status' });
    this.hint = h('div', { class: 'hint' });
    this.powerFill = h('div', { class: 'fill' });
    this.powerTick = h('div', { class: 'tick' });
    this.loft = h('div', { class: 'loft' });
    this.power = h('div', { class: 'power' }, h('div', { class: 'bar' }, this.powerFill, this.powerTick), this.loft);
    this.raiseBar = h(
      'div',
      { class: 'raisebar' },
      h('button', { onclick: () => act.raise(0) }, 'End 1'),
      h('button', { onclick: () => act.raise(1) }, 'End 2'),
      h('button', { onclick: () => act.autoRaise() }, 'Auto-raise all'),
    );
    this.over = h('div', { class: 'gameover hidden' });
    this.beerFill = h('div', { class: 'fill' });
    this.beerText = h('div', { class: 'btext' });
    const B = CFG.beer;
    const zone = h('div', { class: 'zone', style: `left:${((B.sweetSpot - B.sweetHalfWidth) / 0.2) * 100}%;width:${((B.sweetHalfWidth * 2) / 0.2) * 100}%` });
    this.beer = h(
      'div',
      { class: 'beer hidden' },
      h('button', { onclick: () => act.drink() }, '🍺 Drink (B)'),
      h('div', { class: 'bmeter' }, h('div', { class: 'bbar' }, zone, this.beerFill), this.beerText),
    );
    this.root = h(
      'div',
      { class: 'hud hidden' },
      h('div', { class: 'top' }, this.score[0], this.status, this.score[1]),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'icon', title: 'Zoom (hold right button or Z)', onclick: () => act.zoom() }, '🔍'),
        h('button', { class: 'icon', title: 'Whole pitch (V)', onclick: () => act.overview() }, '👁'),
        h('button', { class: 'icon', title: 'Settings', onclick: () => act.settings() }, '⚙'),
        h('button', { class: 'icon', title: 'Menu (Esc)', onclick: () => act.menu() }, '☰'),
      ),
      this.power,
      this.raiseBar,
      this.beer,
      this.hint,
      this.over,
    );
    host.append(this.root);
  }

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    if (!v) this.over.classList.add('hidden');
  }

  update(ctl: GameController, input: DesktopInput, settings: Settings): void {
    const s = ctl.state;
    const actor = ctl.actor();
    const local = ctl.localHuman();
    const counts = standingCounts(s);
    for (const t of [0, 1] as TeamId[]) {
      const team = CFG.teams[t]!;
      const turn = s.turn === t && !s.practice ? ' turn' : '';
      const text = `${team.name}|${counts.baseline[t]}|${counts.field[t]}|${turn}`;
      if (this.score[t]!.dataset.v !== text) {
        this.score[t]!.dataset.v = text;
        this.score[t]!.className = `score team${t}${turn}`;
        this.score[t]!.replaceChildren(
          h('b', {}, team.name),
          h('span', { title: 'Baseline kubbs standing' }, `${counts.baseline[t]} baseline`),
          h('span', { title: 'Field kubbs standing in this half' }, `${counts.field[t]} field`),
        );
      }
    }
    if (s.practice) this.score.forEach((e) => (e.style.visibility = 'hidden'));
    else this.score.forEach((e) => (e.style.visibility = ''));

    let status = '';
    let hint = '';
    if (ctl.session.sim) status = 'Watch it fly…';
    else if (s.phase === 'over') status = `${CFG.teams[s.winner!]!.name} wins!`;
    else if (actor) {
      const who = s.practice ? 'Practice' : actor.player.name;
      const team = CFG.teams[actor.team]!.name;
      if (actor.act === 'throwBaton') {
        const total = batonsForTurn(s.turnNumber);
        status = `${who} (${team}) · baton ${total - s.batonsLeft + 1} of ${total}`;
      } else if (actor.act === 'throwKubb') status = `${who} (${team}) · throw kubbs into the other half (${kubbsToThrow(s).length} left)`;
      else if (actor.act === 'raise') status = `${who} (${team}) · raise the thrown kubbs`;
      else if (actor.act === 'penalty') status = `${who} (${team}) · place the penalty kubb`;
      else status = `Practice · ${input.practiceKind === 'baton' ? 'batons' : 'kubb tosses'} · ${s.batonsLeft} batons left`;
      if (actor.player.kind === 'bot') status += ' · thinking';
      else if (!local) status += ' · their turn';
    }
    if (local) {
      const flick = settings.mode === 'flick';
      const touch = matchMedia('(pointer: coarse)').matches;
      if (local.act === 'raise') hint = 'Click the ghost kubb to raise it on that end (1 / 2) · A: auto-raise all';
      else if (local.act === 'penalty') hint = 'Click where the penalty kubb goes: in your half, a baton length from the king and stakes';
      else {
        hint = touch
          ? flick
            ? 'Tap to aim · drag down then flick up to throw · 🔍 zoom · 👁 whole pitch'
            : 'Tap to aim · hold and release at the power you want · 🔍 zoom'
          : flick
          ? `Point to aim · press, pull back and flick forward to throw: faster goes long, slower short, drift left/right (${settings.spinControl === 'pull' ? 'pull back further for more spin' : 'Q/E: spin'}) · hold right button or Z to zoom · W/S or wheel: arc · A/D: step along the line · V: view`
          : 'Point to aim · hold and release at the power you want (or Space) · Q/E: spin · W/S or wheel: arc · V: view';
        if (s.practice) hint += ' · T: batons/kubbs · R: reset';
      }
    }
    const key = `${status}|${hint}`;
    if (key !== this.last) {
      this.last = key;
      this.status.textContent = status;
      this.hint.textContent = hint;
      this.hint.classList.toggle('hidden', !hint);
    }

    this.power.classList.toggle('hidden', !input.powerVisible);
    if (input.powerVisible) {
      this.powerFill.style.height = `${Math.round(input.power * 100)}%`;
      this.powerTick.style.bottom = `${Math.round(input.targetPower * 100)}%`;
      this.powerTick.classList.toggle('hidden', false);
      const kind = input.overlay.holding ?? 'baton';
      const spin = input.spin < 0 ? 'from pull-back' : `×${input.spin.toFixed(1)}`;
      this.loft.textContent = `Arc ${input.loft[kind]}° · Spin ${spin}`;
    }
    this.raiseBar.classList.toggle('hidden', local?.act !== 'raise');

    const drinker = s.beer ? ctl.localDrinker() : null;
    this.beer.classList.toggle('hidden', !drinker);
    if (drinker) {
      const b = bacOf(s, drinker.id);
      const trend = b.pending > 0.004 ? ' ↑' : b.trend < 0 ? ' ↓' : '';
      const key = `${drinker.id}|${b.bac.toFixed(3)}|${trend}|${b.cans}`;
      if (key !== this.beerKey) {
        this.beerKey = key;
        this.beerFill.style.width = `${Math.min(100, (b.bac / 0.2) * 100)}%`;
        this.beerText.textContent = `${drinker.name}: ${b.bac.toFixed(3)}%${trend} · ${drunkLabel(b.bac)} · ${b.cans} ${b.cans === 1 ? 'can' : 'cans'}`;
        this.beer.classList.toggle('inzone', drunkEffects(b.bac).flow > 0.5);
      }
    }
  }

  gameOver(winner: TeamId, reason: string, canRematch: boolean): void {
    const team = CFG.teams[winner]!;
    this.over.replaceChildren(
      h('div', { class: 'card' }, h('h2', { style: `color:${team.color}` }, `${team.name} wins`), h('p', {}, reason),
        h('div', { class: 'actions' },
          h('button', { class: 'ghost', onclick: () => this.act.menu() }, 'Menu'),
          canRematch ? h('button', { class: 'primary', onclick: () => this.act.rematch() }, 'Play again') : null)),
    );
    this.over.classList.remove('hidden');
  }

  hideGameOver(): void {
    this.over.classList.add('hidden');
  }
}
