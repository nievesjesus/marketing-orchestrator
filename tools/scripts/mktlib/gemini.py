"""Gemini image generation/editing (Nano Banana family). Stdlib only.

Two Google endpoints are supported:
  - generateContent (default): POST /v1beta/models/{model}:generateContent
  - interactions:              POST /v1beta/interactions
`api="auto"` tries generateContent and falls back to interactions on 400/404.
The parser walks the whole response for image bytes, so it tolerates schema drift.
"""
import base64
import json
import mimetypes
from datetime import datetime, timezone
from pathlib import Path

from .config import MktError, env, http_json
from . import brand as brandlib

BASE = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-nano-banana-2.1"
ASPECTS = {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
SIZES = {"512px", "1K", "2K", "4K"}
REF_MIME = {"image/png", "image/jpeg", "image/webp"}
MAX_REFS = 14

PLATFORM_ASPECT = {
    "linkedin": "4:5", "linkedin-page": "4:5", "instagram": "4:5", "instagram-standalone": "4:5",
    "instagram-story": "9:16", "tiktok": "9:16", "x": "16:9", "facebook": "4:5",
    "threads": "4:5", "bluesky": "16:9", "pinterest": "2:3", "youtube": "16:9",
}


def _b64(path):
    p = Path(path)
    if not p.is_file():
        raise MktError(f"Reference image not found: {path}")
    mime = mimetypes.guess_type(p.name)[0]
    if mime not in REF_MIME:
        raise MktError(f"Reference {p.name}: {mime} not supported (use png, jpeg or webp)")
    return mime, base64.b64encode(p.read_bytes()).decode()


def build_prompt(prompt, brand=None, platform=None, text=None, logo_space=None, has_style_refs=False,
                 has_edit_refs=False):
    parts = [prompt.strip()]
    if platform:
        parts.append(f"This is a social media image for {platform}.")
    if text:
        parts.append(f'Render this exact text, spelled exactly, clearly legible: "{text}". No other text.')
    else:
        parts.append("Do not render any text, letters, logos or watermarks.")
    if brand:
        style = brandlib.visual_prompt(brand)
        if style:
            parts.append(style)
    if has_style_refs:
        parts.append("Some attached images are brand style references: match their look (palette, lighting, "
                     "composition, texture) but do not copy their content.")
    if has_edit_refs:
        parts.append("The first attached image is the image to edit or build on; keep its subject unless told otherwise.")
    if logo_space:
        parts.append(f"Keep the {logo_space.replace('-', ' ')} corner calm and uncluttered: a logo will be placed there.")
    return "\n\n".join(parts)


def _find_images(obj, found):
    """Collect (mime, b64) from any known shape: inlineData / inline_data / {type:image,data}."""
    if isinstance(obj, dict):
        if obj.get("thought") is True:  # interim "thinking" images are drafts, skip them
            return found
        for key in ("inlineData", "inline_data"):
            blob = obj.get(key)
            if isinstance(blob, dict) and blob.get("data"):
                found.append((blob.get("mimeType") or blob.get("mime_type") or "image/png", blob["data"]))
        if obj.get("type") == "image" and isinstance(obj.get("data"), str):
            found.append((obj.get("mime_type") or obj.get("mimeType") or "image/png", obj["data"]))
        for k, v in obj.items():
            if k not in ("inlineData", "inline_data"):
                _find_images(v, found)
    elif isinstance(obj, list):
        for v in obj:
            _find_images(v, found)
    return found


def _find_text(obj, out):
    if isinstance(obj, dict):
        if isinstance(obj.get("text"), str) and obj.get("thought") is not True:
            out.append(obj["text"])
        for v in obj.values():
            _find_text(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _find_text(v, out)
    return out


def _call_generate_content(key, model, prompt, refs, aspect, size):
    parts = [{"text": prompt}] + [{"inline_data": {"mime_type": m, "data": d}} for m, d in refs]
    image_cfg = {"aspectRatio": aspect}
    if size:
        image_cfg["imageSize"] = size
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"], "imageConfig": image_cfg}}
    return http_json("POST", f"{BASE}/models/{model}:generateContent",
                     headers={"x-goog-api-key": key}, body=body, timeout=300, service="Gemini")


def _call_interactions(key, model, prompt, refs, aspect, size):
    inp = [{"type": "text", "text": prompt}] + [{"type": "image", "mime_type": m, "data": d} for m, d in refs]
    fmt = {"type": "image", "mime_type": "image/png", "aspect_ratio": aspect}
    if size:
        fmt["image_size"] = size
    body = {"model": model, "input": inp, "response_format": fmt, "store": False}
    return http_json("POST", f"{BASE}/interactions", headers={"x-goog-api-key": key},
                     body=body, timeout=300, service="Gemini")


def generate(prompt, out, brand_slug=None, platform=None, aspect=None, size=None, refs=None,
             text=None, logo_space=None, model=None, api="auto", use_brand_refs=True, dry_run=False):
    brand = brandlib.load(brand_slug) if brand_slug else None
    model = model or env("GEMINI_IMAGE_MODEL", DEFAULT_MODEL)
    aspect = aspect or (brand or {}).get("visual", {}).get("default_aspect", {}).get(platform or "") \
        or PLATFORM_ASPECT.get(platform or "", "1:1")
    if aspect not in ASPECTS:
        raise MktError(f"aspect {aspect} not supported; use one of {', '.join(sorted(ASPECTS))}")
    size = size or env("GEMINI_IMAGE_SIZE", "2K")
    if "lite" in model:
        size = "1K"
    if size not in SIZES:
        raise MktError(f"size {size} not supported; use {', '.join(sorted(SIZES))}")

    edit_refs = [_b64(r) for r in (refs or [])]
    style_refs = []
    if brand and use_brand_refs:
        style_refs = [_b64(r) for r in brand["assets"]["style_refs"]]
    all_refs = (edit_refs + style_refs)[:MAX_REFS]
    full_prompt = build_prompt(prompt, brand, platform, text, logo_space,
                               has_style_refs=bool(style_refs), has_edit_refs=bool(edit_refs))
    meta = {"model": model, "aspect": aspect, "size": size, "brand": brand_slug, "platform": platform,
            "edit_refs": list(refs or []), "style_refs": len(style_refs), "prompt": full_prompt}
    if dry_run:
        return {"dry_run": True, **meta}

    key = env("GEMINI_API_KEY", required=True, hint="Create one at https://aistudio.google.com/apikey")
    used_api = api
    if api in ("auto", "generate_content"):
        try:
            res = _call_generate_content(key, model, full_prompt, all_refs, aspect, size)
            used_api = "generate_content"
        except MktError as e:
            if api == "auto" and getattr(e, "status", None) in (400, 404):
                res = _call_interactions(key, model, full_prompt, all_refs, aspect, size)
                used_api = "interactions"
            else:
                raise
    elif api == "interactions":
        res = _call_interactions(key, model, full_prompt, all_refs, aspect, size)
    else:
        raise MktError("api must be auto, generate_content or interactions")

    images = _find_images(res, [])
    if not images:
        reason = json.dumps(res.get("promptFeedback") or res.get("candidates", [{}])[0].get("finishReason")
                            if isinstance(res, dict) else res)[:500]
        raise MktError(f"Gemini returned no image (possible safety block or unsupported option). Detail: {reason}")

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    saved = []
    for i, (mime, data) in enumerate(images):
        ext = mimetypes.guess_extension(mime) or ".png"
        target = out if i == 0 else out.with_name(f"{out.stem}-{i + 1}{out.suffix}")
        if target.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            target = target.with_suffix(ext)
        target.write_bytes(base64.b64decode(data))
        saved.append(str(target.resolve()))
    meta.update({"api": used_api, "files": saved, "model_text": " ".join(_find_text(res, []))[:1000],
                 "created_at": datetime.now(timezone.utc).isoformat(), "watermark": "SynthID (invisible)"})
    Path(saved[0]).with_suffix(".json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return meta
