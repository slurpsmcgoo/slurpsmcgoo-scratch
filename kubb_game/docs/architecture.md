# Kubb — architecture

A browser game of kubb: physics-based, multiplayer, teams with rotating throwers, computer opponents, a practice mode, and (untested, low priority) WebXR. Laptops and desktops first; iPads work through the same pointer input. Three settings so far: a summer park, the Moon with lunar gravity and dust, and the ocean floor with water drag. An optional beer mode adds a blood-alcohol model that affects throwing.

## Goals, in priority order

1. **Throwing, aiming and placing feel good.** Real sizes and masses, batons that tumble end over end, kubbs that fall the way wood falls on grass.
2. **Easy to share.** The game is a static site on GitHub Pages. You send a link with a room code; friends open it. No accounts, no server of our own.
3. **Looks good with no art pipeline.** Every mesh, texture and sound is generated in code, so agents can build and change all of it, and nothing has a licence to track.
4. **Agents can verify their own work.** The game logic and the physics run headless in Node, deterministically, so whole games can be played in tests.

## Shape

```
input/ (mouse, trackpad, touch, XR)   bot/ (computer players)
              │                              │
              └──────► Action ◄──────────────┘          Action = throw(ThrowIntent) | raise | placePenalty
                         │
            net/ (room host relays to peers; local play skips it)
                         │
                         ▼
     game/session ── sim/rules (pure state machine) ──► GameState
           │
           └── sim/physics (ThrowSim: Rapier world built from GameState + ThrowIntent)
                         │ poses, impacts
                         ▼
     render/ (Three.js)  audio/ (Web Audio)  ui/ (DOM)          read-only views of the session
```

### The contract: `src/types.ts`

`GameState`, `Piece`, `ThrowIntent`, `Action`, `Player`, `SettledResult`. Modules talk only through these types (network messages are in `src/net/protocol.ts`). Change them deliberately.

### Simulation: `src/sim/`

- **`rules.ts`** is a pure reducer: `applyThrowResult(state, intent, settledPoses)` and `applyPlace(state, action)`. It knows the rules and nothing about Three.js, the DOM or the network.
- **`physics.ts`** has `ThrowSim`: it builds a fresh Rapier world from the state (pieces, lying batons), adds the thrown object with the intent's pose and velocities, and steps at a fixed 120 Hz until everything settles. Building fresh each throw makes a throw a pure function of `(state, intent)`. Resting pieces are created awake (created asleep, Rapier wakes them before their ground contacts exist and they get shoved sideways). Bodies touching the ground get a constant rolling-resistance deceleration on top of damping, because damping alone never stops a rolling cylinder.
- Rapier's **deterministic build** gives bit-identical results on every platform, as long as our own per-step code is plain arithmetic. So the sim never calls `Math.random`, `Date.now`, `performance.now` or the transcendental `Math` functions (`sin`, `cos`, `exp`, `pow`, `atan2`, …), whose results may differ between browsers. Throw construction uses them, but on the thrower's side, before the intent is rounded and sent.

### Settings and their physics

A setting (`config/kubb.json` → `scenes`) is both a look and a physics override: the park uses the base numbers; the Moon sets gravity to 1.62 m/s², removes air drag, and makes the surface soft regolith (high friction, almost no bounce, more rolling resistance). `GameState.setting` carries it, so every peer simulates the same world. Throw input is scaled by the speed a reference 8 m throw needs in each setting, so the same flick reaches about as far everywhere.

The ocean floor folds buoyancy into a lower gravity (4.5 m/s², as if the pieces were weighted wood) and adds quadratic water drag (`dv = −k|v|v dt`), applied by the sim each step; the throw maths integrates the same drag, so aiming stays honest. Throws need a little more push and drop steeply at the end.

The Moon's ground also **deforms** (`physics.deformable`, `src/sim/terrain.ts`). Over the 14 m × 20 m playing area the ground is a 5 cm height grid. Every hard ground hit in the sim records a dent in integers: where it hit, the piece's velocity just before, and its mass. The dent digs a bowl with a raised rim, stretched along the direction of travel (a shallow skid leaves a long scrape, a steep drop a round pit) with more rim thrown out ahead. Dents add up, so hitting the same spot deepens and widens the hole. After each dent the regolith slumps until no slope is steeper than `terrain.maxSlope` (16°, so a kubb can always stand), and the depth is floored at 8 cm. `GameState.dents` lists every dent in order, and the grid is a pure function of that list, so every peer has the same ground; consecutive throws only apply the new dents (a cache checked entry by entry). `ThrowSim` collides with it as a Rapier heightfield sampled every 10 cm, ringed by flat cuboids. Finer would cost more than it adds: box-on-heightfield contacts are several times dearer than box-on-cuboid. Dents are dug mid-throw and the heightfield is rebuilt on the next step, so pieces nearby drop into a fresh crater. Hits are classified as ground from the piece's lowest point against the terrain, because a fast body's hit is resolved by continuous collision detection, which can leave no contact to inspect. The rules stand raised, re-raised and penalty kubbs on the highest ground under their footprint.

All settings have a soft-ground landing loss: a piece coming down onto the ground keeps only part of its forward and spin speed (`landingKeep`), so thrown kubbs roll about half a metre, not two.

### Rules implemented (US national / world championship style)

5 m × 8 m pitch, 5 baseline kubbs a side, king in the middle, 6 batons (2 then 4 on the opening turns). On a turn the team throws the kubbs knocked down on its side into the other half (one rethrow; two misses make a penalty kubb the other team places anywhere in its half, a baton length from the king and stakes), the other team raises them (choosing which end stays down; touching kubbs are stacked), then the team throws batons. Field kubbs must fall before baseline kubbs, or the baseline kubb is stood back up. Field kubbs left standing give the other team an advantage line to throw batons from. Knocking the king after all the other side's kubbs are down wins, from the baseline; knocking it earlier loses. Variants are switches in `config/kubb.json`.

Teams hold any number of players, human or computer, and throws rotate through the team.

### Throwing

Every throw, from any input, becomes a `ThrowIntent`: release position, orientation, linear and angular velocity, all rounded to fixed precision. `src/throw/model.ts` builds one from `(from, direction, loft, speed, spin)`, solves the speed needed to reach a target, and draws the preview arc. Inputs:

- **Flick (default, mouse or trackpad or touch):** move to put the aim reticle on the ground (tap, on touch). A ring around it shows where the throw can land (`throw/dispersion.ts`); its radius grows with distance. Press, pull back, push forward and release: forward speed at release (least-squares over the last 70 ms), compared with a comfortable middle speed, puts the throw long or short within the ring, and sideways drift puts it left or right. The input then solves the speed and direction for that point. Getting close is easy; getting it exact is the skill. W/S or the wheel set the arc. Holding the right button or Z zooms in on the reticle. Spin is a multiplier on the usual end-over-end rate (0.3× to 2.2×): by default it comes from how far you pulled back before flicking, or from Q/E if chosen in Settings.
- **Power meter (fallback):** press and hold, release when the oscillating meter is where you want it.
- **XR:** grab with the trigger, throw with your arm. The release velocity comes from the last ~80 ms of controller tracking, times an assist factor. Untested: no headset yet.

Placing uses the same pointer ray: click one of two ghost kubbs to raise a kubb on that end, or move a ghost and click to place a penalty kubb (red where not allowed).

### Multiplayer: replay each throw by its intent

Kubb is turn-based, so only one player acts at a time. That makes the network simple:

1. **Transport:** WebRTC data channels through PeerJS. The host's browser registers `kubbgame-<ROOM>` with PeerJS's free public signalling server; players open `…/#join=ROOM` and connect peer to peer. No server of ours. (A `BroadcastChannel` transport connects tabs of one browser, for development and tests, and an in-memory transport runs in unit tests.)
2. **The host is the authority.** It owns the roster, runs the computer players, and relays every action to everyone in one order.
3. **The acting player applies their own action at once** (no input lag) and sends it to the host. The host relays it only if it's legal for the host's state (that player's turn, from that player's own browser); otherwise it sends the sender its state to take instead.
4. **Every peer runs the same deterministic `ThrowSim`** from the intent. After every action the host sends its state's sequence number, hash and full state. An idle peer at the same number checks the hash; a peer that is behind takes the state.
5. **Work that would break a throw in flight waits for it to land**: welcoming a late joiner (they get the state after the throw), handing a departed player to the computer, and relaying queued actions. Host bots wait until that work is done.
6. Cosmetic data (where a player aims, how far back they've pulled) goes separately at about 10 Hz and never touches the sim.

### Rendering: `src/render/`

Three.js, PBR materials, `ACESFilmic` tone mapping, soft sun shadows. Wood, bark, lawn, regolith and Earth textures are drawn on canvases at start-up.

- **Park:** Three's physical sky model, also prefiltered into the environment lighting; a lawn with large-scale patchiness and mowing stripes (shader); instanced grass blades swaying in a vertex shader; trees built from displaced spheres.
- **Moon:** black sky with stars, the sun's disc, the Earth (lit by the same sun, with an atmosphere rim); cratered regolith terrain that is flat where the game is played; rocks; a lunar module in the distance. Ground impacts throw up a big plume of regolith, an ejecta cone plus a dense core, flying in clean ballistic arcs with no air to slow it, then settling where it lands. Hard hits dig real craters (see *Settings and their physics*). `render/impacts.ts` draws the same terrain grid at full 5 cm resolution, darker in the bowls and brighter on the rims. It applies each dent the moment the impact event arrives, then reconciles with `GameState.dents` after every action, so a late joiner or a resync draws exactly the ground everyone else plays on. The pitch's chalk lines are still flat and float over a crater.

A computer-vs-computer game plays behind the menu.

Players are stylised toy figures: rounded body, head with simple face and hat, and floating hands (no arms, so no arm IK). Each player gets a team-coloured shirt and a hat and skin tone from their index. On the Moon they wear spacesuits with gold visors and a team-coloured band.

Quality tiers (low, medium, high) set pixel ratio, shadow map size and grass density. iPads and phones start on low.

### Audio: `src/audio/`

Synthesised with Web Audio: wood-on-wood clacks (modal sine partials plus a noise burst), thuds on grass, the whoosh of a throw, birds and wind for the park. On the Moon there's no air, so only muffled thumps (as if felt through your boots), suit breathing, and Quindar radio tones at the turn change. Impacts come from sudden velocity changes in the sim (the whole vector beyond gravity, so glancing bounces count), labelled wood or ground from what the piece is touching in Rapier's contact graph.

### Beer mode: `src/game/bac.ts`

The state carries `beer`, a game `clock` (minutes that advance one per throw and 0.4 per placement) and each player's `drinks` (the minute each can was opened). A `drink` action is legal for any player at any time, as often as they like (computer players pace themselves). BAC is computed from those on every peer the same way: each can enters the stomach, is absorbed first-order (about 10 minutes' half-life), and the body clears 0.015 % an hour. The lag is what makes the sweet spot (around 0.07 %) easy to overshoot.

Effects, on the thrower's side only: in the zone the dispersion ring shrinks and the throw drifts towards its middle; past it, the ring grows, the aim point wanders and the release gets a random shake. The local player also sees blur, a vignette and a swaying camera; avatars sway, sip and toss empty cans around the cooler. Bots drink towards a target BAC that depends on skill (easy bots overdo it), and their aim noise follows the same curve.

### Computer players: `src/bot/`

A bot picks a target (the nearest standing field kubb, then a baseline kubb, then the king), solves the throw for it, and adds aim and power noise by difficulty (easy, medium, hard). Kubb throws aim just over the centre line, near earlier kubbs, so they stack. Bots raise kubbs on the end towards their own baseline, and place penalty kubbs in the far corners.

## Layout

```
config/kubb.json   every tunable number: pitch, masses, friction, damping, throw input, bot noise, quality, scene presets
src/types.ts       the contract
src/sim/           rules, physics, pitch geometry, setup, hash, seeded RNG     (no three, no DOM)
src/throw/         throw model (intent from parameters, ballistic solve, preview), flick estimator
src/bot/           computer players
src/game/          session (state + live ThrowSim + action queue), controller (who acts next)
src/net/           protocol, transports (PeerJS, BroadcastChannel, memory), room host/client
src/input/         desktop/touch pointer input, XR input
src/render/        renderer, environment, procedural textures, pieces, avatars, camera rig, overlays
src/audio/         synthesised sound
src/ui/            menu, lobby, HUD, settings (DOM + CSS)
src/debug/         scenarios for browser checks (__kubb.scenario)
src/app.ts         wires screens, session, input, render; app.step(dt) advances one frame
tests/             vitest: rules, physics, determinism, throw model, bot, full bot games, net sync, architecture rules
```

## Rules for code (enforced by `tests/architecture.test.ts` where possible)

- `src/sim/` imports nothing from `three`, the DOM, or other `src/` folders except `types.ts` and `config.ts`.
- No `Math.random`, `Date.now`, `performance.now` or transcendental `Math` functions in `src/sim/`.
- Rendering never changes game state; it reads the session.
- Every tunable number lives in `config/kubb.json`.

## How development is organised

- **Spine, built first and in order:** contract → rules (tested with scripted throw results) → physics (tested with real throws) → throw model and bot → full bot-vs-bot games in tests. Everything else builds on these.
- **Views on top:** rendering, audio, UI, input, networking. They depend on the spine but not on each other, so separate agents can work on them in parallel once the contract is stable.
- **Verification:** `npm run typecheck` and `npm test` for everything; the browser preview and screenshots for visuals (`__kubb.app.step()` drives a hidden tab, `__kubb.scenario()` jumps to a situation); two tabs with `?net=local` for multiplayer without the internet.
- **Human checkpoints:** throw feel and visuals need someone playing. Tunables are in one file and live in `__kubb.CFG`, and `?debug=1` shows FPS and sim state, so feedback maps to numbers.

## Hosting

`.github/workflows/kubb-pages.yml` builds the game and publishes it to GitHub Pages on pushes to `main`. Vite builds with relative paths, so it works under `https://<user>.github.io/<repo>/`. Enabling Pages in the repo settings (source: GitHub Actions) is a one-time manual step.

PeerJS's public server only introduces peers; game traffic goes directly between browsers. Networks that block direct connections (some corporate or university Wi-Fi) would need a TURN relay, which this doesn't include.
