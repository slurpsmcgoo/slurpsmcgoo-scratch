// The contract between modules. Change deliberately: sim, bot, net, render and
// ui all read these shapes, and GameState travels over the network as JSON.

export type Vec3 = [number, number, number];
/** Quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];
export type TeamId = 0 | 1;

export interface Pose {
  p: Vec3;
  q: Quat;
}

export type PieceKind = 'kubb' | 'king';

export type PieceStatus =
  | 'standing' // upright on the pitch
  | 'down' // knocked over this turn; lies where it fell until the turn ends
  | 'landed' // thrown into the field, waiting for the other team to raise it
  | 'inHand'; // off the pitch, waiting to be thrown (or placed, if it's a penalty kubb)

export interface Piece extends Pose {
  /** 'k0'..'k9' for kubbs, 'king', 'x<n>' for practice kubbs. */
  id: string;
  kind: PieceKind;
  status: PieceStatus;
  /** A baseline kubb becomes a field kubb once it has been thrown. */
  role: 'baseline' | 'field';
  /** The team defending this piece: whose baseline it is on, or whose half it stands in. */
  side: TeamId;
  /** Where a baseline kubb (or the king) is stood back up after a penalty. */
  home: Vec3;
}

export type Phase =
  | 'kubbThrow' // the turn's team throws the kubbs knocked on its side into the other half
  | 'raise' // the other team raises the landed kubbs
  | 'penalty' // the other team places kubbs that were thrown out twice
  | 'batonThrow'
  | 'over'
  | 'practice';

export type BotSkill = 'easy' | 'medium' | 'hard';

export interface Player {
  id: string;
  name: string;
  team: TeamId;
  kind: 'human' | 'bot';
  skill: BotSkill;
  /** The client that controls this player ('local' when there is no network). */
  owner: string;
  /** Avatar look index: hat, skin tone, hair. */
  look: number;
}

export type GameEventType =
  | 'knocked'
  | 'rethrow'
  | 'penaltyKubb'
  | 'baselinePenalty'
  | 'landed'
  | 'raised'
  | 'stacked'
  | 'placed'
  | 'turn'
  | 'advantage'
  | 'reraised'
  | 'win'
  | 'drink';

export interface GameEvent {
  type: GameEventType;
  text: string;
  team?: TeamId;
}

export interface GameState {
  /** Count of actions applied; the network numbers actions with it. */
  seq: number;
  practice: boolean;
  /** Where the game is played (a key of config scenes). It sets gravity and the surface, so it is part of the state. */
  setting: string;
  players: Player[];
  /** Per team, the index (into that team's players) of who throws next. */
  rotation: [number, number];
  /** The team whose turn it is: it throws kubbs, then batons. */
  turn: TeamId;
  turnNumber: number;
  phase: Phase;
  pieces: Piece[];
  /** Batons lying on the pitch this turn; they stay until the turn ends. */
  batons: Pose[];
  batonsLeft: number;
  /** Advantage line (z) for this turn's baton throws; null means the baseline. */
  throwLine: number | null;
  /** Misses so far with the kubb currently being thrown. */
  kubbAttempt: number;
  raiseQueue: string[];
  penaltyQueue: string[];
  winner: TeamId | null;
  /** What the last action did, for the HUD and sounds. */
  events: GameEvent[];
  /** Beer mode is on. */
  beer: boolean;
  /** Game minutes: advance with each throw and placement (drives the BAC model). */
  clock: number;
  /** Per player, the game minute of each can they opened. */
  drinks: Record<string, number[]>;
}

/** A throw, fully determined: every peer simulates the same thing from it. */
export interface ThrowIntent {
  kind: 'baton' | 'kubb';
  /** Which kubb is thrown (kubb throws only; absent for a practice kubb). */
  kubbId?: string;
  p: Vec3;
  q: Quat;
  /** Linear velocity, m/s. */
  v: Vec3;
  /** Angular velocity, rad/s. */
  w: Vec3;
}

interface ActionBase {
  /** Unique per action: '<clientId>:<counter>'. */
  id: string;
  /** The player acting. */
  player: string;
}

export type Action =
  | (ActionBase & { type: 'throw'; intent: ThrowIntent })
  | (ActionBase & { type: 'raise'; kubbId: string; end: 0 | 1 })
  | (ActionBase & { type: 'placePenalty'; kubbId: string; x: number; z: number })
  /** Beer mode: crack open a can. Any player may, at any time, as often as they like. */
  | (ActionBase & { type: 'drink' });

/** Where everything ended up after a throw settled. */
export interface SettledResult {
  pieces: Record<string, Pose>;
  /** Batons already lying, in the same order as GameState.batons. */
  batons: Pose[];
  /** The thrown object. */
  thrown: Pose;
  steps: number;
}

/** A hard contact during a throw, for sound. */
export interface Impact {
  p: Vec3;
  /** Change of speed, m/s. */
  strength: number;
  surface: 'wood' | 'grass';
}
