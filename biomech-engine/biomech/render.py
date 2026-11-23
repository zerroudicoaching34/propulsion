"""Renderer: real video (dimmed) + body-attached anatomical overlays + pedagogical layers -> MP4.

Everything is driven by the exercise YAML (muscles, scenes, texts, colours) and the tracking /
analysis data. Rendering is frame by frame with Pillow; FFmpeg encodes the result.
"""
from __future__ import annotations

import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1080, 1920, 30
FONT_DIR = "/usr/share/fonts/opentype/montserrat/"


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    for path in (f"{FONT_DIR}Montserrat-{weight}.otf", f"/usr/share/fonts/truetype/montserrat/Montserrat-{weight}.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def ease(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return 1 - (1 - x) ** 3


def tw(d: ImageDraw.ImageDraw, s: str, f) -> float:
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0]


def wrap(d, text: str, f, width: float) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        t = (cur + " " + word).strip()
        if tw(d, t, f) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def catmull_closed(pts: list[tuple[float, float]], samples: int = 8) -> list[tuple[float, float]]:
    n = len(pts)
    if n < 3:
        return pts
    out = []
    for i in range(n):
        p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        for k in range(samples):
            t = k / samples
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(2)))
    return out


# ---------------------------------------------------------------- timeline
@dataclass
class Shot:
    scene: dict
    index: int
    src_start: float  # seconds in the source video
    src_end: float
    speed: float

    @property
    def duration(self) -> float:
        return (self.src_end - self.src_start) / self.speed


def build_timeline(scenes: list[dict], reps: list[dict], fps_src: float, min_speed: float = 0.35) -> list[Shot]:
    if not reps:
        raise RuntimeError("Aucune répétition détectée : vérifiez la vidéo ou min_rep_range.")
    shots = []
    for i, sc in enumerate(scenes):
        rep = reps[sc.get("rep", i) % len(reps)]
        a, b = rep["start"] / fps_src, rep["end"] / fps_src
        speed = sc.get("speed") or max(min_speed, min(1.0, (b - a) / sc.get("target", b - a)))
        shots.append(Shot(sc, i, a, b, speed))
    return shots


# ---------------------------------------------------------------- engine
class Renderer:
    def __init__(self, video: str, tracking: dict, analysis: dict, cfg: dict, audio: str | None = None):
        self.cfg = cfg
        self.style = cfg.get("style", {})
        self.tracking = tracking
        self.an = analysis
        self.lm = tracking["landmarks"]
        self.der = tracking["derived"]
        self.fps_src = tracking["video"]["fps"]
        self.n_src = tracking["video"]["frames"]
        self.video = video
        self.audio = audio
        self.shots = build_timeline(cfg["scenes"], analysis["reps"], self.fps_src)
        self.total = sum(s.duration for s in self.shots)
        self._frames = self._load_frames()
        sw, sh = tracking["video"]["width"], tracking["video"]["height"]
        self.scale = max(W / sw, H / sh)
        self.ox = (W - sw * self.scale) / 2
        self.oy = (H - sh * self.scale) / 2
        self.muscles = {m["id"]: m for m in cfg.get("muscles", [])}
        self.vignette = self._make_vignette()
        self.F = {
            "title": font("Black", 86), "sub": font("ExtraBold", 34), "head": font("ExtraBold", 44), "body": font("SemiBold", 34),
            "label": font("ExtraBold", 28), "role": font("Medium", 22), "chip": font("ExtraBold", 30), "angle": font("Black", 54),
            "small": font("SemiBold", 22), "sig": font("Bold", 26), "note": font("Bold", 34),
        }
        self.trail: dict[str, list] = {}

    # ---------------------------------------------------------- sources
    def _load_frames(self) -> list[np.ndarray]:
        cap = cv2.VideoCapture(self.video)
        out = []
        while True:
            ok, f = cap.read()
            if not ok:
                break
            out.append(f)
        cap.release()
        return out

    def _make_vignette(self) -> Image.Image:
        v = self.style.get("vignette", 0.5)
        yy, xx = np.mgrid[0:H, 0:W]
        d = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
        mask = np.clip((d - 0.55) / 0.75, 0, 1) * v
        return Image.fromarray((mask * 255).astype(np.uint8), "L")

    def background(self, t_src: float) -> Image.Image:
        f = t_src * self.fps_src
        i0 = int(np.clip(math.floor(f), 0, len(self._frames) - 1))
        i1 = min(i0 + 1, len(self._frames) - 1)
        a = f - math.floor(f)
        fr = self._frames[i0] if a < 0.01 else cv2.addWeighted(self._frames[i0], 1 - a, self._frames[i1], a, 0)
        rgb = cv2.cvtColor(fr, cv2.COLOR_BGR2RGB).astype(np.float32)
        gray = rgb.mean(axis=2, keepdims=True)
        ds = self.style.get("desaturate", 0.3)
        rgb = rgb * (1 - ds) + gray * ds
        rgb *= self.style.get("dim", 0.55)
        img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
        img = img.resize((round(img.width * self.scale), round(img.height * self.scale)), Image.BICUBIC)
        canvas = Image.new("RGB", (W, H), (0, 0, 0))
        canvas.paste(img, (round(self.ox), round(self.oy)))
        canvas.paste(Image.new("RGB", (W, H), (0, 0, 0)), (0, 0), self.vignette)
        return canvas.convert("RGBA")

    # ---------------------------------------------------------- keypoints at fractional time (output coords)
    def P(self, name: str, t_src: float) -> np.ndarray:
        arr = self.der[name] if name in self.der else self.lm[name][:, :2]
        f = np.clip(t_src * self.fps_src, 0, len(arr) - 1)
        i0 = int(math.floor(f))
        i1 = min(i0 + 1, len(arr) - 1)
        a = f - i0
        p = arr[i0] * (1 - a) + arr[i1] * a
        return np.array([p[0] * self.scale + self.ox, p[1] * self.scale + self.oy])

    def series(self, arr: np.ndarray, t_src: float) -> float:
        f = np.clip(t_src * self.fps_src, 0, len(arr) - 1)
        i0 = int(math.floor(f))
        i1 = min(i0 + 1, len(arr) - 1)
        return float(arr[i0] * (1 - (f - i0)) + arr[i1] * (f - i0))

    def phase(self, t_src: float) -> str:
        return self.an["phase"][int(np.clip(round(t_src * self.fps_src), 0, len(self.an["phase"]) - 1))]

    def frame_basis(self, kind: str, side: str, t: float):
        sh = self.P(f"{side}_shoulder", t)
        if kind == "upper_arm":
            el = self.P(f"{side}_elbow", t)
            x = el - sh
            perp = np.array([-x[1], x[0]])
            outward = sh - self.P("neck", t)
            superior = sh - self.P(f"{side}_hip", t)
            if np.dot(perp, outward / (np.linalg.norm(outward) + 1e-6)) + np.dot(perp, superior / (np.linalg.norm(superior) + 1e-6)) < 0:
                perp = -perp
            return sh, x, perp
        if kind == "trunk":
            return sh, self.P("neck", t) - sh, self.P(f"{side}_hip", t) - sh
        raise ValueError(kind)

    def to_px(self, pt, anchor: str, side: str, t: float) -> tuple[float, float]:
        if isinstance(pt[0], str):
            anchor, pt = pt[0], pt[1:]
        o, ex, ey = self.frame_basis(anchor, side, t)
        q = o + ex * pt[0] + ey * pt[1]
        return float(q[0]), float(q[1])

    # ---------------------------------------------------------- drawing primitives
    def draw_muscle(self, frame: Image.Image, m: dict, side: str, t: float, alpha: float, focus: bool) -> tuple[float, float] | None:
        if m.get("depth") == "inset_only" or not m.get("shape") or alpha <= 0:
            return None
        pts = [self.to_px(p, m["anchor"], side, t) for p in m["shape"]]
        poly = catmull_closed(pts, 8)
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        x0, y0, x1, y1 = int(min(xs)) - 4, int(min(ys)) - 4, int(max(xs)) + 5, int(max(ys)) + 5
        if x1 - x0 < 3 or y1 - y0 < 3:
            return None
        col = tuple(m["color"])
        deep = m.get("depth") == "deep"
        local = [(x - x0, y - y0) for x, y in poly]
        mask = Image.new("L", (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(mask).polygon(local, fill=255)
        layer = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        a_fill = (0.22 if deep else 0.34) * (1.25 if focus else 0.75)
        ld.rectangle([0, 0, layer.width, layer.height], fill=col + (int(255 * a_fill * alpha),))
        # fibre hatching oriented along the anchor axis (+ hatch_angle)
        o, ex, ey = self.frame_basis(m["anchor"], side, t)
        base = math.atan2(ex[1], ex[0]) + math.radians(m.get("hatch_angle", 0))
        dx, dy = math.cos(base), math.sin(base)
        nx, ny = -dy, dx
        diag = math.hypot(layer.width, layer.height)
        step = 9 if not deep else 13
        cx, cy = layer.width / 2, layer.height / 2
        for k in range(-int(diag / step), int(diag / step) + 1):
            px, py = cx + nx * k * step, cy + ny * k * step
            ld.line([(px - dx * diag, py - dy * diag), (px + dx * diag, py + dy * diag)], fill=col + (int(255 * (0.75 if focus else 0.5) * alpha),), width=2)
        frame.paste(layer, (x0, y0), Image.composite(layer, Image.new("RGBA", layer.size, (0, 0, 0, 0)), mask).getchannel("A"))
        d = ImageDraw.Draw(frame)
        oc = col + (int(255 * alpha),)
        if deep:  # dashed outline = deep muscle, stylised
            loop = poly + [poly[0]]
            for j in range(0, len(loop) - 1, 2):
                d.line([loop[j], loop[j + 1]], fill=oc, width=3)
        else:
            d.line(poly + [poly[0]], fill=oc, width=3 if focus else 2, joint="curve")
        return float(np.mean(xs)), float(np.mean(ys))

    def cartouche(self, d, x, y, title: str, sub: str | None, col, alpha: float, align: str = "left") -> tuple[float, float, float, float]:
        ft, fs = self.F["label"], self.F["role"]
        w = max(tw(d, title, ft), tw(d, sub, fs) if sub else 0) + 36
        h = 50 + (30 if sub else 0)
        if align == "right":
            x -= w
        a = int(255 * alpha)
        d.rounded_rectangle([x, y, x + w, y + h], radius=12, fill=(12, 12, 16, int(200 * alpha)), outline=tuple(col) + (a,), width=3)
        d.text((x + 18, y + 10), title, font=ft, fill=tuple(col) + (a,))
        if sub:
            d.text((x + 18, y + 46), sub, font=fs, fill=(235, 235, 240, a))
        return x, y, w, h

    # ---------------------------------------------------------- layers
    def layer_trajectory(self, d, t: float, shot: Shot, alpha: float):
        col = tuple(self.style.get("trajectory", [255, 255, 255]))
        for side in self.cfg["analysis"]["sides"]:
            for pname in self.cfg.get("overlays", {}).get("trajectory_points", ["hand"]):
                key = f"{side}_{pname}"
                n = 40
                pts = [self.P(key, shot.src_start + (t - shot.src_start) * k / n) for k in range(n + 1)] if t > shot.src_start else []
                for j in range(0, len(pts) - 1, 2):  # dotted path
                    d.line([tuple(pts[j]), tuple(pts[j + 1])], fill=col + (int(220 * alpha),), width=4)
                if pts:
                    p = pts[-1]
                    d.ellipse([p[0] - 9, p[1] - 9, p[0] + 9, p[1] + 9], outline=col + (int(255 * alpha),), width=3)

    def layer_angle(self, d, t: float, alpha: float):
        ov = self.cfg.get("overlays", {})
        name = ov.get("angle_metric", self.cfg["analysis"]["driver"])
        col = tuple(self.style.get("angle", [255, 255, 255]))
        vals = []
        for side in self.cfg["analysis"]["sides"]:
            sh, el, hip = self.P(f"{side}_shoulder", t), self.P(f"{side}_elbow", t), self.P(f"{side}_hip", t)
            down, arm = hip - sh, el - sh
            r = 0.55 * np.linalg.norm(arm)
            a0 = math.degrees(math.atan2(down[1], down[0]))
            a1 = math.degrees(math.atan2(arm[1], arm[0]))
            delta = (a1 - a0 + 540) % 360 - 180
            start, end = (a0, a0 + delta) if delta >= 0 else (a0 + delta, a0)
            d.arc([sh[0] - r, sh[1] - r, sh[0] + r, sh[1] + r], start, end, fill=col + (int(235 * alpha),), width=4)
            # reference (trunk) and arm rays
            for v in (down, arm):
                u = v / (np.linalg.norm(v) + 1e-6)
                d.line([tuple(sh), tuple(sh + u * r * 1.25)], fill=col + (int(140 * alpha),), width=2)
            d.ellipse([sh[0] - 7, sh[1] - 7, sh[0] + 7, sh[1] + 7], fill=col + (int(255 * alpha),))
            vals.append(self.series(self.an["metrics"][f"{side}:{name}"], t))
        return float(np.mean(vals)) if vals else None

    def layer_lever(self, d, t: float, alpha: float):
        acc = tuple(self.style.get("accent", [201, 162, 75]))
        vals = []
        for side in self.cfg["analysis"]["sides"]:
            sh, hand = self.P(f"{side}_shoulder", t), self.P(f"{side}_hand", t)
            a = int(255 * alpha)
            # vertical through the shoulder, horizontal to the load = external moment arm
            d.line([(sh[0], sh[1] - 40), (sh[0], hand[1] + 40)], fill=(255, 255, 255, int(110 * alpha)), width=2)
            foot = (sh[0], hand[1])
            x0, x1 = sorted([foot[0], hand[0]])
            for xx in np.arange(x0, x1, 18):
                d.line([(xx, hand[1]), (min(xx + 10, x1), hand[1])], fill=acc + (a,), width=5)
            # gravity on the dumbbell
            d.line([tuple(hand), (hand[0], hand[1] + 90)], fill=(255, 255, 255, a), width=4)
            d.polygon([(hand[0] - 12, hand[1] + 80), (hand[0] + 12, hand[1] + 80), (hand[0], hand[1] + 104)], fill=(255, 255, 255, a))
            vals.append(self.series(self.an["lever"][side], t))
        return float(np.mean(vals)) if vals else 0.0

    def scapula_inset(self, frame: Image.Image, abd: float, alpha: float, focus: bool):
        cfg = self.cfg.get("overlays", {}).get("scapulohumeral", {"start_deg": 30, "ratio": 2.0})
        st = max(0.0, abd - cfg["start_deg"]) / (cfg["ratio"] + 1)  # scapular share of elevation past start
        pw, ph = 820, 400
        x0, y0 = (W - pw) // 2, 1380
        panel = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
        d = ImageDraw.Draw(panel)
        a = int(255 * alpha)
        d.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=26, fill=(10, 10, 14, int(205 * alpha)), outline=(255, 255, 255, int(90 * alpha)), width=2)
        d.text((22, 16), "SCAPULA · VUE DE DOS (SCHÉMA)", font=self.F["small"], fill=(220, 220, 228, a))
        # torso + spine
        cx, cy = pw * 0.28, ph * 0.58
        d.line([(cx - 120, cy - 120), (cx - 120, cy + 140)], fill=(255, 255, 255, int(70 * alpha)), width=2)
        d.line([(cx - 120, cy - 120), (cx + 130, cy - 120)], fill=(255, 255, 255, int(70 * alpha)), width=2)
        # scapula triangle rotating upward around a point near the scapular spine root
        rot = math.radians(-st)
        def R(px, py, ox=cx, oy=cy - 40):
            dx, dy = px - ox, py - oy
            return (ox + dx * math.cos(rot) - dy * math.sin(rot), oy + dx * math.sin(rot) + dy * math.cos(rot))
        sup, acr, inf = R(cx - 60, cy - 105), R(cx + 75, cy - 95), R(cx - 45, cy + 95)
        d.polygon([sup, acr, inf], fill=(255, 255, 255, int(40 * alpha)), outline=(255, 255, 255, a))
        d.line([R(cx - 58, cy - 70), acr], fill=(255, 255, 255, a), width=3)  # spine of scapula
        # humerus from the glenoid
        hum_a = math.radians(90 - abd)
        g = acr
        d.line([g, (g[0] + 150 * math.cos(hum_a), g[1] + 150 * math.sin(hum_a))], fill=(240, 104, 88, a), width=9)
        # force couple: upper trap (up-medial at acromion), lower trap (down-medial at spine root), serratus (lateral at inferior angle)
        yel, tur = tuple(self.muscles.get("trapeze_superieur", {}).get("color", [245, 205, 70])), tuple(self.muscles.get("dentele_anterieur", {}).get("color", [60, 205, 185]))
        def arrow(p, v, col):
            q = (p[0] + v[0], p[1] + v[1])
            d.line([p, q], fill=col + (a,), width=6)
            ang = math.atan2(v[1], v[0])
            d.polygon([q, (q[0] - 18 * math.cos(ang - 0.5), q[1] - 18 * math.sin(ang - 0.5)), (q[0] - 18 * math.cos(ang + 0.5), q[1] - 18 * math.sin(ang + 0.5))], fill=col + (a,))
        k = 0.4 + 0.6 * min(1.0, st / 20)
        arrow(acr, (-35 * k, -55 * k), yel)
        spine_root = R(cx - 58, cy - 70)
        arrow(spine_root, (-10 * k, 60 * k), yel)
        arrow(inf, (60 * k, -12 * k), tur)
        lx = pw * 0.56
        rows = [("TRAPÈZE SUP.", yel), ("TRAPÈZE INF.", yel), ("DENTELÉ ANT.", tur)]
        for j, (s, c) in enumerate(rows):
            d.ellipse([lx, 92 + j * 46, lx + 18, 110 + j * 46], fill=c + (a,))
            d.text((lx + 28, 86 + j * 46), s, font=self.F["small"], fill=(240, 240, 245, a))
        d.text((lx, 250), f"Bras ≈ {abd:.0f}°", font=self.F["chip"], fill=(255, 255, 255, a))
        d.text((lx, 292), f"Scapula ≈ {st:.0f}°", font=self.F["chip"], fill=yel + (a,))
        d.text((22, ph - 38), "Rotation supérieure : couple trapèzes + dentelé · rythme théorique ≈ 2:1", font=self.F["small"].font_variant(size=20), fill=(200, 200, 210, a))
        frame.alpha_composite(panel, (x0, y0))

    # ---------------------------------------------------------- frame
    def frame(self, t_out: float) -> Image.Image:
        acc = 0.0
        shot = self.shots[-1]
        for s in self.shots:
            if t_out < acc + s.duration:
                shot = s
                break
            acc += s.duration
        local = t_out - acc
        prog = local / shot.duration
        t = min(shot.src_end, shot.src_start + local * shot.speed)
        sc = shot.scene
        show = set(sc.get("show", []))
        fade_in = ease(local / 0.35)
        img = self.background(t)
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        acc_c = tuple(self.style.get("accent", [201, 162, 75]))
        white = (255, 255, 255)

        # --- muscles (body-attached)
        if "muscles" in show:
            focus = set(sc.get("focus", self.muscles.keys()))
            labelled = []
            for mid, m in self.muscles.items():
                is_focus = mid in focus
                alpha = fade_in * (1.0 if is_focus else 0.35)
                cents = [self.draw_muscle(img, m, side, t, alpha, is_focus) for side in self.cfg["analysis"]["sides"]]
                cents = [c for c in cents if c]
                if is_focus and cents and m.get("depth") != "inset_only":
                    labelled.append((m, cents))
            for m, cents in labelled:
                col_side = m.get("label_col", "right")
                y = m.get("label_y", 0.55) * H
                x = 36 if col_side == "left" else W - 36
                bx, by, bw, bh = self.cartouche(d, x, y, m["label"] + (" (profond)" if m.get("depth") == "deep" else ""), m.get("role"), m["color"], fade_in, "left" if col_side == "left" else "right")
                target = min(cents, key=lambda c: abs(c[0] - (bx + bw / 2)))
                anchor_pt = (bx + bw, by + bh / 2) if col_side == "left" else (bx, by + bh / 2)
                d.line([anchor_pt, target], fill=tuple(m["color"]) + (int(230 * fade_in),), width=3)
                d.ellipse([target[0] - 7, target[1] - 7, target[0] + 7, target[1] + 7], fill=tuple(m["color"]) + (int(255 * fade_in),), outline=(10, 10, 14, 255), width=2)

        if "trajectory" in show:
            self.layer_trajectory(d, t, shot, fade_in)
        abd = None
        if "angle" in show or "scapula_inset" in show:
            abd = self.layer_angle(d, t, fade_in if "angle" in show else 0.0)
        lever = self.layer_lever(d, t, fade_in) if "lever" in show else None

        # --- header
        meta = self.cfg["meta"]
        d.text((40, 70), "SMART & STRONG", font=self.F["sig"], fill=acc_c + (255,))
        ft = self.F["title"]
        title = meta["title"]
        while tw(d, title, ft) > W - 80:
            ft = ft.font_variant(size=ft.size - 4)
        if sc.get("id") == "titre" or "title" in show:
            a = fade_in
            d.text(((W - tw(d, title, ft)) / 2, 220 + (1 - a) * 30), title, font=ft, fill=white + (int(255 * a),), stroke_width=4, stroke_fill=(0, 0, 0, int(160 * a)))
            sub = meta.get("subtitle", "")
            d.text(((W - tw(d, sub, self.F["sub"])) / 2, 330 + (1 - a) * 30), sub, font=self.F["sub"], fill=acc_c + (int(255 * a),))
            nr = len(self.an["reps"])
            info = f"{nr} RÉPÉTITIONS ANALYSÉES · VIDÉO RÉELLE"
            d.text(((W - tw(d, info, self.F["small"])) / 2, 386), info, font=self.F["small"], fill=(220, 220, 228, int(220 * ease((local - 0.5) / 0.4))))
        else:
            ft2 = ft.font_variant(size=min(ft.size, 64))
            d.text(((W - tw(d, title, ft2)) / 2, 118), title, font=ft2, fill=white + (255,), stroke_width=3, stroke_fill=(0, 0, 0, 150))
            hl = sc.get("headline", "")
            if hl:
                a = fade_in
                d.text(((W - tw(d, hl, self.F["head"])) / 2, 200 + (1 - a) * 18), hl, font=self.F["head"], fill=acc_c + (int(255 * a),), stroke_width=3, stroke_fill=(0, 0, 0, int(160 * a)))
            y_body = 262
            if sc.get("body"):
                for line in wrap(d, sc["body"], self.F["body"], W - 120):
                    a = ease((local - 0.25) / 0.35)
                    d.text(((W - tw(d, line, self.F["body"])) / 2, y_body), line, font=self.F["body"], fill=white + (int(240 * a),), stroke_width=3, stroke_fill=(0, 0, 0, int(160 * a)))
                    y_body += 44
            # angle readout + phase chip
            row_y = max(y_body + 10, 320)
            if abd is not None and "angle" in show:
                s = f"{self.cfg.get('overlays', {}).get('angle_label', 'ANGLE')} ≈ {abd:.0f}°"
                d.text((48, row_y), s, font=self.F["chip"], fill=white + (int(255 * fade_in),), stroke_width=3, stroke_fill=(0, 0, 0, 170))
                d.text((48, row_y + 40), "estimation 2D", font=self.F["small"], fill=(200, 200, 210, int(220 * fade_in)))
            if "phase" in show:
                ph = self.phase(t)
                labels = {"concentric": ("CONCENTRIQUE ↑", self.style.get("concentric", [240, 104, 88])), "eccentric": ("EXCENTRIQUE ↓", self.style.get("eccentric", [90, 170, 255])),
                          "top": ("TRANSITION HAUTE", [230, 230, 235]), "bottom": ("TRANSITION BASSE", [230, 230, 235])}
                txt, c = labels[ph]
                w2 = tw(d, txt, self.F["chip"]) + 44
                d.rounded_rectangle([W - 48 - w2, row_y - 4, W - 48, row_y + 50], radius=27, fill=tuple(c) + (int(235 * fade_in),))
                d.text((W - 48 - w2 + 22, row_y + 5), txt, font=self.F["chip"], fill=(10, 10, 14, int(255 * fade_in)))
            # synced notes
            for note in sc.get("notes", []):
                if self.phase(t) == note["when"]:
                    lines = wrap(d, note["text"], self.F["note"], W - 160)
                    yy = 1500
                    for line in lines:
                        w2 = tw(d, line, self.F["note"])
                        d.rounded_rectangle([(W - w2) / 2 - 24, yy - 8, (W + w2) / 2 + 24, yy + 46], radius=14, fill=(10, 10, 14, 200))
                        d.text(((W - w2) / 2, yy), line, font=self.F["note"], fill=white + (255,))
                        yy += 62
            if lever is not None:
                gx, gy, gw = 140, 1560, W - 280
                d.text((gx, gy - 52), "BRAS DE LEVIER EXTERNE (relatif, estimé)", font=self.F["small"], fill=white + (230,))
                d.rounded_rectangle([gx, gy, gx + gw, gy + 30], radius=15, fill=(255, 255, 255, 50))
                d.rounded_rectangle([gx, gy, gx + max(30, gw * min(1.0, lever / 0.75)), gy + 30], radius=15, fill=acc_c + (240,))
                d.text((gx, gy + 44), "bras le long du corps : faible", font=self.F["small"], fill=(210, 210, 218, 220))
                s = "bras à l'horizontale : maximal"
                d.text((gx + gw - tw(d, s, self.F["small"]), gy + 44), s, font=self.F["small"], fill=acc_c + (230,))
            if "summary" in show:
                items = sc.get("summary", [])
                pw, ph_ = W - 120, 70 + 58 * len(items)
                x0, y0 = 60, 1440
                d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph_], radius=24, fill=(10, 10, 14, 210), outline=acc_c + (200,), width=2)
                for j, it in enumerate(items):
                    a = ease((local - 0.3 - j * 0.35) / 0.35)
                    d.text((x0 + 30, y0 + 30 + j * 58), "• " + it, font=self.F["body"].font_variant(size=32), fill=white + (int(255 * a),))
        if "scapula_inset" in show and abd is not None:
            img.alpha_composite(ov)
            self.scapula_inset(img, abd, fade_in, True)
            ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            d = ImageDraw.Draw(ov)
        # footer: signature + disclaimer
        sig = meta.get("signature", "")
        last = shot is self.shots[-1]
        if last:
            a = ease((local - shot.duration + 1.6) / 0.5)
            fsig = self.F["title"].font_variant(size=40)
            d.text(((W - tw(d, sig, fsig)) / 2, 1290), sig, font=fsig, fill=acc_c + (int(255 * a),), stroke_width=3, stroke_fill=(0, 0, 0, int(180 * a)))
        d.text(((W - tw(d, sig, self.F["small"])) / 2, H - 92), sig, font=self.F["small"], fill=acc_c + (230,))
        disc = meta.get("disclaimer", "")
        d.text(((W - tw(d, disc, self.F["small"].font_variant(size=18))) / 2, H - 58), disc, font=self.F["small"].font_variant(size=18), fill=(190, 190, 200, 200))
        # progress
        d.rectangle([0, H - 10, W, H], fill=(40, 40, 50, 200))
        d.rectangle([0, H - 10, int(W * min(1, t_out / self.total)), H], fill=acc_c + (255,))
        img.alpha_composite(ov)
        return img.convert("RGB")

    # ---------------------------------------------------------- export
    def render(self, out: str, preview_times: list[float] | None = None, preview_dir: str | None = None, crf: int = 18):
        if preview_times is not None:
            Path(preview_dir).mkdir(parents=True, exist_ok=True)
            paths = []
            for tt in preview_times:
                p = f"{preview_dir}/preview_{tt:05.2f}.png"
                self.frame(tt).save(p)
                paths.append(p)
            return paths
        n = int(math.ceil(self.total * FPS))
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
        if self.audio:
            cmd += ["-i", self.audio, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", out]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for i in range(n):
            proc.stdin.write(self.frame(i / FPS).tobytes())
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("Échec de l'encodage FFmpeg")
        return out
