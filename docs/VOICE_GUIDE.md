# DocFlow Voice Guide

Every card comment, email, and status label speaks with ONE voice. This file is the
standard. If a message doesn't fit a skeleton below, the message is wrong — not the guide.

## The voice: DocFlow speaks as "I"

DocFlow is the narrator doing the work, and it says so in first person. It is
quietly confident, precise, and warm — never chatty, never corporate.

- **"I" is the subject of machine sentences.** "I'm writing Francisco's letter —
  about a minute." · "Built. Read it over:" · "Sent. Francisco signs from that
  email; I'll post here the second the signed packet lands."
- **Short lines. Generous whitespace. One idea per line.** Every word earns its
  place. Name the specific fields and labels — never "the employer fields".
- **Tense matches timing**: past when done ("Built."), present when running
  ("I'm writing…"), `Next →` for what follows — in DocFlow's voice
  ("Next → I build the packet and show you the exact email.").
- **Wit is a smudge, not a splash.** Allowed: timing brags where real ("about a
  minute — usually less"), quiet confidence. Banned: exclamation spam, jokes in
  errors or guards, cutesy names.
- **No redundant reassurance.** If a fact was already stated above, don't restate
  it after the action line. If the reassurance IS the point (the two-gate
  safety), one short clause max.
- **Candidate emails are NOT in the DocFlow persona.** They come from
  "MedWatchers HR" in a warm human voice — no "I", no internal vocabulary.

## The step header (every HR-facing card comment opens with it)

```
◆ DocFlow · X of 10 — Sentence-case name
──────────────────────────────
```

- `◆ DocFlow · X of 10 — <name>` — no "STEP", no emoji in the header name, no ALL-CAPS.
- The first line after the divider IS the event sentence, in DocFlow's first
  person. No `WHAT HAPPENED:` label — just write the sentence.
- Live progress ticks (startProgress one-liners like `🛠️ 30s — …`) stay short, NO header.

**The 10 steps** (canonical packet flow):

| Step | State | Who |
|------|-------|-----|
| 1 | Imported / Welcome — hire lands on the board | machine |
| 2 | Hire details — the 9 required fields (+ form sync / ADP fields) | person |
| 3 | Letter built — review the PDF | machine → person |
| 4 | Package approved — HR gate 1 | person |
| 5 | Packet built — Adobe agreement assembled | machine |
| 6 | Ready to send — the exact email preview | person |
| 7 | Sent — the send button fired | machine |
| 8 | Signing — out with the candidate | candidate |
| 9 | Signed & filed — archive, SharePoint, confirmations | machine |
| 10 | Done — manual next steps | person |

## The full skeleton

```
◆ DocFlow · 6 of 10 — Ready to send
──────────────────────────────
I built the packet. Signing order: Francisco Lopez.
Below is word-for-word what Francisco receives.

<body / fenced email / checklist>

Over to you
    ✓ Looks right → select "⑦ 📤 Send Package"
    ✎ Something off → "✋ Revise" — fix the field, I rebuild the letter
```

## Endings — exactly one of two

- **Human-action comments** end with an `Over to you` block: the phrase on its
  own line, then one or two indented `✓` / `✎` / `→` lines — each a single
  clear action with the exact quoted label. No reassurance sentences after the
  action lines.
- **Machine-automatic comments** end with a single line in DocFlow's voice:
  `Next → I <what I do / post here next>`.

## One event, one comment

If two comments would fire back-to-back for one event, merge them. The single
narrators:

- **generatePDF** narrates building (the webhook posts no "building" note).
- The letter-ready comment carries the five-point checklist AND the email
  subject line in one post.
- The step-6 preview opens with the packet-built line, then the fenced email,
  then `Over to you` — one comment for gate 2.
- There is no "sending" post — the status column shows sending; the SENT
  confirmation is the comment.
- **archiveToBlob** posts ONE completion comment: signed + filed, the three
  gates, ADP readiness, the manual checklist, and the confirmation-email
  outcome (`Confirmation sent to X ✓` or `Confirmation email: not sent (mail
  disarmed).`) together.
- **atsSync** posts one one-line import comment (deduped on 'Imported from');
  the welcome comment carries the field checklist and never repeats arrival.

## The email appears ONCE

The full welcome-email body appears exactly once in a card's thread: the step 6
"Ready to send" preview. The step 7 sent confirmation never repeats the body —
it says `The email you previewed at step 6 went out verbatim.` plus the
recipient and the HR reference links. Earlier steps may show the subject line
only. Two copies of the same email in one thread means one of them is drift.

## Message anatomy (card comments)

1. **Header** — `◆ DocFlow · X of 10 — Name` + divider.
2. **Event sentence(s)** — what I just did / am doing, first person, no label.
   An emoji from the lexicon may lead a guard/error line (⚠️ ℹ️ ❌ ✋ 🛑).
3. **Body** — the specifics. Exact field names, exact label text (always quoted
   from config, never hard-coded), one idea per line. No markdown bold.
4. **Ending** — `Over to you` block or `Next →` line (terminal filing comments
   may say `Next → nothing; …`).
5. **Inside note** (optional 2nd arg to `logAction`) — the technical audit line
   for IT. Never mixed into the HR-facing text.

## Error comments (precision beats elegance in failures)

Errors keep the SYSTEM:/ERROR:/FIX: skeleton, but the surrounding sentences are
first-person and calm — no jokes, no drama:

```
◆ DocFlow · 5 of 10 — Packet failed
──────────────────────────────
❌ I couldn't send this for signature. This one's on Adobe's side — here's exactly what happened:

SYSTEM: Adobe Sign
ERROR: <exact message, plus HTTP code / API body when present>

FIX: <the specific way out>. (I also retry automatically.)
```

Guard/no-op comments (⚠️/ℹ️) keep `WHY:` + the way out, under a header that
shows the step the card is ACTUALLY at — not the step someone dragged to.
`THE ORDER:` may list the step sequence in guard messages that reset the user.

## The label vocabulary (the only caps labels allowed)

- `WHY:` — the exact reason a guard fired (column ids allowed here)
- `FIX:` — the exact way out of an error
- `SYSTEM:` / `ERROR:` — error skeleton fields
- `THE ORDER:` — the step sequence, only in guard messages that reset the user
- `THE THREE GATES:` — the post-sign scoreboard
- `NEXT STEPS (manual):` — the completion checklist only

Anything else in ALL CAPS is drift. `Over to you` and `Next →` are sentence case.

## Fixed needles (idempotency / dedupe markers — keep verbatim)

- `Welcome form received` — formSync
- `Welcome packet` — mondayWebhook welcome comment
- `Can't build the offer letter` — mondayWebhook revise comment
- `The letter builds right away` — generatePDF missing-fields comment
  (mondayWebhook greps this via hasUpdateContaining — never reword it)
- `archived (agreement ` — archiveToBlob completion comment
- `Imported from` — atsSync hire-card comment

## Candidate emails (exactly two, ever)

- **Email 1 — Welcome** (on ⑦ Send Package): greeting by first name, the two action
  items (sign + info form), warm sign-off from "The MedWatchers HR Team". Three short
  paragraphs max.
- **Email 2 — Received** (on completion): thank-you, signed copy attached, what's
  ahead in plain words, warm sign-off. No corporate filler.

Candidate emails never contain internal vocabulary: no "packet status", no board or
column names, no step numbers — and never DocFlow's "I".

## Hard rules

1. Labels come from config (`cfg.monday.offerLabels.*`, `cfg.monday.statusLabels.*`),
   quoted in the message exactly. Hard-coded label text is a bug (label drift).
2. Never let a guard skip silently — every no-op posts WHY and the way out.
3. The inside note (2nd `logAction` arg) is for IT: ids, queue names, API facts.
   HR text never mentions queue names, container names, or column ids — except inside
   `WHY:`/`ERROR:` lines where precision is the point.
4. Time promises are honest: "about a minute" only where that's real.
5. One comment per event. If two comments fire back-to-back for one event, merge them.
