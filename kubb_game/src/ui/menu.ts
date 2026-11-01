// Menus: main, local game setup, online host/join, lobby, settings.

import { CFG, SCENES, SCENE_NAMES } from '../config.ts';
import type { PlayerSpec } from '../net/protocol.ts';
import type { BotSkill, Player, TeamId } from '../types.ts';
import { clear, h } from './dom.ts';
import type { Settings } from './settings.ts';

export interface MenuActions {
  practice(): void;
  local(players: PlayerSpec[], setting: string, beer: boolean): void;
  host(name: string): void;
  join(code: string, name: string): void;
  settingsChanged(s: Settings): void;
}

export interface LobbyModel {
  isHost: boolean;
  code: string;
  link: string;
  myClient: string;
  players: Player[];
  setting: string;
  hostName: string;
  peers: number;
  addMe(name: string, team: TeamId): void;
  addBot(team: TeamId, skill: BotSkill): void;
  remove(id: string): void;
  setSetting(name: string): void;
  beer: boolean;
  setBeer(on: boolean): void;
  start(): void;
  leave(): void;
}

const SKILLS: BotSkill[] = ['easy', 'medium', 'hard'];

function teamName(t: TeamId) {
  return CFG.teams[t]!.name;
}

function settingSelect(value: string, onchange: (v: string) => void, disabled = false): HTMLSelectElement {
  const sel = h('select', { disabled, onchange: () => onchange(sel.value) }, ...SCENE_NAMES.map((n) => h('option', { value: n, selected: n === value }, SCENES[n]!.label)));
  return sel;
}

export class Menu {
  readonly root: HTMLElement;
  private local: PlayerSpec[] = [];
  /** Set when the browser can do immersive VR. */
  enterVR: (() => void) | null = null;

  constructor(
    host: HTMLElement,
    private readonly settings: Settings,
    private readonly act: MenuActions,
  ) {
    this.root = h('div', { class: 'menu' });
    host.append(this.root);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private show(...cards: HTMLElement[]): void {
    this.root.classList.remove('hidden');
    clear(this.root);
    this.root.append(...cards);
  }

  private nameField(): HTMLInputElement {
    return h('input', {
      type: 'text',
      maxLength: 18,
      placeholder: 'Your name',
      value: this.settings.name,
      oninput: (e: Event) => {
        this.settings.name = (e.target as HTMLInputElement).value;
        this.act.settingsChanged(this.settings);
      },
    });
  }

  showMain(): void {
    this.show(
      h(
        'div',
        { class: 'card main' },
        h('h1', {}, 'KUBB'),
        h('p', { class: 'sub' }, 'The Viking lawn game. Topple the kubbs, then the king.'),
        h('button', { class: 'primary', onclick: () => this.showLocalSetup() }, 'Play'),
        h('button', { onclick: () => this.showOnline() }, 'Play online'),
        h('button', { onclick: () => this.act.practice() }, 'Practice'),
        h('button', { class: 'ghost', onclick: () => this.showSettings() }, 'Settings'),
        this.enterVR ? h('button', { class: 'ghost', onclick: () => this.enterVR?.() }, 'Enter VR (experimental)') : null,
        h('p', { class: 'fine' }, 'Mouse, trackpad or touch. Point to aim · press, pull back, flick forward to throw.'),
      ),
    );
  }

  showLocalSetup(): void {
    if (!this.local.length) {
      this.local = [
        { name: this.settings.name || 'You', team: 0, kind: 'human', skill: 'medium' },
        { name: 'Astrid', team: 1, kind: 'bot', skill: 'medium' },
      ];
    }
    let setting = this.settings.setting;
    const render = () => {
      const columns = ([0, 1] as TeamId[]).map((t) =>
        h(
          'div',
          { class: `team team${t}` },
          h('h3', {}, teamName(t)),
          ...this.local
            .map((p, i) => [p, i] as const)
            .filter(([p]) => p.team === t)
            .map(([p, i]) =>
              h(
                'div',
                { class: 'row' },
                h('input', { type: 'text', value: p.name, maxLength: 18, oninput: (e: Event) => (p.name = (e.target as HTMLInputElement).value) }),
                h(
                  'select',
                  {
                    onchange: (e: Event) => {
                      const v = (e.target as HTMLSelectElement).value;
                      if (v === 'human') p.kind = 'human';
                      else {
                        p.kind = 'bot';
                        p.skill = v as BotSkill;
                      }
                    },
                  },
                  h('option', { value: 'human', selected: p.kind === 'human' }, 'Human'),
                  ...SKILLS.map((s) => h('option', { value: s, selected: p.kind === 'bot' && p.skill === s }, `CPU ${s}`)),
                ),
                h('button', { class: 'icon', title: 'Remove', onclick: () => (this.local.splice(i, 1), render()) }, '×'),
              ),
            ),
          h(
            'div',
            { class: 'row add' },
            h('button', { class: 'small', onclick: () => (this.local.push({ name: `Player ${this.local.length + 1}`, team: t, kind: 'human', skill: 'medium' }), render()) }, '+ Human'),
            h('button', { class: 'small', onclick: () => (this.local.push({ name: botName(this.local.length), team: t, kind: 'bot', skill: 'medium' }), render()) }, '+ Computer'),
          ),
        ),
      );
      const ok = ([0, 1] as TeamId[]).every((t) => this.local.some((p) => p.team === t));
      this.show(
        h(
          'div',
          { class: 'card wide' },
          h('h2', {}, 'New game'),
          h('p', { class: 'sub' }, 'Teams take turns; throws rotate through each team. Humans share this computer.'),
          h('div', { class: 'teams' }, ...columns),
          h('label', { class: 'field' }, 'Where ', settingSelect(setting, (v) => (setting = v))),
          beerToggle(this.settings.beer, (v) => {
            this.settings.beer = v;
            this.act.settingsChanged(this.settings);
          }),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'ghost', onclick: () => this.showMain() }, 'Back'),
            h(
              'button',
              {
                class: 'primary',
                disabled: !ok,
                onclick: () => {
                  this.settings.setting = setting;
                  this.act.settingsChanged(this.settings);
                  this.act.local(this.local, setting, this.settings.beer);
                },
              },
              'Start',
            ),
          ),
        ),
      );
    };
    render();
  }

  showOnline(code = ''): void {
    const name = this.nameField();
    const codeIn = h('input', { type: 'text', maxLength: 5, placeholder: 'CODE', value: code, class: 'code' });
    const err = h('p', { class: 'error' });
    const need = () => {
      if (!name.value.trim()) {
        err.textContent = 'Enter your name first';
        return false;
      }
      return true;
    };
    this.show(
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Play online'),
        h('p', { class: 'sub' }, 'Host a game and send the link, or join with a code. Games go directly between browsers.'),
        h('label', { class: 'field' }, 'Name ', name),
        h('button', { class: 'primary', onclick: () => need() && this.act.host(name.value.trim()) }, 'Host a game'),
        h('div', { class: 'or' }, 'or'),
        h('div', { class: 'row' }, codeIn, h('button', { onclick: () => need() && codeIn.value.trim() && this.act.join(codeIn.value.trim().toUpperCase(), name.value.trim()) }, 'Join')),
        err,
        h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => this.showMain() }, 'Back')),
      ),
    );
    if (code) name.focus();
  }

  showBusy(text: string, onCancel: () => void): void {
    this.show(h('div', { class: 'card' }, h('p', {}, text), h('div', { class: 'spinner' }), h('button', { class: 'ghost', onclick: onCancel }, 'Cancel')));
  }

  showError(text: string): void {
    this.show(h('div', { class: 'card' }, h('h2', {}, 'Hmm'), h('p', {}, text), h('button', { class: 'primary', onclick: () => this.showMain() }, 'OK')));
  }

  showLobby(m: LobbyModel): void {
    const mine = m.players.filter((p) => p.owner === m.myClient);
    const columns = ([0, 1] as TeamId[]).map((t) =>
      h(
        'div',
        { class: `team team${t}` },
        h('h3', {}, teamName(t)),
        ...m.players
          .filter((p) => p.team === t)
          .map((p) =>
            h(
              'div',
              { class: 'row player' },
              h('span', { class: 'pname' }, p.name, p.kind === 'bot' ? ` · CPU ${p.skill}` : p.owner === m.myClient ? ' (you)' : ''),
              m.isHost || p.owner === m.myClient ? h('button', { class: 'icon', onclick: () => m.remove(p.id) }, '×') : null,
            ),
          ),
        h(
          'div',
          { class: 'row add' },
          h('button', { class: 'small', onclick: () => m.addMe(this.settings.name || 'Player', t) }, mine.length ? '+ Another here' : '+ Me'),
          m.isHost ? h('button', { class: 'small', onclick: () => m.addBot(t, 'medium') }, '+ Computer') : null,
        ),
      ),
    );
    const ok = ([0, 1] as TeamId[]).every((t) => m.players.some((p) => p.team === t));
    const linkBox = h('input', { type: 'text', readOnly: true, value: m.link, class: 'link' });
    this.show(
      h(
        'div',
        { class: 'card wide' },
        h('h2', {}, m.isHost ? `Room ${m.code}` : `${m.hostName}'s room · ${m.code}`),
        m.isHost
          ? h(
              'div',
              { class: 'row' },
              linkBox,
              h(
                'button',
                {
                  onclick: (e: Event) => {
                    void navigator.clipboard?.writeText(m.link);
                    (e.target as HTMLButtonElement).textContent = 'Copied';
                  },
                },
                'Copy link',
              ),
            )
          : null,
        h('p', { class: 'sub' }, m.isHost ? `${m.peers} other ${m.peers === 1 ? 'browser' : 'browsers'} connected. Send the link to friends.` : 'Waiting for the host to start.'),
        h('div', { class: 'teams' }, ...columns),
        h('label', { class: 'field' }, 'Where ', settingSelect(m.setting, (v) => m.setSetting(v), !m.isHost)),
        beerToggle(m.beer, (v) => m.setBeer(v), !m.isHost),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'ghost', onclick: () => m.leave() }, 'Leave'),
          m.isHost ? h('button', { class: 'primary', disabled: !ok, onclick: () => m.start() }, 'Start') : null,
        ),
      ),
    );
  }

  showSettings(back: () => void = () => this.showMain()): void {
    const s = this.settings;
    const save = () => this.act.settingsChanged(s);
    const sel = <T extends string>(value: T, opts: [T, string][], set: (v: T) => void) =>
      h('select', { onchange: (e: Event) => (set((e.target as HTMLSelectElement).value as T), save()) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    this.show(
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Settings'),
        h('label', { class: 'field' }, 'Name ', this.nameField()),
        h(
          'label',
          { class: 'field' },
          'Throwing ',
          sel(s.mode, [['flick', 'Flick (pull back, push forward)'], ['meter', 'Power meter (hold, release)']], (v) => (s.mode = v)),
        ),
        h(
          'label',
          { class: 'field' },
          'Spin ',
          sel(s.spinControl, [['pull', 'From how far you pull back'], ['keys', 'Q / E keys']], (v) => (s.spinControl = v)),
        ),
        h(
          'label',
          { class: 'field check' },
          h('input', { type: 'checkbox', checked: s.preview, onchange: (e: Event) => ((s.preview = (e.target as HTMLInputElement).checked), save()) }),
          ' Show the throw arc and target power (training wheels)',
        ),
        h(
          'label',
          { class: 'field' },
          'Kubbs ',
          sel(s.kubbPaint, [['wood', 'Natural wood'], ['sets', 'Blue set and white set'], ['twoTone', 'Half blue, half white']], (v) => (s.kubbPaint = v)),
        ),
        h(
          'label',
          { class: 'field' },
          'Graphics ',
          sel(s.quality, [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], (v) => (s.quality = v)),
        ),
        h(
          'label',
          { class: 'field' },
          'Volume ',
          h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.volume, oninput: (e: Event) => ((s.volume = Number((e.target as HTMLInputElement).value)), save()) }),
        ),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: back }, 'Done')),
      ),
    );
  }
}

function beerToggle(on: boolean, set: (v: boolean) => void, disabled = false): HTMLElement {
  return h(
    'label',
    { class: 'field check' },
    h('input', { type: 'checkbox', checked: on, disabled, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }),
    ' Beer mode: everyone drinks as the game goes on (B to crack one). A little buzz sharpens your throw; too much and the world wobbles. Simulated, for fun.',
  );
}

function botName(i: number): string {
  const names = ['Astrid', 'Bjorn', 'Freya', 'Leif', 'Sigrid', 'Ulf', 'Ingrid', 'Erik', 'Solveig', 'Gunnar'];
  return names[i % names.length]!;
}
