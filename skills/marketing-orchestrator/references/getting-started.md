# Getting started (first-time setup, ~5 minutes)

Walk the user through this **one step at a time, in their language**. Wait for "done" before moving on. Every step is optional: if they want to skip, write the post anyway.

Tell them what they'll get first, in one or two lines:
> "I can write your posts, make images and schedule everything. To do the last two, I need to connect two free tools: Canva (images) and Postiz (scheduling). Want to do it now? It takes about 5 minutes."

---

## Step A — Connect Canva (images and designs)

What it adds: create images, edit their photos, remove backgrounds, and make finished branded posts.

1. In Claude, open **Settings → Connectors**.
2. Find **Canva** in the list and click **Connect**.
3. A Canva window opens: sign in (or create a free account) and click **Allow**.
4. Back in the chat, turn Canva on for this conversation from the connectors menu (the **+** or tools button near the message box), if it isn't on already.

Check: call `list-brand-kits` or any harmless Canva tool. If it answers, say "Canva is connected ✅".

Good to know (say it simply, only if relevant):
- **Canva Free** includes about **20 AI uses per month** (image generation counts). It resets on the 1st.
- **Brand Kit** (saved colors, fonts, logo) needs a paid Canva plan (Pro or Teams). Without it, the brand card (step C) covers colors and style.

If they don't want Canva: see the other options in `image-generation.md` (Adobe, Figma, or making the image in the Gemini/ChatGPT app and uploading it).

---

## Step B — Connect Postiz (scheduling and publishing)

What it adds: see their calendar, suggest free times, and schedule posts to LinkedIn, Instagram, Facebook, X, TikTok and more.

**B1. Postiz account and networks** (skip parts they already have)
1. Go to postiz.com and create an account.
2. In Postiz, click **Add channel** and connect each social network they want (they'll log in to each one).

**B2. Get the connection link**
1. In Postiz, open **Settings → Developers → Public API** and copy the key.
2. Their link is: `https://mcp.postiz.com/mcp/` followed by that key, with no spaces.
   Help them build it, but **tell them not to paste the key or the link in the chat**: it works like a password.

**B3. Add it to Claude**
1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Name: `Postiz`. URL: the link from B2. Click **Add**.
3. Turn Postiz on in the conversation from the connectors menu.

Check: call `integrationList`. Show the networks found: "I can see your LinkedIn and Instagram ✅". If the list is empty, they need to add channels in Postiz (B1.2).

If the link leaks (pasted in a chat, a screenshot…): in Postiz, create a new key and replace the connector URL. The old one stops working.

On a team/company Claude plan, an admin may have to allow custom connectors first.

---

## Step C — Create the brand card

Run the short interview from SKILL.md section 2, fill `brand-card.md`, show it, and help them keep it:

**Recommended — a Claude Project (works on every device):**
1. In Claude, click **Projects → New project**, name it e.g. "Marketing".
2. Open the project's **Instructions** and paste the brand card.
3. From now on, start marketing chats inside that project.

Alternatives: save it to Claude's memory (only if they ask), or keep it as a note and paste it at the start of a chat.

If they have Canva Pro: also suggest creating a **Brand Kit** in Canva with their logo, colors and fonts, so Canva designs come out on-brand automatically.

---

## Step D — First post

Ask for 1–2 photos and one sentence about what they want to say. Then follow SKILL.md sections 3–7. Save the first one as a **draft** unless they clearly say to publish, so they can see how it looks in Postiz.

---

## When something doesn't work

| What the user sees | What to say / do |
|---|---|
| I can't find Settings → Connectors | They may be on a phone app or an older version: try claude.ai in a browser |
| "Add custom connector" isn't there | Their plan may not allow it, or an admin must enable it. Offer manual posting meanwhile |
| Canva says the AI limit is reached | Free plan limit; resets on the 1st. Offer another image option or their own photos |
| Postiz shows no networks | Add channels inside Postiz first |
| Postiz says unauthorized | The key changed; repeat B2–B3 with a new key |
| Anything else | Save the post as draft or give it ready to copy; never leave them without the text |
