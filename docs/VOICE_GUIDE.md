# DocFlow Voice Guide

Every card comment, email, and status label speaks with ONE voice. This file is the
standard. If a message doesn't fit a skeleton below, the message is wrong — not the guide.

Voice: Apple-simple. Short lines. Generous whitespace. One idea per line. No hedging,
no filler, no re-explaining the whole flow in every comment. Name the specific fields
and labels — never "the employer fields". Tense matches timing: past when done,
present when running, `NEXT:` for what follows.

## The step header (every HR-facing card comment opens with it)

Every `logAction` comment starts with a uniform header locating the card in the
10-step packet flow:

```
▶ STEP X of 10 — SHORT STATE NAME
──────────────────────────────
WHAT HAPPENED: one sentence, past/present tense matching timing.

YOUR NEXT MOVE: what the HR person does now (labels quoted from config).
```

- Machine-automatic steps replace `YOUR NEXT MOVE:` with
  `NEXT: nothing — automatic. <what the machine does next>`.
- Optionally end with `WHY THIS MATTERS: …` where the reason isn't obvious
  (last-check gates, guards).
- Error comments keep the SYSTEM:/ERROR:/FIX: skeleton under the header, with
  the state name = the failing step (e.g. `▶ STEP 3 of 10 — ❌ LETTER FAILED`).
- Guard/no-op comments (⚠️/ℹ️) keep `WHY:` + the way out, under a header that
  shows the step the card is ACTUALLY at — not the step someone dragged to.
- The state name line keeps the emoji lexicon, e.g. `▶ STEP 5 of 10 — 📦 PACKET BUILT`.
- Live progress ticks (startProgress one-liners like `🛠️ 30s — …`) stay short,
  NO header.

**The 10 steps** (canonical packet flow):

| Step | State | Who |
|------|-------|-----|
| 1 | Imported / Welcome — hire lands on the board | machine |
| 2 | Hire Details — the 9 required fields (+ form sync / ADP fields) | person |
| 3 | Letter Built — review the PDF | machine → person |
| 4 | Package Approved — HR gate 1 | person |
| 5 | Packet Built — Adobe agreement assembled | machine |
| 6 | Ready to Send — the exact email preview | person |
| 7 | Sent — the send button fired | machine |
| 8 | Signing — out with the candidate | candidate |
| 9 | Signed & Filed — archive, SharePoint, confirmations | machine |
| 10 | Done — manual next steps | person |

## The email appears ONCE

The full welcome-email body appears exactly once in a card's thread: the STEP 6
"Ready to Send" preview. The STEP 7 sent confirmation never repeats the body —
it says `The email you previewed at STEP 6 was sent verbatim.` plus the
recipient and the HR reference links. Earlier steps may show the Subject line
only. Two copies of the same email in one thread means one of them is drift.

## Message anatomy (card comments)

Every comment has up to four parts, in this order:

1. **Headline** — one emoji + one sentence stating what just happened or is happening.
2. **Body** — the specifics. Exact field names, exact label text (always quoted from
   config, never hard-coded), one idea per line.
3. **`NEXT:`** — what happens now, and who does it (the machine or a person). Every
   comment that isn't terminal ends with this line.
4. **Inside note** (optional 2nd arg to `logAction`) — the technical audit line for IT.
   Never mixed into the HR-facing text.

## The emoji lexicon (fixed — never improvise)

| Emoji | Meaning | Example headline |
|-------|---------|------------------|
| 👋 | hire arrived | `👋 Jane is on the board.` |
| 🧲 | imported from ATS | `🧲 Imported from RPH Hiring…` |
| 🛠️ | building (first time) | `🛠️ Writing Jane's offer letter — about a minute.` |
| 🔁 | rebuilding after an edit | `🔁 A field changed. Rebuilding the letter…` |
| 📄 | letter ready for review | `📄 The offer letter is ready.` |
| 📦 | packet built | `📦 The packet is built.` |
| 📧 | email preview (draft, not sent) | `📧 Jane will receive this. Preview only — not sent.` |
| 📤 | sending now | `📤 Sending now.` |
| 📥 | form received | `📥 Welcome form received from Jane…` |
| ✅ | step confirmed / completed | `✅ Approved. Building the signing packet…` |
| 🎉 | celebration (signed, confirmed) | `🎉 Confirmation sent to jane@…` |
| 🗂️ | filed to SharePoint | `🗂️ Signed packet copied to SharePoint…` |
| 📋 | checklist | `📋 NEXT STEPS (manual):` |
| ✋ | needs human input to proceed | `✋ Two fields are still empty:` |
| ℹ️ | FYI / deliberate no-op | `ℹ️ Nothing to rebuild — …` |
| ⚠️ | blocked or risky — human decision | `⚠️ Not re-sending — paperwork already complete.` |
| ❌ | hard failure | `❌ Offer letter generation failed.` |
| 🛑 | human stopped the flow | `🛑 Offer marked Denied…` |
| 🚀 | downstream record started | `🚀 Onboarding started for Jane…` |

## The label vocabulary (fixed — the only caps labels allowed)

- `WHAT HAPPENED:` — the header's one-sentence event line
- `YOUR NEXT MOVE:` — what the HR person does now (human steps)
- `NEXT:` — what follows automatically (`NEXT: nothing — automatic. …` on machine steps)
- `WHY THIS MATTERS:` — optional closing line when the reason isn't obvious
- `WHY:` — the exact reason a guard fired (column ids allowed here)
- `FIX:` — the exact way out of an error
- `SYSTEM:` / `ERROR:` — error skeleton fields (see below)
- `THE ORDER:` — the step sequence, only in guard messages that reset the user
- `NEXT STEPS (manual):` — the post-Done checklist only

Anything else in ALL CAPS is drift. Rewrite it into one of these.

## Skeletons

**Progress** (machine is working):
```
🛠️ Writing Jane's offer letter — about a minute.
```
No NEXT line — the next comment IS the result.

**Result** (machine finished):
```
📦 The packet is built. Signing order: Jane Doe.

NEXT: read the email below. Looks right → select "⑦ 📤 Send Package" and it goes to Jane.
Something off → "④ ✋ More Info Needed"; fix the field and the letter rebuilds itself.
```

**Needs input**:
```
✋ Two fields are still empty:
    ADP Job Title
    Start Date

NEXT: fill them in — the letter builds the moment the last one lands.
```

**Guard / deliberate no-op** (never skip silently):
```
⚠️ Not re-sending — this hire's paperwork is already complete.

WHY: status is "⑦ 🎉 Done" and the signed offer is archived. Approving again would
email Jane a SECOND signing packet.

NEXT: if you truly need to redo the offer, move Onboarding Status off "⑦ 🎉 Done"
first, then ☑ Details Verified → review → approve.
```

**Error** (always this exact skeleton):
```
❌ Sending for signature failed.

SYSTEM: Adobe Sign
ERROR: <exact message, plus HTTP code / API body when present>

FIX: <the specific way out>. (The system also retries automatically.)
```

**Email preview** — the draft is FENCED so it can't be confused with instructions:
```
📧 Jane will receive this. Preview only — not sent.

— — — — — — — — — —
Subject: …

…body…
— — — — — — — — — —

NEXT: looks right → select "④ ✅ Package Approved". To change the wording, edit the
"package" row on the Email Templates board.
```

## Candidate emails (exactly two, ever)

- **Email 1 — Welcome** (on ⑦ Send Package): greeting by first name, the two action
  items (sign + info form), warm sign-off from "The MedWatchers HR Team". Three short
  paragraphs max.
- **Email 2 — Received** (on completion): thank-you, signed copy attached, what's
  ahead in plain words, warm sign-off. No corporate filler.

Candidate emails never contain internal vocabulary: no "packet status", no board or
column names, no step numbers.

## Hard rules

1. Labels come from config (`cfg.monday.offerLabels.*`, `cfg.monday.statusLabels.*`),
   quoted in the message exactly. Hard-coded label text is a bug (label drift).
2. Never let a guard skip silently — every no-op posts WHY and the way out.
3. The inside note (2nd `logAction` arg) is for IT: ids, queue names, API facts.
   HR text never mentions queue names, container names, or column ids — except inside
   `WHY:`/`ERROR:` lines where precision is the point.
4. Time promises are honest: "about a minute" only where that's real.
5. One comment per event. If two comments fire back-to-back for one event, merge them.
