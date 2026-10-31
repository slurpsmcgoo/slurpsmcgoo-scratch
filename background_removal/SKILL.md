---
name: cartoon-gif-background-removal
description: Remove or replace the background behind characters in an animated cartoon GIF or clip with flat-colour (cel-style) artwork and a static camera — cut characters out onto transparency, black, or any solid colour. Use this whenever someone uploads a cartoon/animated GIF and asks to remove the background, isolate or cut out characters, make a transparent or green-screen version, or put the characters on a different background, even if they don't say "segmentation". Generic background-removal models fail on multi-character cartoon scenes; this workflow is far more reliable.
---

# Cartoon GIF background removal

The script `scripts/cartoon_bg.py` does the mechanical work. Your job is the two
judgment steps it cannot do: **labelling the colour palette** and **reviewing the
output**. Read the docstring at the top of the script for the config format.

## Does this approach fit?

It works when the artwork is painted in flat colours with ink outlines and the
background does not move (characters may move freely). Check `motion.png` from
`inspect`: the background should be static apart from dither speckle.

It does not fit live action, a panning or zooming camera, or heavily shaded or
gradient art. Say so rather than forcing it. For a single, isolated character on a
plain background, try `rembg` (isnet-anime model) first, since it may be enough.

## Workflow

```bash
S=/path/to/skill/scripts/cartoon_bg.py
pip install numpy pillow scipy scikit-learn --break-system-packages   # if missing
python3 $S inspect input.gif --work W --clusters 28 [--max-row ROW]
# look at W/palette_sheet.png and W/grid_*.png, write cfg.json
python3 $S sam --work W --config cfg.json        # optional, see below
python3 $S segment --work W --config cfg.json    # iterate on cfg.json until clean
python3 $S export --work W --out out.gif --bg black   # or transparent, "#00FF00", out.webp
```

Use `--max-row` to keep regions that can never hold characters (for example, a car
hood below the dashboard) from using up palette clusters. About 28 clusters suited
a 256-colour GIF; raise the number if character and background colours end up in
the same cluster.

## Labelling the palette (the step that matters most)

`palette_sheet.png` shows each cluster's colour swatch and highlights in magenta
where it appears in the first and last frames. Sort every cluster into one of these
groups:

- **fg_classes**: colours that appear only on characters (skin, hair, clothes, fur,
  eye whites). Background colours that occur only in regions the cutoff removes
  are also safe here. In the example, the light green of the van's hood was the
  colour of Daphne's scarf, and the hood lies below the cutoff.
- **outline_classes**: black and dark-grey ink. Thin ink next to character paint
  becomes outline. Thick blobs (a nose, glasses frames) are decided by the
  ambiguous rule.
- **ambiguous**: colours used by both characters and background (black, dark seat
  colours, a collar painted the van's teal). A region of one of these colours is
  kept if it is smaller than `max_size` and at least `min_border_frac` of its
  border touches character pixels. Order the list from most to least
  character-like, because accepted regions count as character for the next class.
- Anything not listed is background.

Two failure patterns, and their fixes:
- **k-means merged a distinctive character colour into a background cluster.**
  Example: a royal-blue collar landed in the teal van-frame cluster, so it
  flickered in and out. Sample its RGB (median of a 3×3 patch) and add it to
  `extra_fg_colors`.
- **A character part is exactly a background colour.** Use a `zone_rules` entry: a
  row band where that colour can only be character, excluding the background's
  main region of that colour. Always restrict the rows. In the example, the first
  version without row limits picked up a thin arc of the window frame in every
  frame.

## SAM (optional)

SAM (Segment Anything) runs with point prompts per character. Pick points from
`grid_*.png`. Check that each point stays on the same character in every frame, by
sampling colours across frames. In this workflow, SAM is used only as a veto on
ambiguous regions. Its most useful effect is stopping enclosed patches of seat or
wall from being kept, for example where a pointing arm closes off a gap.

Cost: about 1 minute per frame end to end on one CPU (measured 58 s). About 16 s
of that is inference; the rest is reloading the model in each frame's subprocess.
There is also a one-off download of about 375 MB. That is roughly 30 minutes for a
34-frame GIF. Each frame runs in its own subprocess, because a second in-process
run was killed for running out of memory in a 4 GB container. Batching frames per
process with onnxruntime's memory arena turned off might avoid the reload cost,
but this is untested. Results are cached, so reruns skip
finished frames. In claude.ai, background processes die when the tool call
returns, so run `sam` in the foreground. It resumes where it stopped if a call
times out. Skip SAM when the output background is black: dark leftovers it would
remove are invisible there anyway.

## Review loop (do not skip)

1. `segment` writes `contact_sheet.png` on **magenta** by default. Magenta exposes
   dark leftovers that a black background hides. View it, then zoom into faces,
   hands, collars and the edges of the cutoff on several frames.
2. Read the flicker statistic `segment` prints. This counts bright pixels that
   switch between character and background even though their colour didn't
   change. The example ended at about 73 per frame, out of about 50,000 character
   pixels. A large count, or one concentrated in one spot, means a colour sits on
   the edge of a rule. To find it, build a map of where the mask switches over
   time.
3. After changing the config, re-check every frame. A fix for one region often
   causes a regression somewhere else (the window-frame arc above).

## Output choices to raise with the user

- **Transparency in GIF is on or off per pixel**, so edges are hard. Black ink
  outlines hide this on most backgrounds. WebP stores a full alpha channel, but
  this mask is still hard-edged.
- **A black background hides dark leftovers.** If the user may later want a light
  background, the cleanup has to be stricter.
- **Static props the characters hold** (for example, a steering wheel) and
  characters cut off by the scene (for example, a dashboard) are scope decisions.
  State what you decided.
- **Exports use one palette for all frames with no dithering.** The source is
  already dithered, and a per-frame palette makes colours shift between frames.

## Worked example

`examples/scooby_van.json` is the config for a 34-frame Scooby-Doo van GIF (five
characters, with van interior and exterior). Its class numbers are valid only for
the palette made by
`inspect --clusters 28 --max-row 272 --seed 0` on that GIF. Use it as a pattern
for the kinds of rules a scene needs, not as numbers to reuse.
