# DocFlow Scenario Audit — 2026-08-21 deep-research pass

66 unregistered scenarios found by a full codebase read + HR/compliance domain sweep.
Format: name — detection — handling — effort (S/M/L) — risk (H/M/L). ★ = top-10 by
risk × frequency. Companion to the memorized scenario register (31 prior scenarios).

## A. Code-latent failure surfaces

1. ★ Orphaned live agreement — sendForSign writes the Adobe agreement ID to Monday with `.catch(()=>{})`; on failure a live agreement exists with no ID on the card, signPoller can't see it, re-approve mints a second agreement. Fix: blocking write + retry + reconcile job. M/H
2. ★ Visibility-timeout double-execution — host.json visibilityTimeout 60s vs >60s runtimes → redelivery mid-run. Fix: raise to 10m + claimOnce locks in sendForSign/generatePDF. S/H
3. ★ Broken queue topology — priorityProcessor stub binds docflow-generate and CONSUMES real jobs; priorityRoutingFunction scriptFile points outside its folder; sharePointUploadFunction listens on a dead queue. Fix: delete/repoint. S/H
4. ★ Card wedged at "⑥ Archiving" — status set before Adobe download; host recycle strands it and guards treat archiving as done forever. Fix: stale-archiving watchdog. S/H
5. ★ UTC date stamping — Adobe expirationTime `T23:59:59Z` = ~4pm PT on the stated day; Monday dates written UTC. Fix: normalize to America/Los_Angeles. S/H
6. CRONs run in UTC (no WEBSITE_TIME_ZONE); DST drift. S/M
7. ★ Pay-rate sanity — "9", "$9", "TBD", "-5" all render into a legal letter; createADPUser defaults unknown states to UT-28 tax code. Fix: numeric + role-band validation, fail closed. M/H
8. Wrong-template fallthrough — unrecognized payClass defaults to the CLERK letter. Fail closed instead. S/H
9. signPoller at 3-min cadence (documented 30) + claim keys never released on success. S/M
10. formSync drags status backwards (sets ③ Fill even when out for signature) — partially fixed by three-gate change; verify. S/H
11. formSync namesake dead-end — ambiguous name match bails silently on the form board nobody watches. Email-based matching. S/M
12. ★ Stored SAS rot — 24h SAS URLs persisted into columns/emails; re-mint fallback uses the EXPIRED url; blobUrl archive links permanently unopenable. Store paths, mint on access. M/H
13. cleanup purges pdf-temp at 168h though signing windows can exceed 7 days; lock blobs accumulate forever. S/M
14. storage.js job index: read-modify-write race, failJob retries forever. M/M
15. Monday rate limits: regex-on-message transience, retry_in ignored, no pagination (catalog row 51 never ships; sweeps truncate at 100). M/M
16. Config cache never expires + ~70 live production IDs as code defaults → wrong-env deploy writes to prod silently. S/H
17. docflowOrchestrator wrong column ids (firstName/workEmail share an id) + GraphQL string-interpolation injection. S/H
18. Email-template cache: negative results cached; unparseable Active treated as active. S/M
19. Prose comments as state (dedupe needles, /signed|done/i branching) — copy edits or deleted comments re-enable duplicates. Move to hidden columns/ledger. M/H
20. Falsy-value bugs (`payRate ||`, `parseFloat||2`, zero treated as missing). `??` audit. S/M
21. suppressAdobeEmails: anything but exact 'false' suppresses; if our send fails, nobody contacts the candidate. S/M
22. Mailer silently degrades to drafts forever when partially configured. Alert instead. S/H
23. Event ledger: in-memory sequence collides across instances; 409 = event lost. M/M
24. reconcileIntake updated_at trap: any column touch on a stale hire re-opens the 2h window. Key on an import-marker column. S/M

## B. HR / people-ops

25. ★ Rescinded offer mid-signature — nothing cancels the agreement; candidate can sign a rescinded offer. Rescind label → cancel API + notice + lock. M/H
26. Counter-offer/negotiation — letter built vs board values drift at send gate. Hash merge fields at build; block send on drift. M/H
27. ★ Start-date push after signing — ADP/IT/training fire on the old date. Amendment-letter flow. M/H
28. Verbal decline — one Declined label fanning out cancel/halt/close. S/M
29. Rehire/boomerang — prior ADP/TalentLMS records; email collision logic absent. M/H
30. Internal transfer — I-9/BG/IT redundant; intake branch. S/M
31. Minor/work-permit hire (17-year-old techs in some states). M/L
32. I-9 Section 2 three-business-day clock — not in the flow at all. M/H
33. ★ Pharmacist license expires before start — no license verification step; regulatory exposure for pharmacy staffing. License columns + gate before send. M/H
34. Multi-state offer language (at-will, sick leave, wage statements, salary-range laws) — one template per class, no state dimension. L/H
35. FCRA adverse action — pre-adverse letter + rights summary + waiting period + fair-chance rules; BG flow has no adverse branch. L/H
36. Drug screen contingency gating ADP handoff. M/M
37. References incomplete at send — contingencies banner. S/L
38. Candidate permanently unreachable — graceful terminal close-out. S/L
39. Signed but day-one no-show — reverse path (ADP term, IT deprovision). M/M

## C. Candidate experience

40. Safe-Links/Proofpoint pre-fetch trips click tracking (bot "clicks") and can quarantine mail. Bot filtering + plain fallback URLs. M/M
41. Accessibility — no text/plain MIME part; screen-reader order. S/M
42. Non-English speakers — ES template set minimum. M/M
43. Mobile ordering confusion (sign vs form) — single landing page sequencing. M/M
44. Anyone with the link can sign — enable Adobe signer identity verification (email OTP/phone). S/H
45. Expired/canceled link shows raw Adobe error — set post-expiration URL to a branded status page. S/M
46. Candidate replies to MedWatchersHR — is the mailbox monitored? Route replies to the card. M/M
47. Link-stripping gateways — phone/reply fallback line in every mail. S/L

## D. Security & compliance

48. ★ validateADP is ANONYMOUS unauthenticated write path — any POST sets statuses and enqueues generation. Function-key + HMAC now. S/H
49. adobeWebhook "secret" is the public client ID; forged completion events drive archiveToBlob; OAuth state=constant. M/H
50. Missing secret = auth disabled (validateSignature passes on no-secret); JWT alg/exp unchecked; trackClick shares the Monday secret, no expiry/nonce; example.com allowlisted. Fail closed + dedicated secret + exp. S/H
51. PII in narration/ledger — DOB/SSN-adjacent fields must never hit comments; eventLedger dumps signer emails; verify its auth. S/H
52. Signed-PDF access control — container privacy, SharePoint link scope, no access audit. M/H
53. Who can press the two buttons — no approver allowlist; any board member or automation can approve/send. S/M
54. DSAR/deletion requests — PII spans Monday, blob, SharePoint, ledger, App Insights, Adobe; no inventory or purge runbook; retention validator hardcodes 'compliant'. L/M
55. Our branded mail trains candidates to click — verify SPF/DKIM/DMARC reject; cousin domains. S/M
56. Secret rotation runbook — integration key cached until process death; rotation without restart = split-brain. M/M

## E. Ops / observability / governance

57. ★ No poison-queue consumer anywhere — *-poison fills silently. Drain function + alert. S/H
58. health endpoint is static 'ok' — real dependency probe. S/M
59. No alerting contract — define: poison depth, agreement-without-ID, stuck-state SLAs, Adobe 429s, mail failures. M/H
60. Deploy during in-flight signing — staging slot/swap or drain. M/M
61. Template Catalog disaster recovery — nightly versioned export to blob. S/M
62. Monday outage day — reconcile lookback auto-extends after a detected gap. M/M
63. Cost anomaly alerts (poller frequency, retry loops). S/L
64. Duplicate/cloned boards — reject events whose boardId ≠ configured, loudly. S/M
65. Archived cards still resolve via API — filter state:active in every sweep. S/M
66. App Insights PII/log hygiene + retention decision. M/M

## Cross-cutting (do these before adding more scenarios)
1. Replace prose-comment state with an explicit state column + event ledger (half of section A traces to it).
2. Fail-closed rule for every default: template fallthrough, UT-28, no-secret-valid, suppressed-email parse — the dominant failure mode is silent success on wrong data.

## Top-10: A1, A2, A3, A4, A5, A7, A12, B25/27 (+B33 compliance standout), D48, E57.
