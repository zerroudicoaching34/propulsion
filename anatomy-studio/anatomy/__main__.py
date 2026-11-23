"""CLI:
  python3 -m anatomy compose --skeleton s.png --muscles m.png [--out assets/anatomie-squelette-muscles.png]
  python3 -m anatomy grid    [--x0 1400 --y0 520 --w 780 --h 1340]   grille de repérage pour tracer les zones
  python3 -m anatomy check                                             superpose les zones (vérification)
  python3 -m anatomy still | gif | mp4 | all
"""
import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .studio import Film, Studio, font, render_gif, tw

ROOT = Path(__file__).resolve().parent.parent


def main(argv=None):
    ap = argparse.ArgumentParser(prog="anatomy")
    ap.add_argument("cmd", choices=["compose", "grid", "check", "still", "gif", "mp4", "all"])
    ap.add_argument("--photo-config", default="config/photo_zach.yaml")
    ap.add_argument("--skeleton")
    ap.add_argument("--muscles")
    ap.add_argument("--mirror-muscles", action="store_true", help="retourner l'image muscles (générée depuis la même moitié que le squelette)")
    ap.add_argument("--out")
    ap.add_argument("--x0", type=int, default=1400)
    ap.add_argument("--y0", type=int, default=520)
    ap.add_argument("--w", type=int, default=780)
    ap.add_argument("--h", type=int, default=1340)
    a = ap.parse_args(argv)
    outdir = ROOT / "out"
    outdir.mkdir(exist_ok=True)
    if a.cmd == "compose":
        L = Image.open(a.skeleton).convert("RGB")
        R = Image.open(a.muscles).convert("RGB").resize(L.size, Image.LANCZOS)
        if a.mirror_muscles:
            R = ImageOps.mirror(R)
        gap = 14
        out = Image.new("RGB", (L.width * 2 + gap, L.height), (245, 245, 245))
        out.paste(L, (0, 0))
        out.paste(R, (L.width + gap, 0))
        p = a.out or str(ROOT / "assets" / "anatomie-squelette-muscles.png")
        out.save(p)
        print(f"{p}  {out.size}  split_x={L.width}")
        return
    s = Studio(ROOT, a.photo_config)
    if a.cmd == "grid":
        im = s.img.crop((a.x0, a.y0, a.x0 + a.w, a.y0 + a.h)).convert("RGB")
        d = ImageDraw.Draw(im)
        f = font("Bold", 16)
        for x in range(0, a.w, 50):
            d.line([(x, 0), (x, a.h)], fill=(255, 255, 0), width=1)
            if x % 100 == 0:
                d.text((x + 2, 2), str(x + a.x0), font=f, fill=(255, 255, 0))
        for y in range(0, a.h, 50):
            d.line([(0, y), (a.w, y)], fill=(255, 255, 0), width=1)
            if y % 100 == 0:
                d.text((2, y + 2), str(y + a.y0), font=f, fill=(255, 255, 0))
        p = outdir / "grid.jpg"
        im.save(p)
        print(p)
    if a.cmd == "check":
        im = s.img.copy()
        for k in s.masks:
            im = s.highlighted(k, 0.6)
            s.img_tmp = im
        p = outdir / "check.jpg"
        base = s.img.copy()
        for k in s.masks:
            s.img = base if False else s.img
        comp = base
        for k in s.masks:
            comp = s.highlighted(k, 0.55, base=comp)
        d = ImageDraw.Draw(comp)
        for k, c in s.centroids.items():
            d.text(c, k, font=font("Bold", 28), fill=(255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0))
        comp.save(p, quality=90)
        print(p)
    if a.cmd in ("still", "all"):
        print(s.still(str(outdir / "anatomie-legendee.png")))
    if a.cmd in ("gif", "all"):
        p, dur = render_gif(s, str(outdir / "anatomie-muscles.gif"))
        print(f"{p}  ({dur:.1f} s)")
    if a.cmd in ("mp4", "all"):
        f = Film(s)
        print(f"Vidéo {f.total:.1f} s…")
        print(f.render(str(outdir / "anatomie-du-mouvement.mp4")))


if __name__ == "__main__":
    main(sys.argv[1:])
