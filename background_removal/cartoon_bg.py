#!/usr/bin/env python3
"""
cartoon_bg.py - remove the background behind characters in a cel-style cartoon
GIF filmed with a static camera, by classifying flat paint colours.

Usage (each stage writes into one work directory):

    python cartoon_bg.py inspect  in.gif  --work W [--clusters 28] [--max-row R]
    #   -> W/palette_sheet.png, W/grid_*.png, W/motion.png, W/config_template.json
    #   Label the colour clusters (see "CONFIG" below) and save as cfg.json.
    python cartoon_bg.py sam      --work W --config cfg.json        # optional, slow
    python cartoon_bg.py segment  --work W --config cfg.json
    #   -> W/masks.npy, W/contact_sheet.png, prints a flicker statistic
    python cartoon_bg.py export   --work W --out out.gif --bg black   # or transparent / "#RRGGBB"

Requirements: numpy, pillow, scipy, scikit-learn.  The optional `sam` stage
also needs `pip install "rembg[cpu]"` (downloads ~375 MB of SAM ViT-B weights).

---------------------------------------------------------------------------
WHY THIS APPROACH (lessons from a 34-frame, 500x375 Scooby-Doo van GIF)
---------------------------------------------------------------------------
* Generic "salient object" matting models (rembg u2net / isnet-anime) failed on
  a five-character scene: one dropped whole characters, the other returned
  blobby masks that swallowed the seats.
* Segment Anything (SAM) with point prompts per character was decent but
  inconsistent frame to frame (missed hands, a face, parts of a shirt), and its
  masks are too coarse to trust on their own.
* Cel animation is painted in a small set of flat colours, and characters are
  painted in colours the background mostly never uses.  So the backbone is:
  de-dither -> k-means palette -> label each colour cluster as character or
  background.  This is deterministic per pixel, so it barely flickers and it
  picks up moving hands/tails that SAM misses.
* The hard part is colours shared by characters and background (black ink vs.
  seat shadows, a collar painted the same teal as the window frame).  Those are
  decided per connected region: keep a region if it is small AND most of its
  border touches character pixels.  SAM, when available, is used only as a veto
  on these ambiguous regions (it prevents enclosed seat patches being kept).
* A colour-gated temporal majority vote (a pixel whose colour has not changed
  takes the majority label of its neighbouring frames) cut visible flicker
  roughly 2-4x.

---------------------------------------------------------------------------
CONFIG (JSON).  Class numbers refer to W/centers.npy written by `inspect`;
extra_fg_colors are appended after them (index K, K+1, ...).
---------------------------------------------------------------------------
{
  "fg_classes":       [..],   clusters that are always character paint
  "outline_classes":  [..],   dark ink colours; thin pixels of these next to
                              character paint become character (outlines)
  "ambiguous": {             evaluated IN THIS ORDER; each region of the class is
     "19": {"max_size": 1500, "min_border_frac": 0.25}, ...   kept if size < max_size
  },                          and >= min_border_frac of its border is character
  "extra_fg_colors":  [[r,g,b], ..],  extra character colours k-means merged into
                              a background cluster (e.g. a royal-blue collar)
  "cutoff": {"class": 4, "search_rows": [255, 300], "run": 4, "smooth": 15,
             "default_row": 272},     optional: per-column first row where `class`
                              repeats `run` times, from frame 0; everything at or
                              below is background (e.g. a dashboard)
  "band_exclude": {"classes": [23], "rows_above_cutoff": 5},   optional
  "zone_rules": [{"class": 4, "rows": [90, 230], "exclude_largest_component_pad": 8}],
                              optional: pixels of `class` inside the row band and
                              away from that class's largest frame-0 region
                              (padded) are character (collar same colour as van)
  "wall_classes": [0, 6],    background colours that veto small-hole filling
  "params": {"min_seed_px": 25, "min_object_px": 60, "outline_dilate": 3,
             "small_hole_px": 200, "wall_frac_veto": 0.6},
  "temporal": {"radius": 4, "color_tol": 25},
  "sam": {"use_as_veto": true, "veto_dilate": 2, "min_px": 60,
          "prompts": {"name": [[x, y], ..]}, "negatives": [[x, y], ..]}
}
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageSequence
from scipy import ndimage as ndi


# ----------------------------------------------------------------- helpers
def _p(work, name):
    return os.path.join(work, name)


def load_cfg(path):
    with open(path) as f:
        return json.load(f)


def rm_small(mask, n):
    """Drop connected components smaller than n pixels."""
    lab, k = ndi.label(mask)
    if k == 0:
        return mask
    sz = ndi.sum(mask, lab, range(1, k + 1))
    return np.r_[False, sz >= n][lab]


def nearest_class(img, centers):
    """Label each pixel with the index of the nearest palette centre (RGB)."""
    d = ((img[..., None, :].astype(np.float32) - centers[None, None]) ** 2).sum(-1)
    return d.argmin(-1)


def all_centers(work, cfg):
    C = np.load(_p(work, "centers.npy"))
    extra = cfg.get("extra_fg_colors", [])
    if extra:
        C = np.vstack([C, np.array(extra, np.float32)])
    return C, list(range(len(C) - len(extra), len(C)))


def fill_small_holes(fg, labels, max_px, wall_classes, wall_frac_veto):
    """Fill enclosed holes smaller than max_px unless they are mostly wall colour.
    (Fills eye whites, glasses lenses and dither pinholes, but not a patch of wall
    enclosed between a pointing arm and a head.)"""
    filled = ndi.binary_fill_holes(fg)
    holes = filled & ~fg
    hl, k = ndi.label(holes)
    if k == 0:
        return fg
    sz = ndi.sum(holes, hl, range(1, k + 1))
    wall = np.isin(labels, wall_classes).ravel()
    wf = np.bincount(hl.ravel(), weights=wall, minlength=k + 1) / np.maximum(
        np.bincount(hl.ravel(), minlength=k + 1), 1)
    return fg | np.r_[False, (sz < max_px) & (wf[1:] < wall_frac_veto)][hl]


def save_tiles(images, path, cols=6, scale=0.5, pad_color=(70, 70, 70)):
    h, w = images[0].shape[:2]
    tw, th = int(w * scale), int(h * scale)
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * th), pad_color)
    for i, im in enumerate(images):
        sheet.paste(Image.fromarray(im.astype(np.uint8)).resize((tw, th), Image.LANCZOS),
                    ((i % cols) * tw, (i // cols) * th))
    sheet.save(path)


# ----------------------------------------------------------------- inspect
def cmd_inspect(a):
    from sklearn.cluster import KMeans
    os.makedirs(a.work, exist_ok=True)
    gif = Image.open(a.gif)
    frames, durs = [], []
    for f in ImageSequence.Iterator(gif):
        frames.append(np.asarray(f.convert("RGB")))
        durs.append(f.info.get("duration", 100))
    A = np.stack(frames)
    N, H, W = A.shape[:3]
    np.save(_p(a.work, "frames.npy"), A)
    json.dump({"durations": durs, "loop": gif.info.get("loop", 0)},
              open(_p(a.work, "timing.json"), "w"))
    # 3x3 median per channel removes GIF dithering before colour clustering
    M = np.stack([ndi.median_filter(x, size=(3, 3, 1), mode="nearest") for x in A])
    np.save(_p(a.work, "M.npy"), M)
    max_row = a.max_row or H
    sub = M[::3, :max_row:2, ::2].reshape(-1, 3).astype(np.float32)
    km = KMeans(a.clusters, n_init=4, random_state=a.seed).fit(sub)
    C = km.cluster_centers_
    np.save(_p(a.work, "centers.npy"), C)

    # palette sheet: where each cluster lives in the first and last frame
    first, last = nearest_class(M[0], C), nearest_class(M[-1], C)
    tw, th = 250, int(250 * H / W)
    cols = 4
    rows = (len(C) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (2 * tw + 10), rows * (th + 20)), (40, 40, 40))
    d = ImageDraw.Draw(sheet)
    for k in range(len(C)):
        r, c = divmod(k, cols)
        x0, y0 = c * (2 * tw + 10), r * (th + 20)
        for j, (L, F) in enumerate([(first, A[0]), (last, A[-1])]):
            im = (F * 0.25).astype(np.uint8).copy()
            im[L == k] = (255, 0, 255)
            sheet.paste(Image.fromarray(im).resize((tw, th)), (x0 + j * tw, y0 + 20))
        d.rectangle([x0, y0, x0 + 18, y0 + 18], fill=tuple(int(v) for v in C[k]))
        d.text((x0 + 22, y0 + 4), f"{k}: {tuple(int(v) for v in C[k])}", fill=(255, 255, 255))
    sheet.save(_p(a.work, "palette_sheet.png"))

    # coordinate grids (for choosing SAM prompt points) on first/middle/last frame
    for t in sorted({0, N // 2, N - 1}):
        im = Image.fromarray(A[t]).resize((W * 2, H * 2), Image.NEAREST)
        dr = ImageDraw.Draw(im)
        for x in range(0, W, 25):
            dr.line([(2 * x, 0), (2 * x, 2 * H)], fill=(255, 0, 0) if x % 100 == 0 else (255, 255, 0))
            if x % 50 == 0:
                dr.text((2 * x + 2, 2), str(x), fill=(255, 255, 255))
        for y in range(0, H, 25):
            dr.line([(0, 2 * y), (2 * W, 2 * y)], fill=(255, 0, 0) if y % 100 == 0 else (255, 255, 0))
            if y % 50 == 0:
                dr.text((2, 2 * y + 2), str(y), fill=(255, 255, 255))
        im.save(_p(a.work, f"grid_{t:02d}.png"))

    # motion map: where anything changes over the clip (static camera check)
    mov = (np.abs(np.diff(M.astype(int), axis=0)).sum(-1) > 40).any(0)
    Image.fromarray((mov * 255).astype(np.uint8)).save(_p(a.work, "motion.png"))

    # per-cluster stats to help labelling (not a decision)
    Lall = np.stack([nearest_class(M[t], C) for t in range(0, N, max(1, N // 8))])
    stats = []
    for k in range(len(C)):
        sel = Lall == k
        stats.append({"class": k, "rgb": [int(v) for v in C[k]],
                      "share": round(float(sel.mean()), 4),
                      "share_in_moving_pixels": round(float((sel & mov[None]).sum() / max(sel.sum(), 1)), 3)})
    template = {"_cluster_stats": stats, "fg_classes": [], "outline_classes": [], "ambiguous": {},
                "extra_fg_colors": [], "wall_classes": [],
                "params": {"min_seed_px": 25, "min_object_px": 60, "outline_dilate": 3,
                           "small_hole_px": 200, "wall_frac_veto": 0.6},
                "temporal": {"radius": 4, "color_tol": 25}}
    json.dump(template, open(_p(a.work, "config_template.json"), "w"), indent=1)
    print(f"{N} frames {W}x{H}; wrote palette_sheet.png, grid_*.png, motion.png, "
          f"config_template.json to {a.work}")


# ----------------------------------------------------------------- SAM (optional)
def _sam_frame(work, cfg_path, t):
    """Run SAM ViT-B for one frame. Called in a subprocess per frame: in a ~3-4 GB
    container a second in-process encode was OOM-killed."""
    from rembg import new_session
    from rembg.sessions.sam import warp_affine, apply_coords, transform_masks
    cfg = load_cfg(cfg_path)["sam"]
    sess = new_session("sam")
    enc, dec = sess.encoder, sess.decoder
    target_size, input_size = 1024, (684, 1024)
    A = np.load(_p(work, "frames.npy"), mmap_mode="r")
    cv = np.array(A[t])
    osz = cv.shape[:2]
    s = min(input_size[1] / cv.shape[1], input_size[0] / cv.shape[0])
    T = np.array([[s, 0, 0], [0, s, 0], [0, 0, 1]])
    E = enc.run(None, {enc.get_inputs()[0].name:
                       warp_affine(cv, T[:2], (input_size[0], input_size[1])).astype(np.float32)})[0]
    neg = cfg.get("negatives", [])
    out = {}
    for name, pos in cfg["prompts"].items():
        pts = np.array(pos + neg + [[0, 0]], float)[None]
        lab = np.array([1] * len(pos) + [0] * len(neg) + [-1], np.float32)[None]
        c = apply_coords(pts, input_size, target_size).astype(np.float32)
        c = np.concatenate([c, np.ones((1, c.shape[1], 1), np.float32)], 2)
        c = np.matmul(c, T.T)[:, :, :2].astype(np.float32)
        m, _, _ = dec.run(None, {"image_embeddings": E, "point_coords": c, "point_labels": lab,
                                 "mask_input": np.zeros((1, 1, 256, 256), np.float32),
                                 "has_mask_input": np.zeros(1, np.float32),
                                 "orig_im_size": np.array(input_size, np.float32)})
        out[name] = transform_masks(m, osz, np.linalg.inv(T))[0, 0].astype(np.float16)
    os.makedirs(_p(work, "sam"), exist_ok=True)
    np.savez_compressed(_p(work, f"sam/logits{t:02d}.npz"), **out)


def cmd_sam(a):
    N = np.load(_p(a.work, "frames.npy"), mmap_mode="r").shape[0]
    todo = [t for t in range(N) if not os.path.exists(_p(a.work, f"sam/logits{t:02d}.npz"))]
    print(f"SAM: {len(todo)} of {N} frames to run (cached frames are skipped)")
    for t in todo:
        t0 = time.time()
        r = subprocess.run([sys.executable, os.path.abspath(__file__), "_sam_frame",
                            a.work, a.config, str(t)], capture_output=True, text=True, timeout=a.timeout)
        if r.returncode != 0:
            sys.exit(f"frame {t} failed:\n{r.stderr[-2000:]}")
        print(f"  frame {t}: {time.time() - t0:.1f} s", flush=True)


def sam_union(work, t, min_px):
    """Union of per-character SAM masks for frame t, each cleaned and hole-filled."""
    path = _p(work, f"sam/logits{t:02d}.npz")
    if not os.path.exists(path):
        return None
    L = np.load(path)
    U = None
    for name in L.files:
        m = ndi.binary_fill_holes(rm_small(L[name].astype(np.float32) > 0, min_px))
        U = m if U is None else (U | m)
    return U


# ----------------------------------------------------------------- segment
def cmd_segment(a):
    cfg = load_cfg(a.config)
    P = {"min_seed_px": 25, "min_object_px": 60, "outline_dilate": 3,
         "small_hole_px": 200, "wall_frac_veto": 0.6, **cfg.get("params", {})}
    A = np.load(_p(a.work, "frames.npy"))
    M = np.load(_p(a.work, "M.npy"))
    N, H, W = A.shape[:3]
    C, extra_idx = all_centers(a.work, cfg)
    FG = list(cfg["fg_classes"]) + extra_idx
    OUT = cfg.get("outline_classes", [])
    AMB = [(int(k), v["max_size"], v["min_border_frac"]) for k, v in cfg.get("ambiguous", {}).items()]
    walls = cfg.get("wall_classes", [])
    rows = np.arange(H)[:, None]
    L0 = nearest_class(M[0], C)

    below = np.zeros((H, W), bool)
    band = np.zeros((H, W), bool)
    if "cutoff" in cfg:
        cu = cfg["cutoff"]
        dash = np.full(W, cu.get("default_row", H))
        y0, y1 = cu["search_rows"]
        run = cu.get("run", 4)
        for x in range(W):
            col = L0[:, x] == cu["class"]
            for y in range(y0, y1):
                if col[y:y + run].all():
                    dash[x] = y
                    break
        dash = ndi.median_filter(dash, cu.get("smooth", 15))
        below = rows >= dash[None, :]
        if "band_exclude" in cfg:
            band = (rows >= dash[None, :] - cfg["band_exclude"]["rows_above_cutoff"]) & ~below

    zones = []
    for z in cfg.get("zone_rules", []):
        t0 = L0 == z["class"]
        lab, k = ndi.label(t0)
        big = lab == (np.argmax(ndi.sum(t0, lab, range(1, k + 1))) + 1) if k else np.zeros_like(t0)
        far = ~ndi.binary_dilation(big, iterations=z.get("exclude_largest_component_pad", 8))
        zones.append((z["class"], far & (rows >= z["rows"][0]) & (rows <= z["rows"][1])))

    samcfg = cfg.get("sam", {})
    labels_all, masks = [], []
    for t in range(N):
        L = nearest_class(M[t], C)
        labels_all.append(L)
        # 1. seed: unambiguous character paint
        seed = np.isin(L, FG) & ~below
        if "band_exclude" in cfg:
            seed &= ~(band & np.isin(L, cfg["band_exclude"]["classes"]))
        seed = rm_small(seed, P["min_seed_px"])
        fg = seed.copy()
        # 2. thin ink next to paint = outlines (thick dark blobs are handled in 3)
        dark = np.isin(L, OUT) & ~below
        thick = ndi.binary_opening(dark, structure=np.ones((5, 5)))
        fg |= (dark & ~thick) & ndi.binary_dilation(seed, iterations=P["outline_dilate"])
        # 3. ambiguous colours: keep small regions mostly bordered by character
        veto = None
        if samcfg.get("use_as_veto"):
            U = sam_union(a.work, t, samcfg.get("min_px", 60))
            if U is not None:
                veto = ndi.binary_dilation(U, iterations=samcfg.get("veto_dilate", 2))
        for k, smax, fmin in AMB:   # fg grows in place, so order matters
            m = (L == k) & ~below & ~fg
            lab, n = ndi.label(m)
            if n == 0:
                continue
            sz = ndi.sum(m, lab, range(1, n + 1))
            dil = ndi.grey_dilation(lab, size=(3, 3))
            bnd = (dil > 0) & (lab == 0)
            tot = np.bincount(dil[bnd], minlength=n + 1)
            hit = np.bincount(dil[bnd & fg], minlength=n + 1)
            ok = np.r_[False, (sz < smax) & (hit[1:] / np.maximum(tot[1:], 1) >= fmin)][lab]
            fg |= ok if veto is None else (ok & veto)
        # 4. zone rules (e.g. collar painted the same colour as the van frame)
        for cls, zone in zones:
            fg |= (L == cls) & zone & ~below
        fg = rm_small(fg, P["min_object_px"])
        fg = fill_small_holes(fg, L, P["small_hole_px"], walls, P["wall_frac_veto"])
        masks.append(fg)
    raw = np.stack(masks)

    # 5. temporal vote among nearby frames whose colour at this pixel is similar
    R, tol = cfg.get("temporal", {}).get("radius", 4), cfg.get("temporal", {}).get("color_tol", 25)
    Mi = M.astype(np.int16)
    mf = raw.astype(np.float32)
    final = np.zeros_like(raw)
    for t in range(N):
        num = np.zeros((H, W), np.float32)
        den = np.zeros((H, W), np.float32)
        for s in range(max(0, t - R), min(N, t + R + 1)):
            sim = (np.abs(Mi[s] - Mi[t]).sum(-1) < tol).astype(np.float32)
            num += sim * mf[s]
            den += sim
        v = num / den
        o = (v > 0.5) | ((v == 0.5) & raw[t])
        o = rm_small(o, P["min_object_px"])
        final[t] = fill_small_holes(o, labels_all[t], P["small_hole_px"], walls, P["wall_frac_veto"])
    np.save(_p(a.work, "masks.npy"), final)

    # diagnostics: flicker = mask flips on bright pixels whose colour did not change
    lum = 0.3 * Mi[..., 0] + 0.59 * Mi[..., 1] + 0.11 * Mi[..., 2]
    def flicker(m):
        return [int(((m[t] != m[t - 1]) & (np.abs(Mi[t] - Mi[t - 1]).sum(-1) < 20) & (lum[t] > 60)).sum())
                for t in range(1, N)]
    fr, ff = flicker(raw), flicker(final)
    print(f"visible flicker px/frame  before vote: mean {np.mean(fr):.0f} max {max(fr)}"
          f" | after vote: mean {np.mean(ff):.0f} max {max(ff)}"
          f" | mask area ~{int(final.reshape(N, -1).sum(1).mean())} px")
    bg = np.array(a.preview_bg, np.uint8)
    tiles = []
    for t in range(N):
        im = np.empty_like(A[t])
        im[:] = bg
        im[final[t]] = A[t][final[t]]
        tiles.append(im)
    save_tiles(tiles, _p(a.work, "contact_sheet.png"))
    print(f"wrote {_p(a.work, 'masks.npy')} and contact_sheet.png (check it zoomed in!)")


# ----------------------------------------------------------------- export
def cmd_export(a):
    A = np.load(_p(a.work, "frames.npy"))
    m = np.load(_p(a.work, a.masks))
    timing = json.load(open(_p(a.work, "timing.json")))
    N, H, W = A.shape[:3]
    transparent = a.bg == "transparent"
    bg = (0, 0, 0) if transparent or a.bg == "black" else tuple(
        int(a.bg.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
    comp = []
    for t in range(N):
        im = np.empty_like(A[t])
        im[:] = bg
        im[m[t]] = A[t][m[t]]
        comp.append(im)
    ext = os.path.splitext(a.out)[1].lower()
    if ext == ".webp":   # 8-bit alpha capable; edges are still binary from the mask
        ims = []
        for t in range(N):
            rgba = np.dstack([comp[t], (m[t] * 255 if transparent else np.full((H, W), 255)).astype(np.uint8)])
            ims.append(Image.fromarray(rgba, "RGBA"))
        ims[0].save(a.out, save_all=True, append_images=ims[1:], duration=timing["durations"],
                    loop=timing["loop"], lossless=True)
    else:
        # one global palette for all frames, no dithering (the source is already dithered)
        ncol = 255 if transparent else 256
        mont = Image.new("RGB", (W, H * N))
        for t in range(N):
            src = comp[t].copy()
            if transparent:   # build palette from character pixels only
                src[~m[t]] = A[t][m[t]][0] if m[t].any() else 0
            mont.paste(Image.fromarray(src), (0, t * H))
        pal = mont.quantize(colors=ncol, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        q = []
        for t in range(N):
            p = Image.fromarray(comp[t]).quantize(palette=pal, dither=Image.Dither.NONE)
            if transparent:
                arr = np.asarray(p).copy()
                arr[~m[t]] = 255                     # reserved transparent index
                p = Image.fromarray(arr, "P")
                p.putpalette(pal.getpalette()[:765] + [0, 0, 0])
            q.append(p)
        kw = dict(save_all=True, append_images=q[1:], duration=timing["durations"],
                  loop=timing["loop"], optimize=False)
        if transparent:
            kw.update(transparency=255, disposal=2)  # disposal 2 = clear before next frame
        else:
            kw.update(disposal=1)
        q[0].save(a.out, **kw)
    print(f"wrote {a.out} ({os.path.getsize(a.out)} bytes, {N} frames)")


# ----------------------------------------------------------------- CLI
def main():
    if len(sys.argv) > 1 and sys.argv[1] == "_sam_frame":
        _sam_frame(sys.argv[2], sys.argv[3], int(sys.argv[4]))
        return
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("inspect", help="extract frames, build palette + diagnostic images")
    p.add_argument("gif")
    p.add_argument("--work", required=True)
    p.add_argument("--clusters", type=int, default=28)
    p.add_argument("--max-row", type=int, default=0,
                   help="only sample rows above this when fitting the palette (0 = all)")
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(fn=cmd_inspect)
    p = sp.add_parser("sam", help="optional SAM masks, one subprocess per frame, cached")
    p.add_argument("--work", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--timeout", type=int, default=180)
    p.set_defaults(fn=cmd_sam)
    p = sp.add_parser("segment", help="compute per-frame character masks")
    p.add_argument("--work", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--preview-bg", type=int, nargs=3, default=[255, 0, 255],
                   help="contact-sheet background; magenta exposes leftovers that black hides")
    p.set_defaults(fn=cmd_segment)
    p = sp.add_parser("export", help="write the animated result")
    p.add_argument("--work", required=True)
    p.add_argument("--out", required=True, help=".gif or .webp")
    p.add_argument("--bg", default="black", help='black | transparent | "#RRGGBB"')
    p.add_argument("--masks", default="masks.npy")
    p.set_defaults(fn=cmd_export)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
