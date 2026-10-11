"""Postiz Public API client. Docs: https://docs.postiz.com/public-api/introduction"""
import json
import mimetypes
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import MktError, env, http_json
from . import package as pkglib

ALLOWED_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp",
                "image/tiff", "video/mp4"}

# Safe defaults per platform; the live schema from `settings` always wins.
DEFAULT_SETTINGS = {
    "x": {"who_can_reply_post": "everyone"},
    "linkedin": {}, "linkedin-page": {},
    "instagram": {"post_type": "post", "is_trial_reel": False, "collaborators": []},
    "instagram-standalone": {"post_type": "post", "is_trial_reel": False, "collaborators": []},
    "facebook": {}, "threads": {}, "bluesky": {}, "mastodon": {}, "telegram": {},
    # UPLOAD only sends to the TikTok inbox (nothing goes public). Switch to DIRECT_POST explicitly.
    "tiktok": {"privacy_level": "PUBLIC_TO_EVERYONE", "duet": False, "stitch": False, "comment": True,
               "autoAddMusic": "no", "brand_content_toggle": False, "brand_organic_toggle": False,
               "content_posting_method": "UPLOAD"},
}


def _base():
    return env("POSTIZ_API_URL", "https://api.postiz.com/public/v1").rstrip("/")


def _key():
    return env("POSTIZ_API_KEY", required=True,
               hint="Get it in Postiz > Settings > Developers > Public API.")


def call(method, path, body=None, raw_body=None, headers=None):
    h = {"Authorization": _key()}
    h.update(headers or {})
    return http_json(method, f"{_base()}{path}", headers=h, body=body, raw_body=raw_body, service="Postiz")


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def check():
    return {"base_url": _base(), "result": call("GET", "/is-connected")}


def integrations():
    res = call("GET", "/integrations")
    items = res if isinstance(res, list) else res.get("integrations", res)
    if not isinstance(items, list):
        return items
    return [{"id": i.get("id"), "platform": i.get("identifier") or i.get("providerIdentifier") or i.get("platform"),
             "name": i.get("name"), "disabled": i.get("disabled"), "customer": i.get("customer")} for i in items]


def settings(integration_id):
    return call("GET", f"/integration-settings/{integration_id}")


def find_slot(integration_id):
    return call("GET", f"/find-slot/{integration_id}")


def posts(days=14, start=None):
    start = datetime.fromisoformat(start.replace("Z", "+00:00")) if start else datetime.now(timezone.utc)
    end = start + timedelta(days=days)
    return call("GET", f"/posts?startDate={iso(start)}&endDate={iso(end)}")


def media(search=None, page=1):
    q = f"?page={page}" + (f"&search={search}" if search else "")
    return call("GET", f"/media{q}")


def upload(path):
    p = Path(path)
    if not p.is_file():
        raise MktError(f"File not found: {path}")
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    if mime not in ALLOWED_MIME:
        raise MktError(f"Unsupported type {mime}. Postiz accepts: {', '.join(sorted(ALLOWED_MIME))}")
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{p.name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n").encode() + p.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    res = call("POST", "/upload", raw_body=body,
               headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return {"id": res.get("id"), "path": res.get("path"), "name": res.get("name", p.name), "source": str(p)}


def upload_from_url(url):
    return call("POST", "/upload-from-url", body={"url": url})


def validate_payload(p):
    problems = []
    if p.get("type") not in {"now", "schedule", "draft"}:
        problems.append("type must be now | schedule | draft")
    for k in ("date", "shortLink", "tags"):
        if k not in p:
            problems.append(f"missing top-level '{k}'")
    if p.get("type") == "schedule":
        try:
            d = datetime.fromisoformat(str(p.get("date")).replace("Z", "+00:00"))
            if d.tzinfo is None:
                problems.append("date needs a timezone (use ...Z for UTC)")
            elif d < datetime.now(timezone.utc):
                problems.append(f"date {p['date']} is in the past")
        except ValueError:
            problems.append("date must be ISO 8601 UTC, e.g. 2026-10-14T12:30:00.000Z")
    if p.get("type") != "draft" and not p.get("posts"):
        problems.append("posts[] is required unless type is draft")
    for i, item in enumerate(p.get("posts", [])):
        if not item.get("integration", {}).get("id"):
            problems.append(f"posts[{i}].integration.id missing")
        if not item.get("settings", {}).get("__type"):
            problems.append(f"posts[{i}].settings.__type missing")
        for j, v in enumerate(item.get("value", [])):
            if not isinstance(v.get("content"), str):
                problems.append(f"posts[{i}].value[{j}].content missing")
            for m in v.get("image", []):
                if not (m.get("id") and m.get("path")):
                    problems.append(f"posts[{i}].value[{j}].image items need id and path")
    return problems


def build(pkg, post_type="draft", date=None, do_upload=False, uploaded=None):
    """Turn a post package into a Postiz create-post payload.

    Each package post needs `integration_id`. Media can be {id, path} objects (already uploaded),
    https URLs (uploaded via upload-from-url when do_upload), or local files (uploaded when do_upload).
    """
    if isinstance(pkg, (str, Path)):
        pkg = json.loads(Path(pkg).read_text(encoding="utf-8"))
    check_res = pkglib.validate(pkg)
    if not check_res["ok"]:
        raise MktError("Package invalid:\n- " + "\n- ".join(check_res["problems"]))
    if post_type not in ("now", "schedule", "draft"):
        raise MktError("type must be now | schedule | draft")
    if post_type == "schedule" and not date:
        raise MktError("--date (UTC ISO 8601) is required for type=schedule")
    date = date or iso(datetime.now(timezone.utc))
    cache = dict(uploaded or {})
    items = []
    for i, p in enumerate(pkg["posts"]):
        if not p.get("integration_id"):
            raise MktError(f"posts[{i}] ({p['platform']}): missing integration_id (see `postiz integrations`)")
        images = []
        for m in p.get("media", []):
            if isinstance(m, dict) and m.get("id") and m.get("path"):
                images.append({"id": m["id"], "path": m["path"]})
                continue
            src = str(m)
            if src not in cache:
                if not do_upload:
                    raise MktError(f"media '{src}' is not uploaded yet; pass --upload or upload it first")
                cache[src] = upload_from_url(src) if src.startswith("http") else upload(src)
            images.append({"id": cache[src]["id"], "path": cache[src]["path"]})
        value = [{"content": pkglib.compose(p), "image": images}]
        if p.get("first_comment"):
            value.append({"content": p["first_comment"], "image": []})
        plat = p["platform"]
        settings_obj = {"__type": plat, **DEFAULT_SETTINGS.get(plat, {})}
        if plat in ("linkedin", "linkedin-page") and len(images) > 1:
            settings_obj["post_as_images_carousel"] = True
            settings_obj["carousel_name"] = p.get("carousel_name") or p["hook"][:60]
        settings_obj.update(p.get("settings", {}))
        items.append({"integration": {"id": p["integration_id"]}, "value": value, "settings": settings_obj})
    payload = {"type": post_type, "date": date, "shortLink": False, "tags": [], "posts": items}
    problems = validate_payload(payload)
    if problems:
        raise MktError("Payload invalid:\n- " + "\n- ".join(problems))
    return {"payload": payload, "uploaded": cache}


def create(payload, approved=False):
    if isinstance(payload, (str, Path)):
        payload = json.loads(Path(payload).read_text(encoding="utf-8"))
    problems = validate_payload(payload)
    if problems:
        raise MktError("Payload not sent:\n- " + "\n- ".join(problems))
    if payload["type"] in ("now", "schedule") and not approved:
        raise MktError(f"type={payload['type']} publishes content. Get the user's explicit approval, then "
                       "re-run with --approved (CLI) or approved=true (MCP). Use type=draft to stage without approval.")
    return call("POST", "/posts", body=payload)


def delete(post_id):
    return call("DELETE", f"/posts/{post_id}")


def analytics_post(post_id, days=7):
    return call("GET", f"/analytics/post/{post_id}?date={days}")


def analytics_channel(integration_id, days=7):
    return call("GET", f"/analytics/{integration_id}?date={days}")
