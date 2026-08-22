# DocFlow Voice Guide

Every card comment, email, and status label speaks with ONE voice. This file is the
standard. If a message doesn't fit a skeleton below, the message is wrong — not the guide.

Voice: Apple-simple. Quiet. Short lines. Generous whitespace. One idea per line.
No form-filling labels, no hedging, no filler, no re-explaining the whole flow in
every comment. Every word earns its place. Name the specific fields and labels —
never "the employer fields". Tense matches timing: past when done, present when
running, `Next →` for what follows.

## The step header (every HR-facing card comment opens with it)

```
▶ X of 10 · Sentence-case name
──────────────────────────────
```

- `▶ X of 10 · <name>` — no "STEP", no emoji in the header name, no ALL-CAPS.
- The first line after the divider IS the event sentence. No `WHAT HAPPENED:` label —
  just write the sentence.
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
▶ 6 of 10 · Ready to send
──────────────────────────────
The packet is built. Signing order: Francisco Lopez.
Below is word-for-word what Francisco receives.

<body / fenced email / checklist>

Your move
    ✓ Looks right → select "⑦ 📤 Send Package"
    ✎ Something off → "✋ Revise" — fix the field, the letter rebuilds itself
```

## Endings — exactly one of two

- **Human-action comments** end with a `Your move` block: the phrase on its own
  line, then indented `✓` / `✎` / `→` options (one per line).
- **Machine-automatic comments** end with a single line:
  `Next → <what posts here next>`.

## One event, one comment

If two comments would fire back-to-back for one event, merge them. The single
narrators:

- **generatePDF** narrates building (the webhook posts no "building" note).
- The letter-ready comment carries the five-point checklist AND the email
  subject line in one post.
- The step-6 preview opens with the packet-built line, then the fenced email,
  then `Your move` — one comment for gate 2.
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
it says `The email you previewed at step 6 was sent verbatim.` plus the
recipient and the HR reference links. Earlier steps may show the subject line
only. Two copies of the same email in one thread means one of them is drift.

## Message anatomy (card comments)

1. **Header** — `▶ X of 10 · Name` + divider.
2. **Event sentence(s)** — what just happened, no label. An emoji from the
   lexicon may lead a guard/error line (⚠️ ℹ️ ❌ ✋ 🛑).
3. **Body** — the specifics. Exact field names, exact label text (always quoted
   from config, never hard-coded), one idea per line. No markdown bold.
4. **Ending** — `Your move` block or `Next →` line (terminal filing comments may
   say `Next → nothing; …`).
5. **Inside note** (optional 2nd arg to `logAction`) — the technical audit line
   for IT. Never mixed into the HR-facing text.

## Error comments (precision beats elegance in failures)

Errors keep the SYSTEM:/ERROR:/FIX: skeleton under the new header style:

```
▶ 5 of 10 · Packet failed
──────────────────────────────
❌ Sending for signature failed.

SYSTEM: Adobe Sign
ERROR: <exact message, plus HTTP code / API body when present>

FIX: <the specific way out>. (The system also retries automatically.)
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

Anything else in ALL CAPS is drift. `Your move` and `Next →` are sentence case.

## Fixed needles (idempotency / dedupe markers — keep verbatim)

- `Welcome form received` — formSync
- `Welcome packet` — mondayWebhook welcome comment
- `Can't build the offer letter` — mondayWebhook revise comment
- `The letter builds right away` — generatePDF missing-fields comment
- `archived (agreement ` — archiveToBlob completion comment
- `Imported from` — atsSync hire-card comment

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
