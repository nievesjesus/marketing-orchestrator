"""Post package: the platform-tailored draft the agent builds before anything touches Postiz."""
import json
from pathlib import Path

from .config import MktError
from . import brand as brandlib

MAX_LEN = {"x": 280, "bluesky": 300, "threads": 500, "linkedin": 3000, "linkedin-page": 3000,
           "instagram": 2200, "instagram-standalone": 2200, "facebook": 63206, "tiktok": 2200,
           "pinterest": 500, "mastodon": 500}
MAX_TAGS = {"linkedin": 5, "linkedin-page": 5, "instagram": 15, "instagram-standalone": 15, "x": 2,
            "threads": 1, "facebook": 3, "tiktok": 6, "bluesky": 2}
NEEDS_MEDIA = {"instagram", "instagram-standalone", "tiktok", "youtube", "pinterest"}
REQUIRED = ("platform", "objective", "audience", "hook", "body")
OBJECTIVES = {"awareness", "engagement", "traffic", "leads", "authority"}


def compose(post):
    """Final text = hook, body, CTA, hashtags, separated by blank lines (skips empties, avoids repeating the hook)."""
    hook, body = post.get("hook", "").strip(), post.get("body", "").strip()
    blocks = [hook] if hook and not body.startswith(hook) else []
    blocks += [body, post.get("cta", "").strip()]
    tags = " ".join(t if t.startswith("#") else f"#{t}" for t in post.get("hashtags", []))
    blocks.append(tags)
    return "\n\n".join(b for b in blocks if b)


def validate(pkg):
    if isinstance(pkg, (str, Path)):
        pkg = json.loads(Path(pkg).read_text(encoding="utf-8"))
    problems, warnings = [], []
    brand = None
    if pkg.get("brand"):
        try:
            brand = brandlib.load(pkg["brand"])
        except MktError as e:
            problems.append(str(e))
    never = {t.lower().lstrip("#") for t in ((brand or {}).get("hashtags", {}).get("never") or [])}
    posts = pkg.get("posts") or []
    if not posts:
        problems.append("posts[] is empty")
    report = []
    for i, p in enumerate(posts):
        tag = f"posts[{i}] ({p.get('platform', '?')})"
        for f in REQUIRED:
            if not p.get(f):
                problems.append(f"{tag}: missing '{f}'")
        if p.get("objective") and p["objective"] not in OBJECTIVES:
            warnings.append(f"{tag}: objective '{p['objective']}' not in {sorted(OBJECTIVES)}")
        plat = p.get("platform", "")
        text = compose(p)
        limit = MAX_LEN.get(plat)
        if limit and len(text) > limit:
            problems.append(f"{tag}: {len(text)} chars > {limit} limit")
        tags = p.get("hashtags", [])
        if plat in MAX_TAGS and len(tags) > MAX_TAGS[plat]:
            warnings.append(f"{tag}: {len(tags)} hashtags, playbook suggests <= {MAX_TAGS[plat]}")
        bad = [t for t in tags if t.lower().lstrip("#") in never]
        if bad:
            problems.append(f"{tag}: hashtags on the brand's never-list: {', '.join(bad)}")
        media = p.get("media", [])
        if plat in NEEDS_MEDIA and not media:
            problems.append(f"{tag}: {plat} requires at least one image/video")
        if media and len(p.get("alt_text", [])) < len([m for m in media if not str(m).endswith(".mp4")]):
            warnings.append(f"{tag}: alt_text missing for some images")
        for m in media:
            if isinstance(m, str) and not m.startswith("http") and not Path(m).is_file():
                problems.append(f"{tag}: media file not found: {m}")
        report.append({"platform": plat, "chars": len(text), "limit": limit, "hashtags": len(tags)})
    return {"ok": not problems, "problems": problems, "warnings": warnings, "posts": report}


def save(pkg, path):
    res = validate(pkg)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {**res, "saved": str(Path(path).resolve())}
