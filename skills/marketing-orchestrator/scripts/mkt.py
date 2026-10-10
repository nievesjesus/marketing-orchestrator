#!/usr/bin/env python3
"""marketing-orchestrator CLI. Prints JSON. Never prints secrets.

  doctor                                   keys present? services reachable? deps?
  brand list | show <slug> | validate <slug> | init <slug> [--here] | learn <slug> "<lesson>"
  image generate --prompt "..." --out f.png [--brand s] [--platform p] [--aspect 4:5] [--size 2K]
                 [--ref img ...] [--text "..."] [--logo-space bottom-right] [--model id] [--api auto] [--dry-run]
  image overlay-logo <img> [--brand s | --logo f.png] [--position bottom-right] [--scale 0.16] [--out f]
  image fit <img> --aspect 4:5 [--mode crop|pad] [--color #fff] [--out f]
  image info <img>
  time suggest --platform linkedin [--brand s] [--days 7] [--count 3] [--busy ISO ...]
  package validate <pkg.json> | package save <pkg.json> [--out path]
  postiz check | integrations | settings <id> | find-slot <id> | posts [--days 14] [--from ISO]
         media [--search q] | upload <file...> | build --package p.json [--type draft] [--date ISO] [--upload] [--out f]
         create <payload.json> [--approved] | delete <post_id> | analytics-post <id> | analytics-channel <id>

Config: env vars or a .env file (cwd, ~/.config/marketing-orchestrator/.env, or skill folder).
  POSTIZ_API_KEY, POSTIZ_API_URL, GEMINI_API_KEY, GEMINI_IMAGE_MODEL, GEMINI_IMAGE_SIZE, MKT_BRANDS_DIR
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mktlib import __version__  # noqa: E402
from mktlib import brand, gemini, imaging, package, postiz, timeslots  # noqa: E402
from mktlib.config import MktError, env_files, load_env, brand_dirs, http_json  # noqa: E402


def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def doctor():
    load_env()
    report = {"version": __version__, "python": sys.version.split()[0],
              "env_files_found": [str(f) for f in env_files() if f.is_file()],
              "brand_dirs": [str(d) for d in brand_dirs() if d.is_dir()],
              "brands": [b["slug"] for b in brand.list_brands()], "keys": {}, "services": {}, "deps": {}}
    for k in ("POSTIZ_API_KEY", "POSTIZ_API_URL", "GEMINI_API_KEY", "GEMINI_IMAGE_MODEL"):
        report["keys"][k] = "set" if os.environ.get(k) else "missing"
    try:
        import PIL
        report["deps"]["pillow"] = PIL.__version__
    except ImportError:
        report["deps"]["pillow"] = "missing (needed for image overlay-logo/fit/info: pip install pillow)"
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo("America/Argentina/Buenos_Aires")
        report["deps"]["tzdata"] = "ok"
    except Exception:
        report["deps"]["tzdata"] = "missing (pip install tzdata)"
    if os.environ.get("POSTIZ_API_KEY"):
        try:
            postiz.check()
            report["services"]["postiz"] = "ok"
        except MktError as e:
            report["services"]["postiz"] = str(e).splitlines()[0]
    if os.environ.get("GEMINI_API_KEY"):
        try:
            http_json("GET", f"{gemini.BASE}/models?pageSize=1",
                      headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, service="Gemini", timeout=30)
            report["services"]["gemini"] = "ok"
        except MktError as e:
            report["services"]["gemini"] = str(e).splitlines()[0]
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mkt.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version=__version__)
    sp = ap.add_subparsers(dest="cmd", required=True)

    sp.add_parser("doctor")

    b = sp.add_parser("brand").add_subparsers(dest="sub", required=True)
    b.add_parser("list")
    for name in ("show", "validate"):
        b.add_parser(name).add_argument("slug")
    bi = b.add_parser("init"); bi.add_argument("slug"); bi.add_argument("--here", action="store_true")
    bl = b.add_parser("learn"); bl.add_argument("slug"); bl.add_argument("lesson")

    im = sp.add_parser("image").add_subparsers(dest="sub", required=True)
    g = im.add_parser("generate")
    g.add_argument("--prompt", required=True); g.add_argument("--out", required=True)
    g.add_argument("--brand"); g.add_argument("--platform"); g.add_argument("--aspect"); g.add_argument("--size")
    g.add_argument("--ref", nargs="*", default=[]); g.add_argument("--text"); g.add_argument("--logo-space")
    g.add_argument("--model"); g.add_argument("--api", default="auto", choices=["auto", "generate_content", "interactions"])
    g.add_argument("--no-brand-refs", action="store_true"); g.add_argument("--dry-run", action="store_true")
    o = im.add_parser("overlay-logo")
    o.add_argument("image"); o.add_argument("--brand"); o.add_argument("--logo"); o.add_argument("--position")
    o.add_argument("--scale", type=float, default=0.16); o.add_argument("--margin", type=float, default=0.04)
    o.add_argument("--opacity", type=float, default=1.0)
    o.add_argument("--variant", default="auto"); o.add_argument("--out")
    f = im.add_parser("fit")
    f.add_argument("image"); f.add_argument("--aspect", required=True); f.add_argument("--mode", default="crop")
    f.add_argument("--color", default="#FFFFFF"); f.add_argument("--anchor", default="center"); f.add_argument("--out")
    im.add_parser("info").add_argument("image")

    t = sp.add_parser("time").add_subparsers(dest="sub", required=True)
    ts = t.add_parser("suggest")
    ts.add_argument("--platform", required=True); ts.add_argument("--brand"); ts.add_argument("--days", type=int, default=7)
    ts.add_argument("--count", type=int, default=3); ts.add_argument("--busy", nargs="*", default=[])
    ts.add_argument("--user-tz"); ts.add_argument("--audience-tz"); ts.add_argument("--gap", type=float)

    pk = sp.add_parser("package").add_subparsers(dest="sub", required=True)
    pk.add_parser("validate").add_argument("file")
    ps = pk.add_parser("save"); ps.add_argument("file"); ps.add_argument("--out")

    pz = sp.add_parser("postiz").add_subparsers(dest="sub", required=True)
    pz.add_parser("check"); pz.add_parser("integrations")
    for name in ("settings", "find-slot", "delete"):
        pz.add_parser(name).add_argument("id")
    pp = pz.add_parser("posts"); pp.add_argument("--days", type=int, default=14); pp.add_argument("--from", dest="start")
    pm = pz.add_parser("media"); pm.add_argument("--search"); pm.add_argument("--page", type=int, default=1)
    pz.add_parser("upload").add_argument("files", nargs="+")
    pb = pz.add_parser("build")
    pb.add_argument("--package", required=True); pb.add_argument("--type", default="draft")
    pb.add_argument("--date"); pb.add_argument("--upload", action="store_true"); pb.add_argument("--out")
    pc = pz.add_parser("create"); pc.add_argument("payload"); pc.add_argument("--approved", action="store_true")
    for name in ("analytics-post", "analytics-channel"):
        a = pz.add_parser(name); a.add_argument("id"); a.add_argument("--days", type=int, default=7)

    a = ap.parse_args(argv)
    c, s = a.cmd, getattr(a, "sub", None)

    if c == "doctor":
        return doctor()
    if c == "brand":
        return {"list": lambda: brand.list_brands(), "show": lambda: brand.load(a.slug),
                "validate": lambda: brand.validate(a.slug), "init": lambda: brand.init(a.slug, a.here),
                "learn": lambda: brand.learn(a.slug, a.lesson)}[s]()
    if c == "image":
        if s == "generate":
            return gemini.generate(a.prompt, a.out, a.brand, a.platform, a.aspect, a.size, a.ref, a.text,
                                   a.logo_space, a.model, a.api, not a.no_brand_refs, a.dry_run)
        if s == "overlay-logo":
            dst = a.out or str(Path(a.image).with_name(Path(a.image).stem + "-logo" + Path(a.image).suffix))
            return imaging.overlay_logo(a.image, dst, a.brand, a.logo, a.position, a.scale, a.margin, a.opacity, a.variant)
        if s == "fit":
            dst = a.out or str(Path(a.image).with_name(f"{Path(a.image).stem}-{a.aspect.replace(':', 'x')}{Path(a.image).suffix}"))
            return imaging.fit(a.image, a.aspect, dst, a.mode, a.color, a.anchor)
        return imaging.info(a.image)
    if c == "time":
        return timeslots.suggest(a.platform, a.brand, a.days, a.count, user_tz=a.user_tz,
                                 audience_tz=a.audience_tz, busy=a.busy, min_gap_hours=a.gap)
    if c == "package":
        if s == "validate":
            return package.validate(a.file)
        data = json.loads(Path(a.file).read_text(encoding="utf-8"))
        return package.save(data, a.out or a.file)
    if c == "postiz":
        if s == "build":
            res = postiz.build(a.package, a.type, a.date, a.upload)
            if a.out:
                Path(a.out).write_text(json.dumps(res["payload"], indent=2, ensure_ascii=False), encoding="utf-8")
                res["saved"] = str(Path(a.out).resolve())
            return res
        if s == "upload":
            r = [postiz.upload(p) for p in a.files]
            return r[0] if len(r) == 1 else r
        return {
            "check": postiz.check, "integrations": postiz.integrations,
            "settings": lambda: postiz.settings(a.id), "find-slot": lambda: postiz.find_slot(a.id),
            "posts": lambda: postiz.posts(a.days, a.start), "media": lambda: postiz.media(a.search, a.page),
            "create": lambda: postiz.create(a.payload, a.approved), "delete": lambda: postiz.delete(a.id),
            "analytics-post": lambda: postiz.analytics_post(a.id, a.days),
            "analytics-channel": lambda: postiz.analytics_channel(a.id, a.days),
        }[s]()


if __name__ == "__main__":
    try:
        out(main())
    except MktError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
    except FileNotFoundError as e:
        print(json.dumps({"error": f"File not found: {e.filename}"}), file=sys.stderr)
        sys.exit(2)
