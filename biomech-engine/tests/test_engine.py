"""Unit tests on synthetic data (no video needed): angles, reps, phases, smoothing, corrections."""
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from biomech import analysis as an  # noqa: E402
from biomech import pose  # noqa: E402

FPS = 30.0


def synthetic_raise(n_reps=4, period=2.0, top=90.0, bottom=10.0):
    """Skeleton facing the camera; both arms abduct following a cosine profile."""
    n = int(n_reps * period * FPS)
    t = np.arange(n) / FPS
    abd = bottom + (top - bottom) * (1 - np.cos(2 * math.pi * t / period)) / 2
    lm = {}
    for side, sgn in (("left", 1), ("right", -1)):
        sh = np.tile([500 + sgn * 100, 400.0], (n, 1))
        hip = np.tile([500 + sgn * 80, 800.0], (n, 1))
        a = np.radians(abd)
        el = sh + np.column_stack([sgn * 150 * np.sin(a), 150 * np.cos(a)])
        wr = sh + np.column_stack([sgn * 300 * np.sin(a), 300 * np.cos(a)])
        for name, arr in (("shoulder", sh), ("hip", hip), ("elbow", el), ("wrist", wr), ("index", wr), ("pinky", wr)):
            lm[f"{side}_{name}"] = np.column_stack([arr, np.ones(n)])
    return lm, abd


def test_shoulder_abduction_matches_ground_truth():
    lm, abd = synthetic_raise()
    est = an.metric("left:shoulder_abduction", lm, pose.derive(lm))
    assert np.max(np.abs(est - abd)) < 6.0  # trunk is slightly tilted in the synthetic skeleton


def test_reps_and_phases():
    lm, abd = synthetic_raise(n_reps=4)
    reps = an.detect_reps(abd, FPS)
    assert len(reps) == 4
    assert all(80 < r["peak_value"] <= 90.5 for r in reps)
    ph = an.phases(abd, FPS, reps)
    assert ph.count("concentric") > 0 and ph.count("eccentric") > 0


def test_lever_arm_is_maximal_near_horizontal():
    lm, abd = synthetic_raise()
    der = pose.derive(lm)
    lever = an.lever_arm(lm, der, "left") / an.limb_length(lm, der, "left")
    i_top = int(np.argmax(abd))
    i_bottom = int(np.argmin(abd))
    assert lever[i_top] > 0.9 and lever[i_bottom] < 0.25


def test_smoothing_reduces_jitter_and_fills_gaps():
    rng = np.random.default_rng(0)
    t = np.arange(200) / FPS
    clean = np.column_stack([100 + 50 * np.sin(t * 2), 200 + 0 * t])
    noisy = clean + rng.normal(0, 4, clean.shape)
    noisy[50:55] = np.nan
    sm = pose.smooth_track(noisy, FPS, 1.2, 0.02)
    assert not np.isnan(sm).any()
    assert np.std(sm - clean) < np.nanstd(noisy - clean)


def test_manual_correction_moves_track_and_fades():
    n = 100
    lm = {"left_wrist": np.column_stack([np.full(n, 100.0), np.full(n, 100.0), np.ones(n)])}
    out = pose.apply_corrections(lm, [{"landmark": "left_wrist", "frame": 50, "x": 120, "y": 100}], FPS)
    assert abs(out["left_wrist"][50, 0] - 120) < 1e-6
    assert abs(out["left_wrist"][40, 0] - 100) < 1e-6
    assert 100 < out["left_wrist"][53, 0] < 120


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
