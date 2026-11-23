"""Kinematic analysis from 2D keypoints: joint angles, repetitions, phases, external lever arm.

All angles are 2D projections in the image plane: they are estimates, accurate only when the
movement happens in a plane roughly parallel to the camera (e.g. lateral raises filmed from the front).
"""
from __future__ import annotations

import numpy as np

UP = np.array([0.0, -1.0])


def vec(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return b - a


def angle_between(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Unsigned angle (deg) between row-vectors u and v."""
    nu = np.linalg.norm(u, axis=-1)
    nv = np.linalg.norm(v, axis=-1)
    c = np.sum(u * v, axis=-1) / np.maximum(nu * nv, 1e-6)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def trunk_down(lm: dict, side: str) -> np.ndarray:
    """Trunk axis on one side, pointing down (shoulder -> hip)."""
    return vec(lm[f"{side}_shoulder"][:, :2], lm[f"{side}_hip"][:, :2])


# ---------------------------------------------------------------- metrics (named in exercise YAML)
def metric(name: str, lm: dict, der: dict) -> np.ndarray:
    s, _, kind = name.partition(":")  # e.g. "left:shoulder_abduction"
    if kind == "shoulder_abduction":  # humerus vs trunk, frontal plane
        return angle_between(trunk_down(lm, s), vec(lm[f"{s}_shoulder"][:, :2], lm[f"{s}_elbow"][:, :2]))
    if kind == "elbow_flexion":
        return 180 - angle_between(vec(lm[f"{s}_elbow"][:, :2], lm[f"{s}_shoulder"][:, :2]), vec(lm[f"{s}_elbow"][:, :2], lm[f"{s}_wrist"][:, :2]))
    if kind == "knee_flexion":
        return 180 - angle_between(vec(lm[f"{s}_knee"][:, :2], lm[f"{s}_hip"][:, :2]), vec(lm[f"{s}_knee"][:, :2], lm[f"{s}_ankle"][:, :2]))
    if kind == "hip_flexion":
        return 180 - angle_between(vec(lm[f"{s}_hip"][:, :2], lm[f"{s}_shoulder"][:, :2]), vec(lm[f"{s}_hip"][:, :2], lm[f"{s}_knee"][:, :2]))
    if kind == "trunk_lean":  # trunk vs vertical
        return angle_between(vec(lm[f"{s}_hip"][:, :2], lm[f"{s}_shoulder"][:, :2]), UP[None, :])
    raise ValueError(f"Métrique inconnue : {name}")


def lever_arm(lm: dict, der: dict, side: str, joint: str = "shoulder", load: str = "hand") -> np.ndarray:
    """Horizontal distance (px) between the joint and the load: the external moment arm of a
    vertical load (gravity). Normalised later by the segment length for display."""
    j = lm[f"{side}_{joint}"][:, :2]
    l = der[f"{side}_{load}"] if f"{side}_{load}" in der else lm[f"{side}_{load}"][:, :2]
    return np.abs(l[:, 0] - j[:, 0])


def limb_length(lm: dict, der: dict, side: str) -> float:
    a = np.linalg.norm(lm[f"{side}_shoulder"][:, :2] - lm[f"{side}_elbow"][:, :2], axis=1)
    b = np.linalg.norm(lm[f"{side}_elbow"][:, :2] - der[f"{side}_hand"], axis=1)
    return float(np.nanmedian(a + b))


# ---------------------------------------------------------------- reps & phases
def smooth1d(x: np.ndarray, win: int) -> np.ndarray:
    if win <= 1:
        return x
    k = np.hanning(win)
    k /= k.sum()
    pad = np.pad(x, (win // 2, win - 1 - win // 2), mode="edge")
    return np.convolve(pad, k, mode="valid")


def detect_reps(signal: np.ndarray, fps: float, min_range: float = 25.0, min_gap_s: float = 0.6) -> list[dict]:
    """Repetitions = valley -> peak -> valley cycles of a 1D signal (e.g. arm elevation)."""
    x = smooth1d(signal, max(3, int(fps * 0.2)))
    n = len(x)
    # local extrema
    ext = []
    for i in range(1, n - 1):
        if x[i] >= x[i - 1] and x[i] > x[i + 1]:
            ext.append((i, "peak"))
        elif x[i] <= x[i - 1] and x[i] < x[i + 1]:
            ext.append((i, "valley"))
    # hysteresis: keep alternating extrema separated by min_range
    clean = []
    for i, kind in ext:
        if clean and clean[-1][1] == kind:
            if (kind == "peak" and x[i] > x[clean[-1][0]]) or (kind == "valley" and x[i] < x[clean[-1][0]]):
                clean[-1] = (i, kind)
            continue
        if clean and abs(x[i] - x[clean[-1][0]]) < min_range:
            continue
        clean.append((i, kind))
    if not clean or clean[0][1] != "valley":
        clean.insert(0, (0, "valley"))
    if clean[-1][1] != "valley":
        clean.append((n - 1, "valley"))
    reps = []
    for j in range(0, len(clean) - 2, 2):
        a, p, b = clean[j][0], clean[j + 1][0], clean[j + 2][0]
        if clean[j + 1][1] != "peak" or (b - a) / fps < min_gap_s:
            continue
        reps.append({"start": a, "peak": p, "end": b, "peak_value": float(x[p]), "min_value": float(min(x[a], x[b]))})
    return reps


def phases(signal: np.ndarray, fps: float, reps: list[dict], hold_deg_per_s: float = 25.0) -> list[str]:
    """Per-frame phase: concentric (rising), eccentric (lowering), top / bottom transitions."""
    x = smooth1d(signal, max(3, int(fps * 0.15)))
    v = np.gradient(x) * fps
    out = ["bottom"] * len(x)
    for i in range(len(x)):
        if v[i] > hold_deg_per_s:
            out[i] = "concentric"
        elif v[i] < -hold_deg_per_s:
            out[i] = "eccentric"
        else:
            mid = (np.nanmax(x) + np.nanmin(x)) / 2
            out[i] = "top" if x[i] > mid else "bottom"
    return out


def analyse(tracking: dict, cfg: dict) -> dict:
    lm, der = tracking["landmarks"], tracking["derived"]
    fps = tracking["video"]["fps"]
    a = cfg.get("analysis", {})
    sides = a.get("sides", ["left", "right"])
    result = {"fps": fps, "frames": tracking["video"]["frames"], "metrics": {}, "lever": {}}
    for m in a.get("metrics", []):
        for s in sides:
            result["metrics"][f"{s}:{m}"] = metric(f"{s}:{m}", lm, der)
    driver = np.nanmean([result["metrics"][f"{s}:{a['driver']}"] for s in sides], axis=0)
    result["driver"] = driver
    reps = detect_reps(driver, fps, a.get("min_rep_range", 25.0))
    result["reps"] = reps
    result["phase"] = phases(driver, fps, reps)
    if a.get("lever"):
        for s in sides:
            L = limb_length(lm, der, s)
            result["lever"][s] = lever_arm(lm, der, s, a["lever"].get("joint", "shoulder"), a["lever"].get("load", "hand")) / max(L, 1)
    return result
