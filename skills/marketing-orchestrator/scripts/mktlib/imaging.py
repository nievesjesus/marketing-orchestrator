"""Local image utilities (need Pillow): info/fit check, crop/pad to ratio, logo overlay, thumbnails."""
import io
from pathlib import Path

from .config import MktError
from . import brand as brandlib

RATIOS = {
    "linkedin": ["1:1", "4:5", "1.91:1"], "linkedin-page": ["1:1", "4:5", "1.91:1"],
    "instagram": ["4:5", "1:1"], "instagram-standalone": ["4:5", "1:1"], "instagram-story": ["9:16"],
    "tiktok": ["9:16"], "x": ["16:9", "1:1"], "facebook": ["1:1", "4:5"], "threads": ["4:5", "1:1"],
    "bluesky": ["16:9", "1:1"], "pinterest": ["2:3"], "youtube": ["16:9"],
}
MIN_SIDE = 1080
POSITIONS = {"top-left", "top-right", "bottom-left", "bottom-right", "center", "bottom-center", "top-center"}


def _pil():
    try:
        from PIL import Image
        return Image
    except ImportError:
        raise MktError("Pillow is required for this command: pip install pillow")


def _ratio(s):
    a, b = s.split(":")
    return float(a) / float(b)


def info(path):
    Image = _pil()
    p = Path(path)
    if not p.is_file():
        raise MktError(f"File not found: {path}")
    with Image.open(p) as im:
        w, h, fmt, mode = im.width, im.height, im.format, im.mode
    r = w / h
    fit = {}
    for plat, ratios in RATIOS.items():
        best = min(ratios, key=lambda x: abs(_ratio(x) - r))
        fit[plat] = {"ok": abs(_ratio(best) - r) / _ratio(best) < 0.03, "closest": best}
    warnings = []
    if min(w, h) < MIN_SIDE:
        warnings.append(f"short side {min(w, h)}px < {MIN_SIDE}px: may look soft on mobile")
    if fmt not in ("JPEG", "PNG", "GIF", "WEBP", "AVIF", "BMP", "TIFF", "MPO"):
        warnings.append(f"format {fmt} may be rejected by Postiz")
    return {"path": str(p.resolve()), "width": w, "height": h, "ratio": round(r, 3), "format": fmt,
            "mode": mode, "bytes": p.stat().st_size, "platform_fit": fit, "warnings": warnings}


def fit(path, aspect, out, mode="crop", color="#FFFFFF", anchor="center"):
    """crop: cut to ratio around anchor. pad: letterbox with a brand color."""
    Image = _pil()
    target = _ratio(aspect)
    with Image.open(path) as im:
        im = im.convert("RGBA") if mode == "pad" else im.convert("RGB")
        w, h = im.size
        if mode == "crop":
            if w / h > target:
                nw = int(h * target)
                x = {"left": 0, "right": w - nw}.get(anchor, (w - nw) // 2)
                box = (x, 0, x + nw, h)
            else:
                nh = int(w / target)
                y = {"top": 0, "bottom": h - nh}.get(anchor, (h - nh) // 2)
                box = (0, y, w, y + nh)
            res = im.crop(box)
        elif mode == "pad":
            if w / h > target:
                cw, ch = w, int(w / target)
            else:
                cw, ch = int(h * target), h
            res = Image.new("RGBA", (cw, ch), color)
            res.paste(im, ((cw - w) // 2, (ch - h) // 2), im)
            res = res.convert("RGB")
        else:
            raise MktError("mode must be crop or pad")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    res.save(out, quality=95)
    return {"out": str(Path(out).resolve()), "width": res.width, "height": res.height, "aspect": aspect, "mode": mode}


def _luminance(im):
    from PIL import ImageStat
    return ImageStat.Stat(im.convert("L")).mean[0] / 255


def overlay_logo(path, out, brand_slug=None, logo=None, position=None, scale=0.16,
                 margin=0.04, opacity=1.0, variant="auto"):
    Image = _pil()
    logos = {}
    if brand_slug:
        b = brandlib.load(brand_slug)
        logos = b["assets"]["logos"]
        position = position or b.get("visual", {}).get("logo_position", "bottom-right")
    if logo:
        logos = {"primary": logo}
    position = position or "bottom-right"
    if position not in POSITIONS:
        raise MktError(f"position must be one of {', '.join(sorted(POSITIONS))}")
    if not logos:
        raise MktError("No logo: pass --logo <file> or a brand with visual.logo set and the file present")

    with Image.open(path) as base:
        base = base.convert("RGBA")
        W, H = base.size
        m = int(min(W, H) * margin)
        target_w = int(W * scale)

        def place(lw, lh):
            xs = {"left": m, "right": W - lw - m, "center": (W - lw) // 2}
            ys = {"top": m, "bottom": H - lh - m, "center": (H - lh) // 2}
            if position == "center":
                return xs["center"], ys["center"]
            v, hpos = position.split("-")
            return xs[hpos], ys[v]

        chosen = variant
        if variant == "auto":
            # Look at the corner where the logo goes; light background -> dark logo and vice versa.
            probe_w, probe_h = target_w, max(1, target_w // 2)
            x, y = place(probe_w, probe_h)
            lum = _luminance(base.crop((x, y, x + probe_w, y + probe_h)))
            prefer = ["dark", "primary"] if lum > 0.6 else (["light", "primary"] if lum < 0.4 else ["primary"])
            chosen = next((k for k in prefer if k in logos), next(iter(logos)))
        if chosen not in logos:
            raise MktError(f"logo variant '{chosen}' not available; have {', '.join(logos)}")

        with Image.open(logos[chosen]) as lg:
            lg = lg.convert("RGBA")
            ratio = target_w / lg.width
            lg = lg.resize((target_w, max(1, int(lg.height * ratio))), Image.LANCZOS)
            if opacity < 1:
                alpha = lg.getchannel("A").point(lambda a: int(a * opacity))
                lg.putalpha(alpha)
            x, y = place(lg.width, lg.height)
            base.alpha_composite(lg, (x, y))
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        fmt_rgb = Path(out).suffix.lower() in (".jpg", ".jpeg")
        (base.convert("RGB") if fmt_rgb else base).save(out, quality=95)
    return {"out": str(Path(out).resolve()), "logo_variant": chosen, "position": position, "scale": scale}


def thumbnail_b64(path, max_side=1024):
    """JPEG preview for returning images inline over MCP. Returns (mime, b64) or None without Pillow."""
    import base64
    try:
        from PIL import Image
    except ImportError:
        return None
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
    return "image/jpeg", base64.b64encode(buf.getvalue()).decode()
