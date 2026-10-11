# Third-party notices

Marketing Orchestrator is released under the MIT License (see `LICENSE`). Some of its instructions include portions adapted from the work of others, listed here with their licenses.

## Marketing plugin for Claude (knowledge-work-plugins)

- **Source:** the Marketing plugin (`marketing/`), version 1.2.0, in the repository https://github.com/anthropics/knowledge-work-plugins by Anthropic.
- **License:** Apache License, Version 2.0. The full text is in `LICENSES/Apache-2.0.txt` (a copy of the `LICENSE` file of that plugin).
- **Changes made:** the material was **modified**: condensed, rewritten in our own words for social media campaigns and for non-technical users, adapted to the Postiz and Marketing Images connectors, and extended with new content. Example figures and statistics from the original were not copied.
- **Not affiliated:** this project is not affiliated with, sponsored by or endorsed by Anthropic.

### What was adapted, and from where

| File in this project | Adapted from (skill of the Marketing plugin) | What |
|---|---|---|
| `skills/marketing-orchestrator/SKILL.md` | `campaign-plan`, `brand-review`, `performance-report`, `content-creation` | Condensed campaign steps, brand check, check-in report and hook / call-to-action guidance |
| `skills/marketing-orchestrator/references/campaigns.md` | `campaign-plan`, `email-sequence` | Goal → audience → message → channels → calendar framework, calendar planning rules, and the launch and re-engagement arcs |
| `skills/marketing-orchestrator/references/brand-card.md` | `brand-review` | Voice attributes in "we are / we are not" form and tone by channel |
| `skills/marketing-orchestrator/references/brand-check.md` | `brand-review` | Voice, terminology and claims review |
| `skills/marketing-orchestrator/references/reports.md` | `performance-report` | Summary, metrics table with status, what worked and what didn't, prioritized next steps |

Each adapted file also carries a first-line comment saying so. Both the skill zip and the plugin zip ship this file and `LICENSES/Apache-2.0.txt`.

## Other components in this repository

These are not part of the skill or plugin zips.

- **Fonts** bundled with the Marketing Images server (`servers/marketing-images/fonts/`: Outfit, Work Sans, Bricolage Grotesque, Lora, Instrument Serif, Young Serif) are licensed under the SIL Open Font License 1.1. License texts: `servers/marketing-images/fonts/LICENSES/`.
- **Node dependencies** of the server are under their own licenses; see `servers/marketing-images/package.json` and `package-lock.json`.
