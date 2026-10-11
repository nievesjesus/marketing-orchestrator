#!/usr/bin/env python3
"""Minimal stdio MCP server exposing the marketing-orchestrator actions. Stdlib only.

Run:  python3 mcp_server.py
Register it in Claude Desktop, Claude Code, Codex, Cursor… (see tools/docs/setup.md).
It complements the official Postiz MCP: brand kits, Gemini images, local file upload to Postiz,
timing suggestions, package validation and guarded post creation.
"""
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mktlib import __version__  # noqa: E402
from mktlib import brand, gemini, imaging, package, postiz, timeslots  # noqa: E402
from mktlib.config import MktError, USER_DIR, env  # noqa: E402

PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]


def S(props, required=()):
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


STR, NUM, INT, BOOL = {"type": "string"}, {"type": "number"}, {"type": "integer"}, {"type": "boolean"}
ARR = {"type": "array", "items": {"type": "string"}}


def _with_preview(result, path_key="files"):
    """Attach a JPEG preview so the model can actually see generated/edited images."""
    paths = result.get(path_key) if path_key == "files" else [result.get(path_key)]
    blocks = [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]
    for p in (paths or [])[:2]:
        thumb = imaging.thumbnail_b64(p) if p else None
        if thumb:
            blocks.append({"type": "image", "mimeType": thumb[0], "data": thumb[1]})
    return blocks


TOOLS = {
    "brand_list": ("List available brand kits.", S({}), lambda a: brand.list_brands()),
    "brand_get": ("Get a brand kit: voice, audiences, pillars, colors, fonts, logos, hashtags, timezone, defaults, "
                  "learned preferences and TODO fields.", S({"slug": STR}, ["slug"]), lambda a: brand.load(a["slug"])),
    "brand_learn": ("Append a learned preference to a brand (e.g. 'shorter hooks, no emoji').",
                    S({"slug": STR, "lesson": STR}, ["slug", "lesson"]), lambda a: brand.learn(a["slug"], a["lesson"])),
    "image_generate": (
        "Generate or edit an image with Gemini (Nano Banana). Injects the brand's visual style and style references. "
        "Costs money: confirm the brief with the user first. Returns saved file paths and a preview.",
        S({"prompt": STR, "out": {"type": "string", "description": "output file path, e.g. out/post.png"},
           "brand": STR, "platform": STR, "aspect": STR, "size": STR, "refs": ARR,
           "text": {"type": "string", "description": "exact text to render in the image, if any"},
           "logo_space": STR, "model": STR, "dry_run": BOOL}, ["prompt", "out"]),
        lambda a: ("preview", gemini.generate(a["prompt"], a["out"], a.get("brand"), a.get("platform"), a.get("aspect"),
                                              a.get("size"), a.get("refs"), a.get("text"), a.get("logo_space"),
                                              a.get("model"), "auto", True, a.get("dry_run", False)))),
    "image_overlay_logo": (
        "Stamp the brand's real logo on an image (auto-picks light/dark variant by background).",
        S({"image": STR, "out": STR, "brand": STR, "logo": STR, "position": STR, "scale": NUM}, ["image", "out"]),
        lambda a: ("preview_out", imaging.overlay_logo(a["image"], a["out"], a.get("brand"), a.get("logo"),
                                                       a.get("position"), a.get("scale", 0.16)))),
    "image_fit": ("Crop or pad an image to an aspect ratio (e.g. 4:5, 9:16).",
                  S({"image": STR, "aspect": STR, "out": STR, "mode": STR, "color": STR}, ["image", "aspect", "out"]),
                  lambda a: ("preview_out", imaging.fit(a["image"], a["aspect"], a["out"], a.get("mode", "crop"),
                                                        a.get("color", "#FFFFFF")))),
    "image_info": ("Dimensions, ratio and per-platform fit of an image.", S({"image": STR}, ["image"]),
                   lambda a: imaging.info(a["image"])),
    "time_suggest": ("Suggest publish slots (audience timezone heuristics, spacing vs. busy slots). "
                     "Returns local and UTC times.",
                     S({"platform": STR, "brand": STR, "days": INT, "count": INT, "busy": ARR}, ["platform"]),
                     lambda a: timeslots.suggest(a["platform"], a.get("brand"), a.get("days", 7), a.get("count", 3),
                                                 busy=a.get("busy"))),
    "package_validate": ("Validate a post package (object) for required fields, lengths, hashtags, media.",
                         S({"package": {"type": "object"}}, ["package"]), lambda a: package.validate(a["package"])),
    "postiz_integrations": ("List connected Postiz channels.", S({}), lambda a: postiz.integrations()),
    "postiz_settings": ("Posting rules and settings schema for a Postiz channel.", S({"integration_id": STR}, ["integration_id"]),
                        lambda a: postiz.settings(a["integration_id"])),
    "postiz_find_slot": ("Next free Postiz slot for a channel (UTC).", S({"integration_id": STR}, ["integration_id"]),
                         lambda a: postiz.find_slot(a["integration_id"])),
    "postiz_posts": ("Posts scheduled in a window.", S({"days": INT, "start": STR}),
                     lambda a: postiz.posts(a.get("days", 14), a.get("start"))),
    "postiz_upload": ("Upload a local image/video file to Postiz; returns {id, path} for post payloads.",
                      S({"file": STR}, ["file"]), lambda a: postiz.upload(a["file"])),
    "postiz_build": ("Build a Postiz create-post payload from a post package. Does not send anything.",
                     S({"package": {"type": "object"}, "type": STR, "date": STR, "upload": BOOL}, ["package"]),
                     lambda a: postiz.build(a["package"], a.get("type", "draft"), a.get("date"), a.get("upload", False))),
    "postiz_create": ("Create post(s) in Postiz. type now/schedule requires approved=true, which you may set ONLY "
                      "after the user explicitly approved this exact content and time in the conversation.",
                      S({"payload": {"type": "object"}, "approved": BOOL}, ["payload"]),
                      lambda a: postiz.create(a["payload"], a.get("approved", False))),
}


def _workdir():
    return Path(env("MKT_OUTPUT_DIR", str(USER_DIR / "output"))).expanduser()


def _resolve_paths(args):
    """The client decides the server's cwd, so relative paths are anchored to MKT_OUTPUT_DIR."""
    a = dict(args or {})
    wd = _workdir()
    if a.get("out") and not Path(a["out"]).expanduser().is_absolute():
        a["out"] = str(wd / a["out"])
    for k in ("image", "file", "logo"):
        if a.get(k):
            p = Path(a[k]).expanduser()
            a[k] = str(p if p.is_absolute() or p.exists() else wd / p)
    if a.get("refs"):
        a["refs"] = [str(Path(r).expanduser()) if Path(r).expanduser().is_absolute() or Path(r).exists()
                     else str(wd / r) for r in a["refs"]]
    return a


def call_tool(name, args):
    if name not in TOOLS:
        return {"isError": True, "content": [{"type": "text", "text": f"Unknown tool {name}"}]}
    try:
        res = TOOLS[name][2](_resolve_paths(args))
        if isinstance(res, tuple) and res[0] == "preview":
            return {"content": _with_preview(res[1], "files")}
        if isinstance(res, tuple) and res[0] == "preview_out":
            return {"content": _with_preview(res[1], "out")}
        return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}]}
    except MktError as e:
        return {"isError": True, "content": [{"type": "text", "text": str(e)}]}
    except Exception as e:  # never crash the server
        traceback.print_exc(file=sys.stderr)
        return {"isError": True, "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}]}


def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:  # notification
        return None
    if method == "initialize":
        req = (msg.get("params") or {}).get("protocolVersion")
        ver = req if req in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        result = {"protocolVersion": ver, "capabilities": {"tools": {"listChanged": False}},
                  "serverInfo": {"name": "marketing-orchestrator", "version": __version__},
                  "instructions": "Marketing actions: brand kits, Gemini images, Postiz upload/scheduling. "
                                  "Never call postiz_create with approved=true without explicit user approval."}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [{"name": n, "description": d, "inputSchema": s} for n, (d, s, _) in TOOLS.items()]}
    elif method == "tools/call":
        p = msg.get("params") or {}
        result = call_tool(p.get("name"), p.get("arguments"))
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            resp = handle(msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
