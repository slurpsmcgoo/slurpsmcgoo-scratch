# Halloween Window Projection

A browser app that rear-projects animated scenes onto a sheet in your front window. A webcam and microphone watch the front walk, and every scene reacts to who is outside: Shadow Walker, Sound Skull, Watching Eyes, Approaching Ghost and Skeleton Mirror.

**Current default: Skeleton Mirror only.** Each person on the walk becomes a cute creature that copies their moves: the first is a skeleton, then a mummy, a ghost and a stitched-together monster. Creatures stay on screen while their person is there. On a scare they react in place: the skeleton and mummy rattle, the ghost puffs up with a BOO, and the monster gets zapped. When a person walks away, their skeleton falls into a pile of bones (a mummy unravels and leaves its eyes floating) that fades after a few seconds; ghosts and monsters fade away.

**Disco mode.** A disco ball hangs at the top of the window. When the microphone hears music with a steady beat (a porch speaker), a laser show starts behind the creatures. It handles straight dance beats (YMCA) and swung 50s/60s shuffles (Monster Mash, Purple People Eater), tested on synthesized versions of both, including muffled through a window with people talking. On every beat the beams snap to a new position and flash bright, then dim until the next one; the first beat of each bar hits hardest. Patterns change every 4 bars. Light spots from the ball drift across the window, and the idle dancer dances in time. With no music, the lasers fade out and the ball just turns slowly. Everything is drawn behind the creatures, so they always stay clean on top. Settings are the `disco…` and `laser…` keys in `scenes.skeletonMirror`; set `"disco": false` to turn it off. The beat tracker's settings are in the `music` section.

An older sound-reactive overlay (fireflies, candle glow, lightning) is still available with the `L` key, but it's off by default (`ambient.enabled`) because it washes out the creatures.

The show doesn't rotate scenes (`show.playlist` is `["skeletonMirror"]`, `show.rotateEveryS` is 0). If the camera drops out it falls back to Shadow Walker and comes straight back when the camera returns. To bring the other scenes back, list them in `show.playlist` and set `rotateEveryS` (for example 180).

Design doc: [docs/architecture.md](docs/architecture.md) (snapshot of the [live doc](https://claude.ai/artifact/MSDCeL7aJbTvWXMWDZMnp1)).

## Setup (once, online)

Needs Node 24+ and Google Chrome.

```bash
npm install
npm run fetch-models
```

`fetch-models` copies MediaPipe's WebAssembly runtime out of `node_modules` and downloads the pose model (about 6 MB) into `public/models/`. After that the show runs fully offline.

## Try it at a desk

```bash
npm run dev
```

Open http://localhost:5173/?source=sim&overlay=1. The walk map in the bottom-left corner is the simulator. Click to add a person, then drag them down toward the window and watch the state go idle → noticed → engaged → scare → cooldown. Press `J` for a family of four (one of each creature), press `K` to cycle a simulated track (disco, then a Monster Mash-style shuffle, then off), and press `X` to shout.

## Run the show

```bash
scripts/start-show.sh
```

This builds the app, starts the show server, keeps the Mac awake, and opens Chrome in kiosk mode. If the projector is a second display, move the window there with, for example, `SHOW_X=1920 scripts/start-show.sh` (use your projector display's left edge). The terminal prints the phone remote address, `http://<laptop-ip>:8787/remote`. Quit Chrome with Cmd+Q, then press Ctrl+C in the terminal.

The first run asks for camera and microphone access. Click Allow; the dedicated Chrome profile remembers it.

## Keys

| Key | Action |
|---|---|
| ← / → | previous / next scene in the playlist |
| 1–9 | pick a scene by its playlist position |
| Enter | scare now |
| B | blackout |
| P | pause interaction |
| + / − | sensitivity up / down |
| G | cycle intensity: gentle, normal, full |
| M | mirror (rear projection) |
| O | landscape / portrait (saved straight away) |
| A | camera active area: which part of the camera fills the window (saved when you press A again) |
| T | high-contrast skeletons, for a translucent screen (until reload; `highContrast` in show.json keeps it) |
| Shift+O | turn the picture a quarter turn clockwise, for a projector on its side (saved straight away) |
| C | calibration mode (corner pin and window mask; C again saves, Esc cancels) |
| D | debug overlay (includes pose model speed and the lights' liveliness meter) |
| L | the older sound-reactive overlay on / off (off by default) |
| S | switch between live sensors and the simulator |
| R | record a perception log (numbers only) to `logs/` |
| F | fullscreen |

Simulator only: `X` shout, hold `V` to talk, `K` music: disco / shuffle / off, `J` family, `H` passer-by, `U` lurker, `Backspace` clear, `[` camera on/off, `]` mic on/off.

Replay a recorded log with `?source=replay&log=<name>`. `/api/logs` lists the logs.

## Show-night checklist

**Physical setup** (no code fixes a gray sheet):

- Use a dense, diffusing sheet: doubled bedsheet, frosted shower curtain or rear-projection fabric.
- Keep the room behind the sheet dark.
- Aim the porch light down at the walk, not at the window.
- Press the camera flat to the glass inside a black hood, so it doesn't see the sheet's reflection.
- Put a USB mic near the door, not the laptop's built-in mic behind glass.

**Laptop:**

- Plug into AC power.
- Turn on Do Not Disturb, so no notification banners appear on the projection.
- The start script prevents sleep while it runs.

**Calibration:**

1. Press `C`.
2. Turn on `M` if the projector is behind the sheet. Check from the street that the text reads normally.
3. Drag the four corners to the window opening.
4. Press Tab and drag the mask points so nothing spills onto the frame or wall.
5. Press `C` to save.

**Portrait (a tall window):** press `O` to switch to portrait. The picture becomes 1080 wide and 1920 tall.

- If you rotated the display in macOS (System Settings › Displays › Rotation), that's all.
- If the projector is on its side and macOS still thinks it's landscape, also press `Shift+O` until the picture is upright from the street (each press turns it a quarter turn).
- In portrait, the window shows the center slice of the camera picture by default. Use the camera active area (`A`, below) to choose a different part, or make the box bigger than the camera picture to show all of it, smaller.
- Then calibrate corners and mask as usual (`C`); `O` and `Shift+O` work there too.

**Camera active area (obstructions, zooming in):** press `A`. The live camera fills the screen with a yellow box: the part of the camera that fills the whole window.

- Drag inside the box to move it; drag a corner or scroll to resize. It always keeps the window's proportions, so nobody is stretched. Arrows nudge it, `+`/`-` resize.
- Put the box over the clear part of your walk and leave bushes, posts and cars outside it. The window shows the result live while you drag.
- `I`: ignore people standing outside the box (on by default).
- `P`: run the pose model on just the box plus a margin (the dashed line; on by default). The model never sees what's outside it, and people inside get more pixels, so smaller or farther people are found more reliably.
- `R` resets to the largest centered box. `A` or `Enter` saves to `show.json`; `Esc` leaves without saving.
- Distances and zones still use the full camera picture, so the tape-mark calibration below doesn't change.

**Translucent screen (shower curtain):** press `T` for high-contrast mode: everyone is a pure-white skeleton with thicker bones, with no glow, disco ball or lasers (any haze spreads through a thin curtain and washes out the bones). `T` lasts until reload; set `scenes.skeletonMirror.highContrast` to `true` in `show.json` to keep it, and `contrastBoneScale` to change the bone thickness.

**Distance:** tape two marks on the walk, for example at 2 m and 5 m.

1. Stand on each mark with the overlay on (`D`) and the camera thumbnail visible.
2. Note where your feet appear vertically (0 = top of image, 1 = bottom).
3. Put those values in `geometry.calibrationMarks` in `config/show.json`.
4. Set `geometry.cameraHeightM` to the camera's height.

Edits to `show.json` take effect immediately.

## Not yet tested on real hardware

Everything below needs your camera, projector, street or phone. None of it could be checked at a desk.

- [ ] **Camera mirroring:** whether Chrome's camera feed is already mirrored.
  - Walk to your left (as a visitor) and check the overlay walk map shows you moving left.
  - If it's reversed, set `perception.cameraFeedMirrored: true`.
- [ ] **Pose on costumes at night:** whether pose detection works on costumed kids in the dark. This is the doc's biggest risk.
  - Record test walks in costume with `R`.
  - Replay them later with `?source=replay&log=...`.
- [ ] **Zones and IDs:** walking the front path shows correct zones and stable IDs.
- [ ] **Shout threshold:** tune `audio.shoutRiseDb` against your street's real background noise.
- [ ] **Disco beat lock:** play your music on the porch at show volume and turn on the overlay (`D`).
  - The `music` line should say `playing` with about the right BPM within a few seconds (YMCA is about 127).
  - The **beat graph** (bottom right) shows what the tracker hears: blue bars are onset strength (kicks, claps, bass notes), pink lines are the beats on its clock. The lines should sit on the tallest bars. Clarity is green above `clarityOn` (lasers start), yellow above `clarityKeep` (lasers stay on), red below.
  - If clarity sits in the red or yellow with music playing, the mic isn't hearing the beat well. Move it closer to the speaker, or lower `music.clarityOn` / `music.clarityKeep` a little (talking alone measured 0.24 at most in testing).
  - If the lasers hit visibly early or late, adjust `music.leadMs` (higher fires earlier). It starts at 50 ms to cover drawing and projector delay.
  - If it still misbehaves, press `R` during a song for 30 s and send me the log from `logs/`. It now includes the tracker's onset signal (numbers only, no audio).
  - Set `music.floorDb` / `music.fullDb` so the show's brightness follows the music's volume.
- [ ] **Music vs. shouts:** check that starting a song, or a loud drop, doesn't count as a shout and set off a scare. If it does, raise `audio.shoutRiseDb` or set `director.scareOnShout` to false.
- [ ] **Two or more people in Skeleton Mirror:** check the overlay's `pose ... fps` line stays near the camera rate (30) with several people dancing, and note `camera-to-result`.
  - If fps drops a lot, lower `perception.inferenceWidth` (for example 640) or `perception.numPoses`.
  - Creatures are moved forward to each drawn frame from their recent motion (`perception.predictMotion`, `predictMs`). If they overshoot when someone stops suddenly, lower `predictMs`; if they trail behind, raise it a little (50 at most).
- [ ] **Projection:** image fit, mirror and black level on the sheet.
- [ ] **Phone remote:** every command works from your phone over Wi-Fi.
- [ ] **Latency (Skeleton Mirror):** film yourself and the sheet in 240 fps slow motion and count the frames between a hand movement and the projected response.
- [ ] **Unplug test:** unplug the camera and mic mid-show. The show should fall back to Shadow Walker or Sound Skull and recover within 30 s of plugging them back in.
- [ ] **Soak:** a full 4-hour run on the show laptop.

## Development

See [CLAUDE.md](CLAUDE.md) for commands, layout and the project's rules.
