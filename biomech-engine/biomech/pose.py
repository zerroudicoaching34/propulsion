"""Pose tracking: MediaPipe Pose Landmarker (VIDEO mode) -> smoothed 2D keypoints per frame.

Output (tracking.json):
{
  "video": {...meta...},
  "landmarks": {"left_shoulder": [[x, y, visibility], ...per frame], ...},   # pixel coords
  "derived":   {"left_hand": [[x, y, v], ...], "neck": ..., "mid_hip": ...}
}
Manual corrections (corrections.yaml) are applied after smoothing.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

# MediaPipe Pose landmark indices (33-point model)
LANDMARKS = {
    "nose": 0,
    "left_ear": 7, "right_ear": 8,
    "left_shoulder": 11, "right_shoulder": 12,
    "left_elbow": 13, "right_elbow": 14,
    "left_wrist": 15, "right_wrist": 16,
    "left_pinky": 17, "right_pinky": 18,
    "left_index": 19, "right_index": 20,
    "left_thumb": 21, "right_thumb": 22,
    "left_hip": 23, "right_hip": 24,
    "left_knee": 25, "right_knee": 26,
    "left_ankle": 27, "right_ankle": 28,
}


@dataclass
class VideoMeta:
    path: str
    width: int
    height: int
    fps: float
    frames: int
    rotation: int = 0

    @property
    def duration(self) -> float:
        return self.frames / self.fps


def probe(path: str | Path) -> VideoMeta:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Impossible d'ouvrir la vidéo : {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError("Vidéo illisible")
    h, w = frame.shape[:2]
    return VideoMeta(str(path), w, h, fps, n)


# ---------------------------------------------------------------- smoothing
class OneEuro:
    """One-Euro filter (Casiez et al., 2012): low lag when moving fast, low jitter when still."""

    def __init__(self, fps: float, min_cutoff: float = 1.2, beta: float = 0.02, d_cutoff: float = 1.0):
        self.fps, self.min_cutoff, self.beta, self.d_cutoff = fps, min_cutoff, beta, d_cutoff
        self.x_prev = None
        self.dx_prev = 0.0

    @staticmethod
    def _alpha(cutoff: float, fps: float) -> float:
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau * fps)

    def __call__(self, x: np.ndarray) -> np.ndarray:
        if self.x_prev is None:
            self.x_prev = x.copy()
            return x
        dx = (x - self.x_prev) * self.fps
        a_d = self._alpha(self.d_cutoff, self.fps)
        dx_hat = a_d * dx + (1 - a_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * np.abs(dx_hat)
        a = 1.0 / (1.0 + (1.0 / (2 * math.pi * cutoff)) * self.fps)
        x_hat = a * x + (1 - a) * self.x_prev
        self.x_prev, self.dx_prev = x_hat, dx_hat
        return x_hat


def smooth_track(track: np.ndarray, fps: float, min_cutoff: float, beta: float) -> np.ndarray:
    """Forward-backward One-Euro (zero phase lag) on an (N, 2) track, with gap interpolation."""
    tr = track.copy()
    # interpolate missing (NaN) samples
    for c in range(2):
        col = tr[:, c]
        bad = np.isnan(col)
        if bad.all():
            return tr
        if bad.any():
            idx = np.arange(len(col))
            col[bad] = np.interp(idx[bad], idx[~bad], col[~bad])
    f = OneEuro(fps, min_cutoff, beta)
    fwd = np.array([f(p) for p in tr])
    b = OneEuro(fps, min_cutoff, beta)
    bwd = np.array([b(p) for p in fwd[::-1]])[::-1]
    return bwd


# ---------------------------------------------------------------- detection
def detect(video: str | Path, model: str | Path, min_visibility: float = 0.3, progress=None) -> tuple[VideoMeta, dict]:
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python import vision

    meta = probe(video)
    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model)),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    raw = {name: [] for name in LANDMARKS}
    cap = cv2.VideoCapture(str(video))
    i = 0
    with vision.PoseLandmarker.create_from_options(opts) as lm:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            res = lm.detect_for_video(img, int(round(i * 1000 / meta.fps)))
            h, w = frame.shape[:2]
            if res.pose_landmarks:
                pts = res.pose_landmarks[0]
                for name, k in LANDMARKS.items():
                    p = pts[k]
                    vis = getattr(p, "visibility", 1.0) or 0.0
                    if vis >= min_visibility:
                        raw[name].append([p.x * w, p.y * h, vis])
                    else:
                        raw[name].append([math.nan, math.nan, vis])
            else:
                for name in LANDMARKS:
                    raw[name].append([math.nan, math.nan, 0.0])
            i += 1
            if progress and i % 30 == 0:
                progress(i, meta.frames)
    cap.release()
    meta.frames = i
    return meta, raw


def derive(lm: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Derived points used by overlays (hand/dumbbell centre, neck, mid-hip)."""
    out = {}
    for s in ("left", "right"):
        hand = np.nanmean(np.stack([lm[f"{s}_wrist"][:, :2], lm[f"{s}_index"][:, :2], lm[f"{s}_pinky"][:, :2]]), axis=0)
        # the dumbbell handle sits slightly beyond the knuckles along the forearm
        fore = lm[f"{s}_wrist"][:, :2] - lm[f"{s}_elbow"][:, :2]
        out[f"{s}_hand"] = hand + 0.12 * fore
    out["neck"] = (lm["left_shoulder"][:, :2] + lm["right_shoulder"][:, :2]) / 2
    out["mid_hip"] = (lm["left_hip"][:, :2] + lm["right_hip"][:, :2]) / 2
    return out


def apply_corrections(lm: dict[str, np.ndarray], corrections: list[dict] | None, fps: float) -> dict[str, np.ndarray]:
    """corrections: [{landmark, frame | time, x, y}, ...] in source pixels.
    Keyframes on one landmark are joined by linear interpolation of the correction offset
    (so a correction 'drags' the track smoothly); an isolated keyframe fades over ±6 frames."""
    if not corrections:
        return lm
    by = {}
    for c in corrections:
        f = int(c["frame"]) if "frame" in c else int(round(float(c["time"]) * fps))
        by.setdefault(c["landmark"], []).append((f, float(c["x"]), float(c["y"])))
    for name, keys in by.items():
        if name not in lm:
            raise KeyError(f"Repère inconnu dans corrections.yaml : {name}")
        keys.sort()
        tr = lm[name]
        n = len(tr)
        off = np.zeros((n, 2))
        w = np.zeros(n)
        fs = [k[0] for k in keys]
        offs = [np.array([k[1], k[2]]) - tr[min(max(k[0], 0), n - 1), :2] for k in keys]
        for j, f in enumerate(fs):
            lo = fs[j - 1] if j > 0 and f - fs[j - 1] <= 45 else f - 6
            hi = fs[j + 1] if j + 1 < len(fs) and fs[j + 1] - f <= 45 else f + 6
            for k in range(max(lo, 0), min(hi, n - 1) + 1):
                if k <= f:
                    a = 1.0 if f == lo else (k - lo) / (f - lo)
                else:
                    a = 1.0 if f == hi else (hi - k) / (hi - f)
                off[k] += a * offs[j]
                w[k] += a
        mask = w > 1
        off[mask] /= w[mask, None]
        tr[:, :2] += off
    return lm


def track(video: str | Path, model: str | Path, out_json: str | Path, smoothing: dict | None = None,
          corrections: list[dict] | None = None, progress=None) -> dict:
    smoothing = smoothing or {}
    meta, raw = detect(video, model, smoothing.get("min_visibility", 0.3), progress)
    lm = {}
    for name, rows in raw.items():
        arr = np.array(rows, dtype=float)
        sm = smooth_track(arr[:, :2], meta.fps, smoothing.get("min_cutoff", 1.2), smoothing.get("beta", 0.02))
        lm[name] = np.column_stack([sm, arr[:, 2]])
    lm = apply_corrections(lm, corrections, meta.fps)
    der = derive(lm)
    data = {
        "video": meta.__dict__,
        "landmarks": {k: np.round(v, 2).tolist() for k, v in lm.items()},
        "derived": {k: np.round(v, 2).tolist() for k, v in der.items()},
        "detection_rate": float(np.mean(~np.isnan(np.array(raw["left_shoulder"])[:, 0]))),
    }
    Path(out_json).write_text(json.dumps(data))
    return data


def load_tracking(path: str | Path) -> dict:
    d = json.loads(Path(path).read_text())
    d["landmarks"] = {k: np.array(v) for k, v in d["landmarks"].items()}
    d["derived"] = {k: np.array(v) for k, v in d["derived"].items()}
    return d
