# Getting started (first-time setup, about 10 minutes)

Walk the user through this **one step at a time, in their language**. Wait for "done" before moving on. Every step is optional: if they want to skip, write the post anyway.

Say first what they will get, in one or two lines:
> "I can plan your campaigns, write your posts, make branded graphics and schedule everything. For the last two I need to connect two tools: Postiz (scheduling) and Marketing Images (graphics). Want to do it now? About 10 minutes, I'll guide you."

## What they need (check before starting)

- **Claude Pro or higher.** The Free plan allows only one custom connector and this setup uses two.
- **Code execution and file creation turned ON** (Settings → Capabilities). Skills need it.
- **A Postiz account** with their social networks added: Postiz Cloud (a paid service with a trial; current prices at postiz.com) or a Postiz they already have or that someone hosts for them. It must be **version 2.25 or newer** (older versions can't upload images from a link).
- **A personal Marketing Images link**, handed over privately by whoever runs the connector (the owner). It looks like `https://<host>/mcp/<token>` and works like a password.

Connectors are added once on the **web or Desktop** app; after that they also work in the mobile app.

---

## Step A. Install the assistant (skill or plugin)

Skip this if it's already installed (you are reading this because it is).

1. In Claude, open **Customize**.
2. Plugin file: **Plugins → Add → Upload plugin**. Skill-only file: **Skills → Upload**. Pick the file the owner gave them.
3. On a Team or company plan an admin may have to allow it; then offer to continue without scheduling for now.

Developer tools (Claude Code, Codex, Cursor) read the skill folder directly; see `AGENTS.md` in the repository. Only mention this to users who say they use those tools.

---

## Step B. Connect Postiz (scheduling and publishing)

What it adds: the calendar, free time slots, and drafts or scheduled posts on LinkedIn, Instagram, Facebook, X, TikTok and more.

**B1. Account and networks** (skip what they already have)
1. Create an account at postiz.com (or log in to their Postiz).
2. Click **Add channel** and connect each network they want. Each one asks them to log in.

**B2. Copy the key**
1. In Postiz open **Settings → Developers → Public API** and copy the key.

**B3. Build the link** (they do this in the connector form, never in the chat)
- Postiz Cloud: `https://mcp.postiz.com/mcp/` followed by the key, no spaces.
- Self-hosted Postiz: `https://<their-postiz-domain>/api/mcp/` followed by the key.
Tell them clearly: **don't paste the key or the link in the chat**, it works like a password.

**B4. Add it to Claude**
1. **Customize → Connectors → Add custom connector**.
2. Name `Postiz`, URL = the link from B3, click **Add**.
3. In the chat, turn Postiz on from the connectors menu (the **+** or tools button near the message box).

Check: call `integrationList` and show what you see: "I can see your LinkedIn and Instagram". Also check that `uploadFromUrlTool` exists. If it doesn't, their Postiz is older than 2.25: tell them images will have to be added by hand in Postiz → Media until it's updated (details in `postiz-mcp.md`).

If the link leaks (pasted in a chat, a screenshot…): in Postiz create a new key and replace the connector link. The old one stops working.

---

## Step C. Connect Marketing Images (graphics)

What it adds: AI backgrounds, finished post graphics with exact text, brand colors and logo, carousels, in every common size.

1. Get the personal link from the owner, privately (never in a public chat or a screenshot).
2. **Customize → Connectors → Add custom connector**.
3. Name `Marketing Images`, URL = the personal link, click **Add**. If it asks for sign-in, choose none: the link itself is the key.
4. In the chat, turn it on from the connectors menu.

Check: call `list_providers`. Say what's available and what is left for today: "Ready: 3 image services, and you have N images left today."

Claude Code, Codex and Cursor users: see `marketing-images.md`.

---

## Step D. Brand: the card and the saved look

Run the interview from SKILL.md section 2 and write the card with `brand-card.md`.

1. **Brand card** (voice, audience, rules): show it, then help them keep it: **Projects → New project**, name it "Marketing", open the project's **Instructions**, paste the card. From now on they start marketing chats inside that project (it works on every device).
2. **Saved look** (colors, fonts, logo): for the logo file, use Postiz `uploadWidgetTool` so the upload widget appears in the chat, then use the returned link. Save it with `save_brand`, show the brand sheet picture, and ask "Does this look like you?" Adjust and save again if they want changes.

---

## Step E. First post

Ask for 1–2 photos (or offer to make an image) and one sentence about what they want to say. Then follow SKILL.md sections 5–10. Save the first one as a **draft** unless they clearly say to publish, so they can see how it looks in Postiz.

---

## When something doesn't work

| What the user sees | What to say or do |
|---|---|
| Can't find Customize → Connectors | They may be on the phone app or an old version: use claude.ai in a browser, then come back to the phone |
| "Add custom connector" is missing or blocked | Their plan may not allow it, or an admin must enable it. Offer manual posting meanwhile |
| It only lets them add one connector | The Free plan allows one custom connector. Pro or higher is needed for both; offer Postiz first (scheduling) or keep going with their own photos |
| Postiz shows no networks | Add channels inside Postiz first (B1) |
| Postiz says unauthorized | The key changed: repeat B2–B4 with a new key |
| Marketing Images says the link isn't valid | The link was mistyped or revoked: ask the owner for a new link |
| "Daily limit reached" | The daily allowance of images or graphics is used up; it resets at 00:00 UTC. Offer own photos or try tomorrow |
| Anything else | Save the post as a draft or give it ready to copy; never leave them without the text |
