"""Command line: analyse a video, preview frames, render the final MP4.

  python3 -m biomech run      --video in.mov --exercise elevations_laterales --project projects/x
  python3 -m biomech analyse  --video in.mov --exercise elevations_laterales --project projects/x
  python3 -m biomech preview  --project projects/x --times 1,5,9
  python3 -m biomech render   --project projects/x
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import yaml

from . import analysis as an
from . import pose
from .render import Renderer

ROOT = Path(__file__).resolve().parent.parent


def load_exercise(name_or_path: str) -> dict:
    p = Path(name_or_path)
    if not p.exists():
        p = ROOT / "config" / "exercises" / f"{name_or_path}.yaml"
    if not p.exists():
        raise SystemExit(f"Exercice introuvable : {name_or_path} (voir config/exercises/)")
    return yaml.safe_load(p.read_text())


def project_paths(project: str) -> dict:
    d = Path(project)
    d.mkdir(parents=True, exist_ok=True)
    return {"dir": d, "project": d / "project.yaml", "tracking": d / "tracking.json", "analysis": d / "analysis.json",
            "corrections": d / "corrections.yaml", "out": d / "output.mp4", "preview": d / "previews"}


def cmd_analyse(args) -> None:
    pp = project_paths(args.project)
    cfg = load_exercise(args.exercise)
    proj = {"video": str(Path(args.video).resolve()), "exercise": args.exercise}
    pp["project"].write_text(yaml.safe_dump(proj, allow_unicode=True))
    if not pp["corrections"].exists():
        pp["corrections"].write_text(
            "# Corrections manuelles des repères (coordonnées en pixels de la vidéo source).\n"
            "# Exemple :\n# - {landmark: left_wrist, time: 3.40, x: 512, y: 380}\n# - {landmark: right_elbow, frame: 120, x: 210, y: 400}\n[]\n")
    corrections = yaml.safe_load(pp["corrections"].read_text()) or []
    model = ROOT / "models" / f"pose_landmarker_{args.model}.task"
    if not model.exists():
        raise SystemExit("Modèle absent : lancez scripts/download_models.sh")
    print(f"Suivi des articulations ({args.model})…")
    data = pose.track(proj["video"], model, pp["tracking"], cfg.get("tracking", {}), corrections,
                      progress=lambda i, n: print(f"  {i}/{n}", end="\r", flush=True))
    print(f"\n  détection : {data['detection_rate'] * 100:.0f} % des images")
    write_analysis(pp, cfg)


def write_analysis(pp: dict, cfg: dict) -> dict:
    tr = pose.load_tracking(pp["tracking"])
    res = an.analyse(tr, cfg)
    fps = res["fps"]
    summary = {
        "reps": [{k: (round(v / fps, 2) if k in ("start", "peak", "end") else round(v, 1)) for k, v in r.items()} for r in res["reps"]],
        "metrics": {k: {"min": round(float(np.nanmin(v)), 1), "max": round(float(np.nanmax(v)), 1), "median": round(float(np.nanmedian(v)), 1)} for k, v in res["metrics"].items()},
    }
    pp["analysis"].write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f"  {len(res['reps'])} répétitions détectées :")
    for r in summary["reps"]:
        print(f"    {r['start']:>5.2f}s → sommet {r['peak']:>5.2f}s → {r['end']:>5.2f}s   amplitude {r['min_value']}° → {r['peak_value']}°")
    return res


def make_renderer(project: str, audio: str | None = None) -> tuple[Renderer, dict]:
    pp = project_paths(project)
    proj = yaml.safe_load(pp["project"].read_text())
    cfg = load_exercise(proj["exercise"])
    tr = pose.load_tracking(pp["tracking"])
    corrections = yaml.safe_load(pp["corrections"].read_text()) or [] if pp["corrections"].exists() else []
    if corrections:
        tr["landmarks"] = pose.apply_corrections(tr["landmarks"], corrections, tr["video"]["fps"])
        tr["derived"] = pose.derive(tr["landmarks"])
    res = an.analyse(tr, cfg)
    return Renderer(proj["video"], tr, res, cfg, audio), pp


def cmd_preview(args) -> None:
    r, pp = make_renderer(args.project)
    times = [float(x) for x in args.times.split(",")] if args.times else [r.total * k / 8 for k in range(8)]
    paths = r.render("", preview_times=times, preview_dir=str(pp["preview"]))
    print(f"Durée finale : {r.total:.1f} s · {len(paths)} aperçus dans {pp['preview']}")


def cmd_render(args) -> None:
    r, pp = make_renderer(args.project, args.audio)
    out = args.out or str(pp["out"])
    print(f"Rendu {r.total:.1f} s ({len(r.shots)} scènes)…")
    for s in r.shots:
        print(f"  {s.scene['id']:<12} répétition {s.scene.get('rep')} · vitesse ×{s.speed:.2f} · {s.duration:.1f} s")
    r.render(out)
    print(f"OK : {out}")


def cmd_run(args) -> None:
    cmd_analyse(args)
    cmd_render(args)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="biomech", description="Moteur de vidéos biomécaniques Smart & Strong")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("analyse", cmd_analyse), ("run", cmd_run)):
        p = sub.add_parser(name)
        p.add_argument("--video", required=True)
        p.add_argument("--exercise", required=True)
        p.add_argument("--project", required=True)
        p.add_argument("--model", default="heavy", choices=["heavy", "full"])
        p.add_argument("--audio", default=None, help="piste audio optionnelle (musique, voix off)")
        p.add_argument("--out", default=None)
        p.set_defaults(fn=fn)
    p = sub.add_parser("preview")
    p.add_argument("--project", required=True)
    p.add_argument("--times", default=None, help="instants (s) séparés par des virgules")
    p.set_defaults(fn=cmd_preview)
    p = sub.add_parser("render")
    p.add_argument("--project", required=True)
    p.add_argument("--audio", default=None)
    p.add_argument("--out", default=None)
    p.set_defaults(fn=cmd_render)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main(sys.argv[1:])
