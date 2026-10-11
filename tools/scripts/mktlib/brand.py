"""Brand kits: one folder per brand with brand.json, voice.md, logos and style references."""
import json
import shutil
from datetime import date
from pathlib import Path

from .config import MktError, USER_DIR, brand_dirs

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}


def _find(slug):
    for d in brand_dirs():
        p = d / slug
        if (p / "brand.json").is_file():
            return p
    raise MktError(f"Brand '{slug}' not found. Known: {', '.join(b['slug'] for b in list_brands()) or 'none'}. "
                   f"Create one with: mkt.py brand init {slug}")


def list_brands():
    seen, out = set(), []
    for d in brand_dirs():
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir()):
            if p.name.startswith("_") or p.name in seen or not (p / "brand.json").is_file():
                continue
            seen.add(p.name)
            try:
                data = json.loads((p / "brand.json").read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                out.append({"slug": p.name, "error": f"brand.json invalid: {e}", "dir": str(p)})
                continue
            out.append({"slug": p.name, "name": data.get("name"), "goal": data.get("goal"),
                        "channels": data.get("default_channels", []), "dir": str(p)})
    return out


def _todos(obj, prefix=""):
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            found += _todos(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found += _todos(v, f"{prefix}[{i}]")
    elif isinstance(obj, str) and "TODO" in obj:
        found.append(prefix)
    return found


def _resolve(base, rel):
    if not rel:
        return None
    p = (base / rel).resolve()
    return str(p) if p.is_file() else None


def load(slug):
    """Return the brand with asset paths resolved to absolute paths and missing assets reported."""
    d = _find(slug)
    data = json.loads((d / "brand.json").read_text(encoding="utf-8"))
    visual = data.setdefault("visual", {})
    logos = {k: _resolve(d, v) for k, v in (visual.get("logo") or {}).items()}
    refs = [r for r in (_resolve(d, x) for x in visual.get("style_refs", [])) if r]
    style_dir = d / "style"
    if style_dir.is_dir():
        for f in sorted(style_dir.iterdir()):
            if f.suffix.lower() in IMAGE_EXT and str(f.resolve()) not in refs:
                refs.append(str(f.resolve()))
    voice = (d / "voice.md").read_text(encoding="utf-8") if (d / "voice.md").is_file() else ""
    return {
        **data,
        "slug": slug,
        "dir": str(d),
        "voice_md": voice,
        "assets": {"logos": {k: v for k, v in logos.items() if v},
                   "missing_logos": [k for k, v in logos.items() if not v],
                   "style_refs": refs},
        "todo_fields": _todos(data) + (["voice.md"] if "TODO" in voice else []),
    }


def validate(slug):
    b = load(slug)
    problems = []
    for key in ("name", "timezone", "languages", "default_channels"):
        if not b.get(key):
            problems.append(f"missing '{key}'")
    for name, hexv in (b.get("visual", {}).get("colors") or {}).items():
        if not (isinstance(hexv, str) and hexv.startswith("#") and len(hexv) in (4, 7)):
            problems.append(f"visual.colors.{name} must be a hex color like #1A2B3C")
    if b["assets"]["missing_logos"]:
        problems.append(f"logo files not found: {', '.join(b['assets']['missing_logos'])}")
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(b.get("timezone", "UTC"))
    except Exception:
        problems.append(f"timezone '{b.get('timezone')}' is not a valid IANA zone")
    return {"slug": slug, "ok": not problems, "problems": problems, "todo_fields": b["todo_fields"]}


def init(slug, here=False):
    from .config import TOOLS_DIR
    template = TOOLS_DIR / "brands" / "_template"
    target_root = (TOOLS_DIR / "brands") if here else (USER_DIR / "brands")
    target = target_root / slug
    if target.exists():
        raise MktError(f"{target} already exists")
    shutil.copytree(template, target)
    bj = target / "brand.json"
    data = json.loads(bj.read_text(encoding="utf-8"))
    data["slug"] = slug
    bj.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"created": str(target), "next": "Fill brand.json and voice.md, add logo.png and style/ images."}


def learn(slug, lesson):
    d = _find(slug)
    bj = d / "brand.json"
    data = json.loads(bj.read_text(encoding="utf-8"))
    entry = f"{date.today().isoformat()}: {lesson.strip()}"
    data.setdefault("learned", []).append(entry)
    bj.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"slug": slug, "added": entry, "total": len(data["learned"])}


def visual_prompt(brand):
    """Plain-language brand style block appended to image prompts."""
    def real(x):
        return isinstance(x, str) and x.strip() and "TODO" not in x

    v = {k: val for k, val in brand.get("visual", {}).items() if not isinstance(val, str) or real(val)}
    lines = []
    if v.get("style"):
        lines.append(f"Visual style: {v['style']}")
    colors = {k: c for k, c in (v.get("colors") or {}).items() if real(c)}
    if colors:
        lines.append("Color palette (use these, keep them dominant): " +
                     ", ".join(f"{k} {c}" for k, c in colors.items()))
    fonts = {k: f for k, f in (v.get("fonts") or {}).items() if real(f)}
    if fonts:
        lines.append("Typography feel for any rendered text: " +
                     ", ".join(f"{k}: {f}" for k, f in fonts.items()))
    if v.get("imagery"):
        lines.append(f"Imagery: {v['imagery']}")
    if v.get("avoid"):
        lines.append(f"Avoid: {v['avoid']}")
    return "\n".join(lines)
