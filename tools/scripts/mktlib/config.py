"""Shared config: paths, .env loading, HTTP helper, errors. Stdlib only."""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[2]  # <repo>/tools (this file: tools/scripts/mktlib/config.py)
USER_DIR = Path(os.environ.get("MKT_HOME", Path.home() / ".config" / "marketing-orchestrator"))


class MktError(Exception):
    """Expected, user-facing error. Message must never contain secrets."""


def _parse_env_file(path):
    out = {}
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().removeprefix("export ").strip()
            v = v.strip().strip('"').strip("'")
            out[k] = v
    except OSError:
        pass
    return out


def env_files():
    files = []
    if os.environ.get("MKT_ENV_FILE"):
        files.append(Path(os.environ["MKT_ENV_FILE"]))
    files += [Path.cwd() / ".env", USER_DIR / ".env", TOOLS_DIR / ".env"]
    return files


_loaded = False


def load_env():
    """Load .env files without overriding variables already in the environment."""
    global _loaded
    if _loaded:
        return
    for f in env_files():
        for k, v in _parse_env_file(f).items():
            os.environ.setdefault(k, v)
    _loaded = True


def env(name, default=None, required=False, hint=""):
    load_env()
    val = os.environ.get(name, default)
    if required and not val:
        raise MktError(f"{name} is not set. {hint}".strip())
    return val


def brand_dirs():
    """Brand search path: explicit override, user dir, then the repo's bundled brands (tools/brands)."""
    dirs = []
    if os.environ.get("MKT_BRANDS_DIR"):
        dirs.append(Path(os.environ["MKT_BRANDS_DIR"]))
    dirs += [USER_DIR / "brands", TOOLS_DIR / "brands"]
    return dirs


def http_json(method, url, headers=None, body=None, raw_body=None, timeout=120, service="API"):
    h = {"Accept": "application/json"}
    h.update(headers or {})
    data = raw_body
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read().decode() or "null"
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:1500]
        hints = {
            400: "Bad request - check the payload fields.",
            401: "Credentials missing or not recognised.",
            403: "Forbidden - plan/permissions, or a network allowlist blocking this host.",
            404: "Endpoint or model not found - check the URL/model id.",
            429: "Rate limit hit. Wait before retrying; do not loop.",
        }
        err = MktError(f"{service} HTTP {e.code} on {method} {_safe(url)}: {detail}\n{hints.get(e.code, '')}".strip())
        err.status = e.code
        raise err
    except urllib.error.URLError as e:
        raise MktError(f"Cannot reach {service} at {_safe(url)}: {e.reason}. "
                       "If you are in a sandbox, this host may not be on the network allowlist.")
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return {"raw": txt}


def _safe(url):
    """Strip query strings so a key passed by mistake never shows up in errors."""
    return url.split("?", 1)[0]
