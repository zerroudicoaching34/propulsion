"""Anatomy studio: a person's photo turned into skeleton | muscles, with animated muscle highlights,
labels, arrows and exercise demos. Outputs: labelled still (PNG), looping GIF, vertical MP4.
"""
from __future__ import annotations

import math
import subprocess
from pathlib import Path

import numpy as np
import yaml
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

FONT_DIR = "/usr/share/fonts/opentype/montserrat/"


def font(weight: str, size: int):
    try:
        return ImageFont.truetype(f"{FONT_DIR}Montserrat-{weight}.otf", size)
    except OSError:
        return ImageFont.load_default(size)


def ease(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return 1 - (1 - x) ** 3


def ease_io(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return 0.5 - 0.5 * math.cos(math.pi * x)


def tw(d, s, f) -> float:
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0]


def wrap(d, text, f, width):
    out, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if tw(d, t, f) <= width:
            cur = t
        else:
            out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out


def fit(d, text, f, width):
    while tw(d, text, f) > width and f.size > 12:
        f = f.font_variant(size=f.size - 2)
    return f


def smooth(poly, samples=6):
    n = len(poly)
    pts = []
    for i in range(n):
        p0, p1, p2, p3 = poly[(i - 1) % n], poly[i], poly[(i + 1) % n], poly[(i + 2) % n]
        for k in range(samples):
            t = k / samples
            pts.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t ** 3) for j in range(2)))
    return pts


class Studio:
    def __init__(self, root: Path, photo_cfg: str, lib_cfg: str = "config/muscles.yaml"):
        self.root = Path(root)
        self.pc = yaml.safe_load((self.root / photo_cfg).read_text())
        self.lib = yaml.safe_load((self.root / lib_cfg).read_text())
        self.st = self.lib["style"]
        self.img = Image.open(self.root / self.pc["image"]).convert("RGB")
        self.W, self.H = self.img.size
        photo = self.root / self.pc["photo"]
        self.photo = self._fit_photo(Image.open(photo).convert("RGB")) if photo.exists() else None
        self.masks = {k: self._mask(v) for k, v in self.pc["zones"].items() if v}
        # anchor points: main polygon (first listed) for arrows, every polygon for labels
        self.poly_centroids = {k: [self._poly_centroid(p) for p in v] for k, v in self.pc["zones"].items() if v}
        self.centroids = {k: c[0] for k, c in self.poly_centroids.items()}

    @staticmethod
    def _poly_centroid(poly):
        sp = smooth(poly)
        a = cx = cy = 0.0
        for (x0, y0), (x1, y1) in zip(sp, sp[1:] + sp[:1]):
            c = x0 * y1 - x1 * y0
            a += c
            cx += (x0 + x1) * c
            cy += (y0 + y1) * c
        a *= 0.5
        return (cx / (6 * a), cy / (6 * a)) if abs(a) > 1e-6 else tuple(np.mean(poly, axis=0))

    def _fit_photo(self, ph: Image.Image) -> Image.Image:
        """Scale the original mirrored photo to the composite's geometry (each half matched separately)."""
        sx = self.pc.get("split_x", self.W // 2)
        pw = ph.width
        lh = ph.crop((0, 0, pw // 2 - 3, ph.height)).resize((sx - 7, self.H), Image.LANCZOS)
        rh = ph.crop((pw // 2 + 3, 0, pw, ph.height)).resize((self.W - sx - 7, self.H), Image.LANCZOS)
        out = Image.new("RGB", (self.W, self.H), (245, 245, 245))
        out.paste(lh, (0, 0))
        out.paste(rh, (sx + 7, 0))
        return out

    def _mask(self, polys) -> Image.Image:
        m = Image.new("L", (self.W, self.H), 0)
        d = ImageDraw.Draw(m)
        for p in polys:
            d.polygon(smooth(p), fill=255)
        return m.filter(ImageFilter.GaussianBlur(6))

    # ------------------------------------------------------------ core compositing (in image space)
    def highlighted(self, key: str | None, amount: float, dim_rest: float = 0.0, base: Image.Image | None = None) -> Image.Image:
        im = (base or self.img).copy()
        if key and key in self.masks and amount > 0:
            m = self.masks[key]
            if dim_rest > 0:
                dark = Image.blend(im, Image.new("RGB", im.size, (0, 0, 0)), 0.45 * dim_rest)
                im = Image.composite(im, dark, m.point(lambda v: min(255, int(v * 1.6))))
            hl = Image.new("RGB", im.size, tuple(self.st["highlight"]))
            glow = Image.composite(hl, im, m)
            im = Image.blend(im, glow, 0.62 * amount)
            # luminous rim
            edge = m.filter(ImageFilter.FIND_EDGES).point(lambda v: min(255, v * 6)).filter(ImageFilter.GaussianBlur(3))
            im = Image.composite(Image.new("RGB", im.size, (255, 140, 120)), im, edge.point(lambda v: int(v * amount)))
        return im

    def reveal(self, t: float) -> Image.Image:
        """Photo -> anatomy transition: a glowing scan line descends and reveals the anatomy."""
        if self.photo is None:
            return self.img.copy()
        y = int(ease_io(t) * (self.H + 80)) - 40
        m = Image.new("L", (self.W, self.H), 0)
        ImageDraw.Draw(m).rectangle([0, 0, self.W, max(0, y)], fill=255)
        m = m.filter(ImageFilter.GaussianBlur(14))
        im = Image.composite(self.img, self.photo, m)
        d = ImageDraw.Draw(im)
        if 0 < y < self.H:
            c = tuple(self.st["arrow"])
            for k, a in ((14, 60), (6, 140), (2, 255)):
                d.rectangle([0, y - k, self.W, y + k], fill=tuple(int(cc * a / 255 + 255 * (1 - a / 255) * 0.15) for cc in c))
        return im

    # ------------------------------------------------------------ overlay helpers (output space)
    def arrow(self, d, p0, p1, prog: float, width: int = 5):
        c = tuple(self.st["arrow"])
        if prog <= 0:
            return
        # gentle curve via quadratic bezier
        mid = ((p0[0] + p1[0]) / 2 + (p1[1] - p0[1]) * 0.15, (p0[1] + p1[1]) / 2 - (p1[0] - p0[0]) * 0.15)
        pts = []
        n = 40
        for k in range(int(n * prog) + 1):
            t = k / n
            pts.append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * mid[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * mid[1] + t * t * p1[1]))
        if len(pts) > 1:
            d.line(pts, fill=c + (255,), width=width, joint="curve")
            a, b = pts[-2], pts[-1]
            ang = math.atan2(b[1] - a[1], b[0] - a[0])
            if prog > 0.95:
                hs = 22
                d.polygon([b, (b[0] - hs * math.cos(ang - 0.45), b[1] - hs * math.sin(ang - 0.45)), (b[0] - hs * math.cos(ang + 0.45), b[1] - hs * math.sin(ang + 0.45))], fill=(255, 255, 255, 255))
                d.ellipse([b[0] - 10, b[1] - 10, b[0] + 10, b[1] + 10], outline=(255, 255, 255, 255), width=3)
        d.ellipse([p0[0] - 7, p0[1] - 7, p0[0] + 7, p0[1] + 7], fill=c + (255,))

    def chip(self, d, x, y, text, f, alpha=1.0, anchor="left"):
        w = tw(d, text, f) + 36
        h = f.size + 28
        if anchor == "center":
            x -= w / 2
        elif anchor == "right":
            x -= w
        a = int(255 * alpha)
        d.rounded_rectangle([x, y, x + w, y + h], radius=14, fill=(10, 10, 14, int(215 * alpha)), outline=tuple(self.st["highlight"]) + (a,), width=3)
        d.text((x + 18, y + 12), text, font=f, fill=(255, 255, 255, a))
        return x, y, w, h

    # ------------------------------------------------------------ outputs
    def still(self, out: str, scale: float = 1.0):
        """High-res labelled still: every visible muscle with leader lines on the muscle side."""
        im = self.img.copy().convert("RGBA")
        ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        f = font("ExtraBold", 34)
        anchors = {k: max(self.poly_centroids[k], key=lambda c: c[0]) for k in self.lib["muscles"] if k in self.masks}
        keys = sorted(anchors, key=lambda k: anchors[k][1])
        right_x = self.W - 40
        ys = np.linspace(self.H * 0.30, self.H * 0.72, len(keys))
        for k, y in zip(keys, ys):
            c = anchors[k]
            m = self.lib["muscles"][k]
            x, yy, w, h = self.chip(d, right_x, y, m["name"], f, 1.0, "right")
            d.line([(x, yy + h / 2), (x - 60, yy + h / 2), c], fill=tuple(self.st["arrow"]) + (255,), width=4)
            d.ellipse([c[0] - 9, c[1] - 9, c[0] + 9, c[1] + 9], fill=(255, 255, 255, 255))
        fl = font("Black", 64)
        for s, x in (("SQUELETTE", self.W * 0.25), ("MUSCLES", self.W * 0.75)):
            d.text((x - tw(d, s, fl) / 2, 60), s, font=fl, fill=(255, 255, 255, 255), stroke_width=6, stroke_fill=(10, 10, 14, 230))
        im.alpha_composite(ov)
        if scale != 1:
            im = im.resize((int(self.W * scale), int(self.H * scale)), Image.LANCZOS)
        im.convert("RGB").save(out)
        return out


# ====================================================================== video / gif
OW, OH, FPS = 1080, 1920, 30
VIEW_Y, VIEW_H = 300, 1075


class Clip:
    def __init__(self, path: Path, size: tuple[int, int]):
        w, h = size
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"fps={FPS},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
        n = len(raw) // (w * h * 3)
        self.frames = [Image.frombytes("RGB", (w, h), raw[i * w * h * 3:(i + 1) * w * h * 3]) for i in range(n)]

    def at(self, t: float) -> Image.Image:
        return self.frames[min(len(self.frames) - 1, max(0, int(t * FPS)))]


class Film:
    def __init__(self, studio: Studio):
        self.s = studio
        v = studio.lib["video"]
        self.F = {"brand": font("Bold", 30), "title": font("Black", 76), "sub": font("ExtraBold", 36), "name": font("Black", 54),
                  "func": font("SemiBold", 34), "ex": font("ExtraBold", 28), "chip": font("ExtraBold", 40), "small": font("SemiBold", 22), "quick": font("Black", 50)}
        self.clips = {}
        for k in v["featured"]:
            ex = studio.lib["exercises"][studio.lib["muscles"][k]["exercise"]]
            if ex.get("clip") and (studio.root / ex["clip"]).exists():
                self.clips[k] = Clip(studio.root / ex["clip"], (252, 448))
        # timeline
        self.segs = [("intro", 2.5, None), ("reveal", 3.5, None), ("hold", 1.4, None)]
        self.segs += [("featured", 5.6, k) for k in v["featured"] if k in studio.masks]
        self.segs += [("quick", 0.9, k) for k in v["quick"] if k in studio.masks]
        self.segs += [("outro", 3.6, None)]
        self.total = sum(d for _, d, _ in self.segs)
        sx = studio.pc.get("split_x", studio.W // 2)
        self.full = (0, 0, studio.W, studio.H)
        bw = 1400
        self.torso = (sx + 10, 760, sx + 10 + bw, 760 + bw * VIEW_H / OW)

    def zoom_box(self, key):
        cx, cy = self.s.centroids[key]
        bw = 1050
        bh = bw * VIEW_H / OW
        sx = self.s.pc.get("split_x", self.s.W // 2)
        x0 = min(max(cx - bw / 2, sx + 7), self.s.W - bw)
        y0 = min(max(cy - bh / 2, 0), self.s.H - bh)
        return (x0, y0, x0 + bw, y0 + bh)

    def seg_at(self, t):
        acc = 0.0
        for i, (kind, d, key) in enumerate(self.segs):
            if t < acc + d or i == len(self.segs) - 1:
                return i, kind, key, t - acc, d
            acc += d

    def box_for(self, i):
        kind, _, key = self.segs[i]
        if kind == "featured":
            return self.zoom_box(key)
        if kind == "quick":
            return self.torso
        return self.full

    @staticmethod
    def lerp_box(a, b, k):
        return tuple(a[j] + (b[j] - a[j]) * k for j in range(4))

    def view(self, base: Image.Image, box, key=None, amount=0.0, dim=0.0) -> Image.Image:
        crop = base.resize((OW, VIEW_H), Image.BICUBIC, box=box)
        if key and amount > 0 and key in self.s.masks:
            m = self.s.masks[key].resize((OW, VIEW_H), Image.BILINEAR, box=box)
            if dim > 0:
                dark = Image.blend(crop, Image.new("RGB", crop.size, (0, 0, 0)), 0.5 * dim)
                crop = Image.composite(crop, dark, m.point(lambda v: min(255, int(v * 1.6))))
            glow = Image.composite(Image.new("RGB", crop.size, tuple(self.s.st["highlight"])), crop, m)
            crop = Image.blend(crop, glow, 0.6 * amount)
            edge = m.filter(ImageFilter.FIND_EDGES).point(lambda v: min(255, v * 7)).filter(ImageFilter.GaussianBlur(2))
            crop = Image.composite(Image.new("RGB", crop.size, (255, 150, 130)), crop, edge.point(lambda v: int(v * amount)))
        return crop

    def to_out(self, p, box):
        return ((p[0] - box[0]) * OW / (box[2] - box[0]), VIEW_Y + (p[1] - box[1]) * VIEW_H / (box[3] - box[1]))

    def frame(self, t: float) -> Image.Image:
        s, st = self.s, self.s.st
        i, kind, key, lt, dur = self.seg_at(t)
        prev_box = self.box_for(i - 1) if i > 0 else self.full
        box = self.lerp_box(prev_box, self.box_for(i), ease_io(lt / (0.8 if kind == "featured" else 0.35 if kind == "quick" else 0.9)))
        canvas = Image.new("RGB", (OW, OH), tuple(st["background"]))
        if kind == "intro":
            base = s.photo or s.img
            amount = 0
        elif kind == "reveal":
            base = s.reveal(lt / dur)
            amount = 0
        else:
            base = s.img
        if kind == "featured":
            amount = ease(lt / 0.6) * (0.85 + 0.15 * math.sin(lt * 5))
            view = self.view(base, box, key, amount, ease(lt / 0.6))
        elif kind == "quick":
            amount = ease(lt / 0.2)
            view = self.view(base, box, key, amount, amount)
        else:
            view = self.view(base, box)
        canvas.paste(view, (0, VIEW_Y))
        ov = Image.new("RGBA", (OW, OH), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        white, sec, hl, ac = (255, 255, 255), tuple(st["secondary"]), tuple(st["highlight"]), tuple(st["arrow"])
        # header
        d.text((48, 64), "SMART & STRONG", font=self.F["brand"], fill=(201, 162, 75, 255))
        title = "ANATOMIE DU MOUVEMENT"
        if kind in ("intro", "reveal", "hold", "outro"):
            a = ease(t / 0.6) if kind == "intro" else 1.0
            ft = fit(d, title, self.F["title"], OW - 80)
            d.text(((OW - tw(d, title, ft)) / 2, 130 + (1 - a) * 20), title, font=ft, fill=white + (int(255 * a),))
            sub = {"intro": "TA PHOTO, TON ANATOMIE", "reveal": "SQUELETTE  ·  MUSCLES", "hold": "SQUELETTE  ·  MUSCLES", "outro": "CHAQUE MUSCLE A SON RÔLE"}[kind]
            d.text(((OW - tw(d, sub, self.F["sub"])) / 2, 222), sub, font=self.F["sub"], fill=sec + (int(255 * a),))
        else:
            m = s.lib["muscles"][key]
            d.text(((OW - tw(d, title, self.F["sub"])) / 2, 130), title, font=self.F["sub"], fill=sec + (255,))
        if kind in ("hold", "reveal") and (kind == "hold" or lt > dur * 0.6):
            a = ease(lt / 0.4) if kind == "hold" else ease((lt - dur * 0.6) / 0.4)
            for label, cx in (("SQUELETTE", OW * 0.25), ("MUSCLES", OW * 0.75)):
                w = tw(d, label, self.F["ex"]) + 36
                d.rounded_rectangle([cx - w / 2, VIEW_Y + 24, cx + w / 2, VIEW_Y + 76], radius=26, fill=(10, 10, 14, int(200 * a)), outline=ac + (int(255 * a),), width=3)
                d.text((cx - w / 2 + 18, VIEW_Y + 34), label, font=self.F["ex"], fill=white + (int(255 * a),))
        if kind == "featured":
            m = s.lib["muscles"][key]
            ex = s.lib["exercises"][m["exercise"]]
            a = ease((lt - 0.5) / 0.4)
            # info card
            cx0, cy0 = 40, VIEW_Y + VIEW_H + 30
            d.rounded_rectangle([cx0, cy0, cx0 + 700, cy0 + 400], radius=26, fill=(10, 10, 14, int(225 * a)), outline=hl + (int(220 * a),), width=3)
            yy = cy0 + 28
            for line in wrap(d, m["name"], self.F["name"], 630):
                d.text((cx0 + 28, yy), line, font=self.F["name"], fill=hl + (int(255 * a),))
                yy += 64
            yy += 8
            for line in wrap(d, m["function"], self.F["func"], 630):
                d.text((cx0 + 28, yy), line, font=self.F["func"], fill=white + (int(255 * ease((lt - 0.9) / 0.4)),))
                yy += 44
            ea = int(255 * ease((lt - 1.3) / 0.4))
            d.text((cx0 + 28, cy0 + 312), "EXEMPLE D'EXERCICE", font=self.F["small"], fill=sec + (ea,))
            d.text((cx0 + 28, cy0 + 342), ex["name"], font=self.F["ex"], fill=ac + (ea,))
            # arrow from card to muscle
            target = self.to_out(s.centroids[key], box)
            self.arrow_draw(d, (cx0 + 60, cy0 - 4), target, ease((lt - 0.7) / 0.6))
        if kind == "quick":
            m = s.lib["muscles"][key]
            a = ease(lt / 0.2)
            target = self.to_out(s.centroids[key], box)
            y0 = VIEW_Y + VIEW_H + 60
            w = tw(d, m["name"], self.F["quick"])
            d.text(((OW - w) / 2, y0), m["name"], font=self.F["quick"], fill=hl + (int(255 * a),))
            for j, line in enumerate(wrap(d, m["function"], self.F["func"], OW - 160)):
                d.text(((OW - tw(d, line, self.F["func"])) / 2, y0 + 76 + j * 44), line, font=self.F["func"], fill=white + (int(255 * a),))
            ex = s.lib["exercises"][m["exercise"]]["name"]
            d.text(((OW - tw(d, "EXEMPLE : " + ex, self.F["ex"])) / 2, y0 + 190), "EXEMPLE : " + ex, font=self.F["ex"], fill=ac + (int(255 * a),))
            self.arrow_draw(d, (OW / 2, y0 - 10), target, ease(lt / 0.35))
        if kind == "outro":
            a = ease((lt - 0.6) / 0.6)
            sig = st["signature"]
            fs = fit(d, sig, font("Black", 44), OW - 80)
            d.text(((OW - tw(d, sig, fs)) / 2, VIEW_Y + VIEW_H + 80), sig, font=fs, fill=(201, 162, 75, int(255 * a)))
            note = "Les exercices sollicitent ces muscles parmi d'autres : ils ne les isolent pas."
            for j, line in enumerate(wrap(d, note, self.F["func"], OW - 140)):
                d.text(((OW - tw(d, line, self.F["func"])) / 2, VIEW_Y + VIEW_H + 170 + j * 44), line, font=self.F["func"], fill=sec + (int(255 * a),))
        # footer
        disc = st["disclaimer"]
        d.text(((OW - tw(d, disc, self.F["small"])) / 2, OH - 48), disc, font=self.F["small"], fill=sec + (200,))
        d.rectangle([0, OH - 10, OW, OH], fill=(40, 40, 46, 255))
        d.rectangle([0, OH - 10, int(OW * min(1, t / self.total)), OH], fill=(201, 162, 75, 255))
        out = canvas.convert("RGBA")
        out.alpha_composite(ov)
        if kind == "featured" and key in self.clips:
            ca = ease((lt - 0.9) / 0.4)
            if ca > 0:
                fr = self.clips[key].at(max(0.0, lt - 0.9)).convert("RGBA")
                mask = Image.new("L", fr.size, 0)
                ImageDraw.Draw(mask).rounded_rectangle([0, 0, fr.width - 1, fr.height - 1], radius=22, fill=int(255 * ca))
                x, y = OW - 40 - fr.width, VIEW_Y + VIEW_H + 18
                out.paste(fr, (x, y), mask)
                ImageDraw.Draw(out).rounded_rectangle([x, y, x + fr.width, y + fr.height], radius=22, outline=tuple(st["arrow"]) + (int(255 * ca),), width=3)
        return out.convert("RGB")

    def arrow_draw(self, d, p0, p1, prog):
        self.s.arrow(d, p0, p1, prog)

    def render(self, out: str):
        n = int(math.ceil(self.total * FPS))
        p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{OW}x{OH}", "-r", str(FPS), "-i", "-",
                              "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
        for k in range(n):
            p.stdin.write(self.frame(k / FPS).tobytes())
        p.stdin.close()
        if p.wait():
            raise RuntimeError("ffmpeg")
        return out


def render_gif(studio: Studio, out: str, size: int = 720, fps: int = 15, per: float = 1.3):
    """Looping GIF: successive muscle highlights with name + arrow on the full composite."""
    seq = [k for k in studio.lib["gif"]["sequence"] if k in studio.masks]
    total = 0.4 + per * len(seq) + 0.4
    W = size
    H = int(size * studio.H / studio.W)
    base = studio.img.resize((W, H), Image.LANCZOS)
    masks = {k: studio.masks[k].resize((W, H), Image.BILINEAR) for k in seq}
    sc = W / studio.W
    fn, ff = font("Black", 30), font("SemiBold", 17)
    frames = []
    for i in range(int(total * fps)):
        t = i / fps
        im = base.copy()
        j = int((t - 0.4) // per)
        if 0 <= j < len(seq) and t >= 0.4:
            k = seq[j]
            lt = (t - 0.4) - j * per
            a = ease(lt / 0.25) * (1 - ease((lt - per + 0.25) / 0.25))
            glow = Image.composite(Image.new("RGB", im.size, tuple(studio.st["highlight"])), im, masks[k])
            im = Image.blend(im, glow, 0.62 * a)
            d = ImageDraw.Draw(im, "RGBA")
            m = studio.lib["muscles"][k]
            cx, cy = studio.centroids[k][0] * sc, studio.centroids[k][1] * sc
            tx = W - 24
            ty = H * 0.80
            w = tw(d, m["name"], fn) + 28
            al = int(255 * a)
            d.rounded_rectangle([tx - w, ty, tx, ty + 46], radius=10, fill=(10, 10, 14, int(220 * a)), outline=tuple(studio.st["highlight"]) + (al,), width=2)
            d.text((tx - w + 14, ty + 7), m["name"], font=fn, fill=(255, 255, 255, al))
            fl = m["function"]
            d.text((tx - tw(d, fl, ff), ty + 54), fl, font=ff, fill=(220, 220, 228, al))
            studio.arrow(d, (tx - w / 2, ty - 4), (cx, cy), ease(lt / 0.4), width=3)
        d = ImageDraw.Draw(im, "RGBA")
        sig = studio.st["signature"]
        d.text(((W - tw(d, sig, ff)) / 2, H - 30), sig, font=ff, fill=(201, 162, 75, 255))
        frames.append(im)
    tmp = Path(out).with_suffix(".frames")
    tmp.mkdir(exist_ok=True)
    for i, f in enumerate(frames):
        f.save(tmp / f"f{i:04d}.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-i", str(tmp / "f%04d.png"), "-vf",
                    "split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a", "-loop", "0", out], check=True)
    for f in tmp.iterdir():
        f.unlink()
    tmp.rmdir()
    return out, total
