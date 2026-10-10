"""Offline test suite. Run: python3 -m unittest discover -s tests -v"""
import base64
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "marketing-orchestrator"
SCRIPTS = SKILL / "scripts"
sys.path.insert(0, str(SCRIPTS))

TMP = tempfile.mkdtemp()
os.environ["MKT_HOME"] = TMP
os.environ["MKT_ENV_FILE"] = str(Path(TMP) / "none.env")
os.environ.pop("MKT_BRANDS_DIR", None)

from mktlib import brand, config, gemini, imaging, package, postiz, timeslots  # noqa: E402
from mktlib.config import MktError  # noqa: E402

try:
    from PIL import Image
except ImportError:
    Image = None

PNG_1PX = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f1d3e40000000049454e44ae426082")).decode()


def make_brand(slug="acme"):
    d = Path(TMP) / "brands" / slug
    (d / "style").mkdir(parents=True, exist_ok=True)
    data = json.loads((SKILL / "assets/brands/_template/brand.json").read_text())
    data.update({"slug": slug, "name": "Acme", "default_channels": ["linkedin"],
                 "hashtags": {"branded": ["#Acme"], "always": [], "never": ["spam"]}})
    data["visual"].update({"style": "flat illustration", "avoid": "neon",
                           "colors": {"primary": "#112233", "accent": "#FF5A1F"}})
    (d / "brand.json").write_text(json.dumps(data))
    (d / "voice.md").write_text("# Voice\nDirect.")
    if Image:
        Image.new("RGBA", (200, 80), (0, 0, 0, 255)).save(d / "logo-dark.png")
        Image.new("RGBA", (200, 80), (255, 255, 255, 255)).save(d / "logo-light.png")
        Image.new("RGBA", (200, 80), (255, 90, 31, 255)).save(d / "logo.png")
        Image.new("RGB", (64, 64), (17, 34, 51)).save(d / "style" / "ref1.png")
    return d


class TestSkillFormat(unittest.TestCase):
    def test_frontmatter(self):
        text = (SKILL / "SKILL.md").read_text()
        m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
        self.assertTrue(m, "frontmatter missing")
        fm = m.group(1)
        name = re.search(r"^name:\s*(.+)$", fm, re.M).group(1).strip()
        desc = re.search(r"^description:\s*(.+)$", fm, re.M).group(1).strip()
        self.assertEqual(name, SKILL.name)
        self.assertRegex(name, r"^[a-z0-9]+(-[a-z0-9]+)*$")
        self.assertLessEqual(len(name), 64)
        self.assertLessEqual(len(desc), 1024)
        self.assertLess(len(text.splitlines()), 500)

    def test_agent_neutral(self):
        text = (SKILL / "SKILL.md").read_text()
        for word in ("ToolSearch", "SendUserFile", "Read tool", "mcp__"):
            self.assertNotIn(word, text)

    def test_referenced_files_exist(self):
        text = (SKILL / "SKILL.md").read_text()
        for ref in set(re.findall(r"`(references/[\w\-.]+\.md)`", text)):
            self.assertTrue((SKILL / ref).is_file(), ref)


class TestBrand(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_brand()

    def test_list_and_load(self):
        slugs = [b["slug"] for b in brand.list_brands()]
        self.assertIn("acme", slugs)
        self.assertIn("example-coffee-shop", slugs)
        self.assertNotIn("_template", slugs)
        b = brand.load("acme")
        self.assertIn("Direct", b["voice_md"])
        if Image:
            self.assertIn("dark", b["assets"]["logos"])
            self.assertEqual(len(b["assets"]["style_refs"]), 1)

    def test_validate_and_learn(self):
        v = brand.validate("acme")
        self.assertIsInstance(v["todo_fields"], list)
        r = brand.learn("acme", "shorter hooks")
        self.assertIn("shorter hooks", r["added"])

    def test_missing(self):
        with self.assertRaises(MktError):
            brand.load("nope")

    def test_visual_prompt_skips_todo(self):
        p = brand.visual_prompt(brand.load("example-coffee-shop"))
        self.assertNotIn("TODO", p)

    def test_visual_prompt(self):
        p = brand.visual_prompt(brand.load("acme"))
        self.assertIn("#112233", p)
        self.assertIn("neon", p)


class TestGemini(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_brand()
        os.environ["GEMINI_API_KEY"] = "test-key"

    def test_dry_run_prompt(self):
        r = gemini.generate("A desk at sunrise", str(Path(TMP) / "x.png"), brand_slug="acme",
                            platform="linkedin", text="Ship it", logo_space="bottom-right", dry_run=True)
        self.assertEqual(r["aspect"], "4:5")
        self.assertIn('"Ship it"', r["prompt"])
        self.assertIn("#112233", r["prompt"])
        self.assertIn("bottom right", r["prompt"])

    def test_generate_content_parses_and_skips_thoughts(self):
        resp = {"candidates": [{"content": {"parts": [
            {"thought": True, "inlineData": {"mimeType": "image/png", "data": "AAAA"}},
            {"text": "here you go"},
            {"inlineData": {"mimeType": "image/png", "data": PNG_1PX}}]}}]}
        out = Path(TMP) / "gen" / "img.png"
        with mock.patch.object(gemini, "http_json", return_value=resp) as h:
            r = gemini.generate("x", str(out), use_brand_refs=False)
        self.assertEqual(len(r["files"]), 1)
        self.assertTrue(out.read_bytes().startswith(b"\x89PNG"))
        self.assertTrue(out.with_suffix(".json").is_file())
        url = h.call_args[0][1]
        self.assertIn(":generateContent", url)
        body = h.call_args[1]["body"]
        self.assertEqual(body["generationConfig"]["imageConfig"]["aspectRatio"], "1:1")
        self.assertNotIn("test-key", json.dumps(r))

    def test_auto_falls_back_to_interactions(self):
        err = MktError("404")
        err.status = 404
        resp = {"steps": [{"type": "model_output", "content": [{"type": "image", "mime_type": "image/png",
                                                                 "data": PNG_1PX}]}]}
        with mock.patch.object(gemini, "http_json", side_effect=[err, resp]) as h:
            r = gemini.generate("x", str(Path(TMP) / "fb.png"), use_brand_refs=False)
        self.assertEqual(r["api"], "interactions")
        self.assertIn("/interactions", h.call_args[0][1])
        self.assertFalse(h.call_args[1]["body"]["store"])

    def test_no_image_raises(self):
        with mock.patch.object(gemini, "http_json", return_value={"candidates": [{"finishReason": "SAFETY"}]}):
            with self.assertRaises(MktError):
                gemini.generate("x", str(Path(TMP) / "none.png"), use_brand_refs=False)

    def test_lite_forces_1k_and_bad_aspect(self):
        r = gemini.generate("x", "o.png", model="gemini-3.1-flash-lite-image", dry_run=True)
        self.assertEqual(r["size"], "1K")
        with self.assertRaises(MktError):
            gemini.generate("x", "o.png", aspect="7:3", dry_run=True)


@unittest.skipUnless(Image, "Pillow not installed")
class TestImaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_brand()
        cls.light = Path(TMP) / "light.png"
        Image.new("RGB", (1600, 900), (250, 250, 250)).save(cls.light)

    def test_info(self):
        r = imaging.info(self.light)
        self.assertTrue(r["platform_fit"]["x"]["ok"])
        self.assertFalse(r["platform_fit"]["instagram"]["ok"])

    def test_fit_crop_and_pad(self):
        c = imaging.fit(self.light, "4:5", str(Path(TMP) / "c.png"))
        self.assertAlmostEqual(c["width"] / c["height"], 0.8, places=2)
        p = imaging.fit(self.light, "9:16", str(Path(TMP) / "p.png"), mode="pad", color="#112233")
        self.assertAlmostEqual(p["width"] / p["height"], 9 / 16, places=2)

    def test_overlay_picks_dark_logo_on_light_bg(self):
        r = imaging.overlay_logo(str(self.light), str(Path(TMP) / "l.png"), brand_slug="acme")
        self.assertEqual(r["logo_variant"], "dark")
        self.assertEqual(r["position"], "bottom-right")
        with Image.open(r["out"]) as im:
            self.assertEqual(im.getpixel((im.width - 60, im.height - 60))[:3], (0, 0, 0))

    def test_thumbnail(self):
        mime, data = imaging.thumbnail_b64(self.light, 256)
        self.assertEqual(mime, "image/jpeg")
        self.assertTrue(base64.b64decode(data).startswith(b"\xff\xd8"))


class TestTimeslots(unittest.TestCase):
    def test_suggest_linkedin(self):
        now = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)  # Saturday
        r = timeslots.suggest("linkedin", audience_tz="America/Argentina/Buenos_Aires",
                              user_tz="America/Argentina/Buenos_Aires", now=now, count=3, min_gap_hours=24)
        self.assertEqual(len(r["slots"]), 3)
        first = r["slots"][0]
        self.assertTrue(first["audience_local"].startswith("Mon 12 Oct 10:30"))
        self.assertEqual(first["utc"], "2026-10-12T13:30:00.000Z")

    def test_busy_respected(self):
        now = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
        r = timeslots.suggest("linkedin", audience_tz="UTC", user_tz="UTC", now=now, count=1,
                              busy=["2026-10-12T10:00:00Z"], min_gap_hours=24)
        self.assertNotEqual(r["slots"][0]["utc"][:10], "2026-10-12")

    def test_unknown_platform(self):
        with self.assertRaises(MktError):
            timeslots.suggest("myspace")


def sample_pkg(**over):
    post = {"platform": "linkedin", "integration_id": "int-1", "objective": "authority",
            "audience": "eng leaders", "hook": "We stopped deploying on Fridays.",
            "body": "Here is why.", "cta": "How does your team do it?",
            "hashtags": ["#DevOps", "EngineeringLeadership"], "first_comment": "Link: https://x.y"}
    post.update(over)
    return {"brand": "acme", "posts": [post]}


class TestPackage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_brand()

    def test_compose(self):
        t = package.compose(sample_pkg()["posts"][0])
        self.assertTrue(t.startswith("We stopped"))
        self.assertIn("#EngineeringLeadership", t)
        self.assertEqual(package.compose({"hook": "H", "body": "H and more"}), "H and more")

    def test_validate_ok_and_errors(self):
        self.assertTrue(package.validate(sample_pkg())["ok"])
        bad = package.validate(sample_pkg(platform="x", body="y" * 400, hashtags=["#spam"]))
        self.assertFalse(bad["ok"])
        joined = " ".join(bad["problems"])
        self.assertIn("280", joined)
        self.assertIn("never-list", joined)
        ig = package.validate(sample_pkg(platform="instagram"))
        self.assertIn("requires at least one", " ".join(ig["problems"]))


class TestPostiz(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_brand()
        os.environ["POSTIZ_API_KEY"] = "pz-secret"

    def test_build_with_upload_and_carousel(self):
        files = []
        for i in range(2):
            f = Path(TMP) / f"m{i}.png"
            f.write_bytes(base64.b64decode(PNG_1PX))
            files.append(str(f))
        pkg = sample_pkg(media=files, alt_text=["a", "b"])
        with mock.patch.object(postiz, "call", side_effect=[{"id": "m0", "path": "https://u/0.png"},
                                                            {"id": "m1", "path": "https://u/1.png"}]) as c:
            r = postiz.build(pkg, "schedule", "2099-01-01T10:00:00.000Z", do_upload=True)
        self.assertEqual(c.call_count, 2)
        item = r["payload"]["posts"][0]
        self.assertEqual(item["settings"]["__type"], "linkedin")
        self.assertTrue(item["settings"]["post_as_images_carousel"])
        self.assertEqual(len(item["value"]), 2)  # post + first comment
        self.assertEqual(item["value"][0]["image"][1]["id"], "m1")
        body = c.call_args_list[0][1]["raw_body"]
        self.assertIn(b'name="file"', body)

    def test_build_requires_upload_flag(self):
        f = Path(TMP) / "m.png"
        f.write_bytes(base64.b64decode(PNG_1PX))
        with self.assertRaises(MktError):
            postiz.build(sample_pkg(media=[str(f)]))

    def test_create_guard(self):
        payload = postiz.build(sample_pkg(), "schedule", "2099-01-01T10:00:00.000Z")["payload"]
        with self.assertRaises(MktError):
            postiz.create(payload)
        with mock.patch.object(postiz, "call", return_value=[{"postId": "p1"}]) as c:
            self.assertEqual(postiz.create(payload, approved=True)[0]["postId"], "p1")
            c.assert_called_once()
        draft = dict(payload, type="draft")
        with mock.patch.object(postiz, "call", return_value=[{"postId": "p2"}]):
            postiz.create(draft)

    def test_validate_payload_past_date(self):
        payload = postiz.build(sample_pkg(), "draft")["payload"]
        payload.update(type="schedule", date="2020-01-01T00:00:00.000Z")
        self.assertTrue(any("past" in p for p in postiz.validate_payload(payload)))

    def test_auth_header_and_no_secret_in_errors(self):
        import urllib.error
        captured = {}

        def fake_urlopen(req, timeout=0):
            captured["auth"] = req.get_header("Authorization")
            raise urllib.error.HTTPError(req.full_url, 401, "no", {}, io.BytesIO(b"bad key"))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(MktError) as ctx:
                postiz.integrations()
        self.assertEqual(captured["auth"], "pz-secret")
        self.assertNotIn("pz-secret", str(ctx.exception))


class TestEnv(unittest.TestCase):
    def test_env_file_does_not_override(self):
        f = Path(TMP) / "t.env"
        f.write_text('export FOO_MKT="from file"\nBAR_MKT=2\n# c\n')
        os.environ["BAR_MKT"] = "1"
        self.assertEqual(config._parse_env_file(f)["FOO_MKT"], "from file")
        config._loaded = False
        with mock.patch.object(config, "env_files", return_value=[f]):
            config.load_env()
        self.assertEqual(os.environ["FOO_MKT"], "from file")
        self.assertEqual(os.environ["BAR_MKT"], "1")


class TestCLIAndMCP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_brand()

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / "mkt.py"), *args], capture_output=True, text=True,
                              env={**os.environ})

    def test_cli_brand_list_and_error(self):
        r = self.run_cli("brand", "list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("acme", r.stdout)
        r = self.run_cli("brand", "show", "nope")
        self.assertEqual(r.returncode, 2)
        self.assertIn("error", json.loads(r.stderr))

    def test_cli_time_and_doctor(self):
        r = self.run_cli("time", "suggest", "--platform", "x", "--audience-tz", "UTC", "--user-tz", "UTC")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(json.loads(r.stdout)["slots"])
        env = {k: v for k, v in os.environ.items() if k not in ("POSTIZ_API_KEY", "GEMINI_API_KEY")}
        r = subprocess.run([sys.executable, str(SCRIPTS / "mkt.py"), "doctor"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["keys"]["POSTIZ_API_KEY"], "missing")

    def test_mcp_handshake_and_calls(self):
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "brand_list", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
             "params": {"name": "postiz_create", "arguments": {"payload": {"type": "now", "date": "2099-01-01T00:00:00Z",
                        "shortLink": False, "tags": [], "posts": [{"integration": {"id": "i"},
                        "value": [{"content": "x", "image": []}], "settings": {"__type": "x"}}]}}}},
            {"jsonrpc": "2.0", "id": 5, "method": "nope"},
        ]
        stdin = "\n".join(json.dumps(m) for m in msgs) + "\n"
        r = subprocess.run([sys.executable, str(SCRIPTS / "mcp_server.py")], input=stdin, capture_output=True,
                           text=True, env={**os.environ}, timeout=30)
        lines = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual([l["id"] for l in lines], [1, 2, 3, 4, 5])
        self.assertEqual(lines[0]["result"]["protocolVersion"], "2025-06-18")
        names = {t["name"] for t in lines[1]["result"]["tools"]}
        self.assertTrue({"image_generate", "postiz_upload", "brand_get", "postiz_create"} <= names)
        self.assertIn("acme", lines[2]["result"]["content"][0]["text"])
        self.assertTrue(lines[3]["result"]["isError"])
        self.assertIn("approval", lines[3]["result"]["content"][0]["text"])
        self.assertEqual(lines[4]["error"]["code"], -32601)


if __name__ == "__main__":
    unittest.main()
