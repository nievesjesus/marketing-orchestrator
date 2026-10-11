# Brand kit template

Copy with `python3 tools/scripts/mkt.py brand init <slug>` (goes to ~/.config/marketing-orchestrator/brands/<slug>)
or `--here` to keep it inside the repo's `tools/brands/` folder.

Files:
- `brand.json` — machine-readable fields (validated by `mkt.py brand validate <slug>`)
- `voice.md` — how the brand writes, with real examples
- `logo.png`, `logo-light.png` (for dark backgrounds), `logo-dark.png` (for light backgrounds) — transparent PNGs
- `style/` — 1–6 images that show the look you want; sent to Gemini as style references
