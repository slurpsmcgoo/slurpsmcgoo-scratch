# Kubb

The Viking lawn game in 3D, in your browser. Knock down the other team's kubbs with batons, then topple the king.

- **Real physics**: life-size wooden pieces, batons that tumble end over end, kubbs that fall the way wood falls on grass.
- **Teams**: any number of players per side, taking turns to throw. Mix humans and computer players (easy, medium, hard), on one computer or online.
- **Online with friends**: host a game, send the link. Games go directly between browsers; there's no account and no server to run.
- **Three places to play**: a summer park; the Moon, with one-sixth gravity, no air, plumes of dust that fly in perfect arcs, and craters that every hard landing digs, that pieces roll into, and that grow when you keep hitting the same spot; and the ocean floor, in brass diving helmets, where the water drags at every throw among kelp, fish and bubbles.
- **Beer mode** (optional): everyone drinks as the game goes on. A modest buzz sharpens your throw; overdo it and the world blurs and sways. Cans pile up around the cooler. Simulated, for fun.
- **Practice mode** with a throw-arc preview.
- Works with a mouse, a trackpad or a touch screen. Experimental VR (WebXR), not yet tested on a headset.

## How to play

**Aim** by pointing at the ground (on a touch screen, tap where you want to aim). Hold the right mouse button or **Z** to zoom in on distant kubbs.

**Throw** by pressing, pulling back, then flicking forward and letting go. A ring around your aim point shows where the throw can land: your thrower knows roughly how hard to throw, and the flick decides where inside the ring it goes. A comfortable flick lands in the middle; faster goes long, slower goes short, and drifting sideways moves it left or right. The yellow dot shows where you're heading while you flick. Prefer a power bar? Switch to **Power meter** in Settings (or press **M**), then release when the bar is at the middle tick.

**Spin**: the further you pull back before flicking, the faster the baton tumbles (or set it with Q/E: choose in Settings). Too little spin and a baton tends to slide past; too much and it bounces about.

**Arc**: W/S or the scroll wheel. **Step along the line**: A/D. **Whole pitch**: V.

**Kubb colours** (Settings): natural wood, a blue set and a white set, or each kubb half blue and half white.

**Beer mode** (tick it when setting up a game): press **B** or the Drink button for a can. Alcohol takes a while to kick in, so watch the arrow on your BAC meter. In the gold band you're in the zone: your ring tightens and throws drift towards its middle. Past it, the ring grows, your aim wanders, and the view blurs and tilts. The can colours follow a few well-known light lagers, with generic names instead of brands. Please drink responsibly in real life.

**Training wheels** (P, or in Settings): shows the flight arc and, on the power bar, the power that would reach your aim point.

### Rules, briefly

Each team has five kubbs on its baseline; the king stands in the middle. On your turn:

1. Throw any kubbs knocked down on your side into the other half. They're stood up where they land (the other team picks which end stays down; touching kubbs are stacked). Two misses with the same kubb: the other team places it anywhere in their half.
2. Throw your batons (2 on the very first turn, 4 on the second, then 6). Kubbs standing in the field must fall before baseline kubbs count.
3. If you leave field kubbs standing, the other team throws from the nearest one instead of their baseline.
4. When all the other team's kubbs are down, throw at the king from your baseline. Topple it to win; topple it early and you lose.

## Play online with friends

1. **Put the game somewhere your friends can open it.** Pushes to `main` publish it to GitHub Pages (`.github/workflows/kubb-pages.yml`). Once, in the repo's Settings → Pages, set Source to "GitHub Actions". GitHub Pages needs a public repo (or a paid plan for private ones). The game is then at `https://<your-user>.github.io/<repo>/`. Any static host works too: `npm run build` and upload `dist/` (to Netlify Drop or Cloudflare Pages, for example).
   - Same Wi-Fi only? `npm run dev` and have friends open `http://<your computer's IP>:5174`.
2. Open the game, choose **Play online → Host a game**, and press **Copy link**.
3. Send the link. Friends open it, type a name and press **Join**; they appear in the lobby.
4. Arrange teams (add computer players if you like), pick where to play, tick beer mode if you want it, and press **Start**.

The host's browser runs the game, so keep that tab open and in front. Players who drop out are taken over by the computer.

## Develop

Needs Node 24 or newer.

```bash
npm install
npm run dev        # http://localhost:5174
npm test
npm run build      # dist/, ready for static hosting
```

Pushes to `main` publish the game to GitHub Pages (enable Pages with source "GitHub Actions" in the repo settings once). See [CLAUDE.md](CLAUDE.md) for the code layout and rules, and [docs/architecture.md](docs/architecture.md) for the design.

### Notes

- Online play uses PeerJS's free public server to introduce browsers; the game itself goes peer to peer. Networks that block direct connections (some office or school Wi-Fi) won't connect without a TURN relay, which this doesn't include.
- The bundle is about 1.9 MB gzipped, mostly the physics engine's WebAssembly.
