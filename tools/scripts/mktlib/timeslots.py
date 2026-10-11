"""Heuristic publish-time suggestions in the audience's timezone, returned in local time and UTC."""
from datetime import datetime, timedelta, timezone

from .config import MktError
from . import brand as brandlib

# weekday: 0=Mon..6=Sun -> list of (hour, minute) in audience local time. Mirrors references/platform-playbook.md.
WEEK = range(0, 5)
WINDOWS = {
    "linkedin": {d: [(8, 30), (13, 0)] for d in (1, 2, 3)} | {0: [(10, 30)], 4: [(9, 0)]},
    "instagram": {d: [(12, 0), (19, 30)] for d in WEEK} | {5: [(11, 0)], 6: [(11, 0)]},
    "instagram-story": {d: [(8, 30), (21, 0)] for d in range(7)},
    "x": {d: [(8, 30), (17, 30)] for d in WEEK},
    "threads": {d: [(10, 0), (20, 0)] for d in range(7)},
    "facebook": {d: [(10, 0), (13, 0)] for d in (1, 2, 3)},
    "tiktok": {d: [(19, 0), (21, 0)] for d in range(7)} | {5: [(11, 0), (20, 0)], 6: [(11, 0), (20, 0)]},
    "bluesky": {d: [(9, 30), (19, 0)] for d in WEEK},
    "pinterest": {5: [(21, 0)], 6: [(21, 0)], 4: [(20, 30)]},
    "youtube": {d: [(17, 0)] for d in (3, 4)} | {5: [(10, 0)]},
}
ALIASES = {"linkedin-page": "linkedin", "instagram-standalone": "instagram"}


def _zone(name):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        raise MktError(f"Unknown timezone '{name}'. On Windows run: pip install tzdata")


def suggest(platform, brand_slug=None, days=7, count=3, now=None, user_tz=None, audience_tz=None,
            busy=None, min_gap_hours=None):
    """busy: list of UTC ISO datetimes already scheduled on this channel."""
    key = ALIASES.get(platform, platform)
    if key not in WINDOWS:
        raise MktError(f"No timing heuristics for '{platform}'. Known: {', '.join(sorted(WINDOWS))}")
    brand = brandlib.load(brand_slug) if brand_slug else {}
    aud = _zone(audience_tz or brand.get("audience_timezone") or brand.get("timezone") or "UTC")
    usr = _zone(user_tz or brand.get("timezone") or "UTC")
    gap = min_gap_hours if min_gap_hours is not None else \
        (brand.get("min_spacing_hours") or {}).get(platform, (brand.get("min_spacing_hours") or {}).get("default", 24))
    now = now or datetime.now(timezone.utc)
    earliest = now + timedelta(minutes=30)
    busy_dt = [datetime.fromisoformat(b.replace("Z", "+00:00")) for b in (busy or [])]

    out = []
    start_local = now.astimezone(aud).date()
    for offset in range(days + 1):
        day = start_local + timedelta(days=offset)
        for hh, mm in WINDOWS[key].get(day.weekday(), []):
            local = datetime(day.year, day.month, day.day, hh, mm, tzinfo=aud)
            utc = local.astimezone(timezone.utc)
            if utc < earliest:
                continue
            if any(abs((utc - b).total_seconds()) < gap * 3600 for b in busy_dt):
                continue
            if any(abs((utc - datetime.fromisoformat(o["utc"].replace("Z", "+00:00"))).total_seconds()) < gap * 3600
                   for o in out):
                continue
            out.append({
                "utc": utc.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "audience_local": local.strftime("%a %d %b %H:%M ") + local.tzname(),
                "user_local": utc.astimezone(usr).strftime("%a %d %b %H:%M ") + utc.astimezone(usr).tzname(),
                "reason": f"{platform} heuristic window for {local.strftime('%A')} in {aud.key}",
            })
            if len(out) >= count:
                return {"platform": platform, "min_gap_hours": gap, "slots": out}
    return {"platform": platform, "min_gap_hours": gap, "slots": out}
