import { describe, expect, it } from 'vitest';
import { AudienceBuilder } from '../src/world/audience.ts';
import { SimWorld } from '../src/sensors/sim.ts';
import { parseFrame, serializeFrame, type PerceptionFrame } from '../src/world/frame.ts';
import type { AudienceState } from '../src/types.ts';
import { loadConfig, seeded } from './helpers.ts';

const cfg = loadConfig();
const TICK_MS = 1000 / cfg.perception.tickHz;

/** Records `seconds` of a simulated family walking up to the window. */
function recordFamily(seconds: number, seed = 11): PerceptionFrame[] {
  const world = new SimWorld(cfg, seeded(seed));
  world.playScenario('family', 0);
  const frames: PerceptionFrame[] = [];
  for (let t = 0; t <= seconds * 1000; t += TICK_MS) frames.push(world.step(t));
  return frames;
}

function run(frames: PerceptionFrame[]): AudienceState[] {
  const b = new AudienceBuilder(cfg);
  return frames.map((f) => b.ingest(f));
}

describe('AudienceBuilder', () => {
  it('tracks a simulated family with stable IDs, zones and events', () => {
    const states = run(recordFamily(14));
    const ids = new Set(states.flatMap((s) => s.people.map((p) => p.id)));
    expect(ids.size).toBe(4); // dropouts must not create extra people
    const enters = states.flatMap((s) => s.events.filter((e) => e.type === 'enter'));
    expect(enters).toHaveLength(4);
    const last = states[states.length - 1]!;
    expect(last.people).toHaveLength(4);
    expect(last.nearest!.zone).toBe('near');
    const zoneChanges = states.flatMap((s) => s.events.filter((e) => e.type === 'zoneChange'));
    expect(zoneChanges.length).toBeGreaterThanOrEqual(4);
    // While walking in, people are approaching the window.
    const mid = states[Math.floor(states.length / 3)]!;
    expect(mid.people.every((p) => p.approachMps > 0.3)).toBe(true);
  });

  it('estimates distance close to the simulated truth', () => {
    const world = new SimWorld(cfg, seeded(5));
    const p = world.add(0.5, 4, 1.7);
    p.moving = false;
    const b = new AudienceBuilder(cfg);
    let s: AudienceState | null = null;
    for (let t = 0; t < 2000; t += TICK_MS) s = b.ingest(world.step(t));
    expect(s!.people[0]!.distanceM).toBeGreaterThan(3.7);
    expect(s!.people[0]!.distanceM).toBeLessThan(4.3);
    expect(s!.people[0]!.x).toBeCloseTo(0.5, 1);
  });

  it('a recorded walk replays identically', () => {
    const frames = recordFamily(20);
    // Round-trip through the log format, as the recorder and replay do.
    const replayed = frames.map((f) => parseFrame(serializeFrame(f))!);
    const a = run(replayed);
    const b = run(replayed.map((f) => parseFrame(serializeFrame(f))!));
    expect(b).toEqual(a);
    // And the log format keeps enough precision that tracking matches the original.
    const original = run(frames);
    expect(a.map((s) => s.people.map((p) => [p.id, p.zone]))).toEqual(original.map((s) => s.people.map((p) => [p.id, p.zone])));
  });

  it('rejects tiny and impossible detections', () => {
    const b = new AudienceBuilder(cfg);
    const tiny = Array.from({ length: 33 }, (_, i) => ({ x: 0.5, y: 0.5 + i * 0.0005, visibility: 0.9 }));
    const out = b.sanitize([{ timeMs: 0, landmarks: tiny, confidence: 0.9 }]);
    expect(out).toHaveLength(0);
  });

  it('keeps at most numPoses detections, highest confidence first', () => {
    const world = new SimWorld(cfg, seeded(9));
    for (let i = 0; i < 6; i++) world.add(0.1 + i * 0.15, 4);
    const f = world.step(0);
    f.detections.forEach((d, i) => (d.confidence = 0.5 + i * 0.05));
    const out = new AudienceBuilder(cfg).sanitize(f.detections);
    expect(out).toHaveLength(cfg.perception.numPoses);
    expect(out[0]!.confidence).toBeGreaterThan(out[out.length - 1]!.confidence);
  });

  it('emits shout and empty events', () => {
    const world = new SimWorld({ ...cfg, sim: { ...cfg.sim, dropoutRate: 0 } }, seeded(2));
    const b = new AudienceBuilder(cfg);
    const p = world.add(0.5, 3);
    for (let t = 0; t < 300; t += TICK_MS) b.ingest(world.step(t));
    world.shout(300);
    expect(b.ingest(world.step(300)).events).toContainEqual({ type: 'shout', db: cfg.sim.shoutLevelDb });
    world.remove(p.key);
    const events = [];
    for (let t = 366; t < 2000; t += TICK_MS) events.push(...b.ingest(world.step(t)).events);
    expect(events.map((e) => e.type)).toEqual(['leave', 'empty']);
  });
});
