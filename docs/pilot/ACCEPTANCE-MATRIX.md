# MVP acceptance evidence matrix

This matrix points to committed automated evidence already present at source head `0d3d17474080167ecbcf53c15d417da6a99cf3ea`. These suites are local-stack evidence. They do not prove an HTTPS deployment, a hosted Community, or browser and privacy behavior on the pilot project. No issue-26 behavioral suite was run because the coordinator has not granted the single full-backend and Playwright workload lease.

Status key: **Covered locally** means a named existing test asserts the behavior against the disposable local Supabase stack. **Gap** means no test in the cited suite proves the full requirement. **Live gap** applies to every scenario until the pilot workflow runs against the deployed project.

## MVP-SPEC acceptance tests

| # | Observable behavior | Concrete test evidence | Status and remaining gap |
| --- | --- | --- | --- |
| 1 | Create private Community; deny unrelated reads | `tests/journeys/issue-2.spec.ts`: `lane 2 registration verification creates exactly one active first administrator`, `lane 7 unrelated direct URL and REST queries disclose no private Community` | Covered locally. Live gap. |
| 2 | Invite, verify, approve or reject, expiry and reuse | `tests/journeys/issue-3.spec.ts`: membership invite and decision lanes; `tests/server/issue-3.test.ts`: invite and decision guards | Covered locally. Live gap. |
| 3 | Suspension and removal boundaries with obligations retained | `tests/journeys/issue-20.spec.ts`: `lane 1 owner suspends a borrower with an open item loan...`, `lane 2 owner removes a member...`, `lane 8 each actor sees exactly the current lifecycle scope...` | Covered locally. Live gap. |
| 4 | Alice lists drill and Bob requests with truthful unproven score; owner approves | `tests/journeys/issue-5.spec.ts`: `lane 2 Alice publishes drill...`; `tests/journeys/issue-6.spec.ts`: `lane 2 Bob requests Friday through Sunday and Alice approves after seeing 50 Unproven` | Covered locally. Live gap. |
| 5 | Concurrent overlapping approvals and reservation expiry | `tests/journeys/issue-6.spec.ts`: `lane 6 racing owner approvals produce exactly one reservation...`, `lane 7 an unacknowledged approval expires once...` | Covered locally. Live gap. |
| 6 | Terms, schedule, optional photos, Handoff and cancellation guards | `tests/journeys/issue-7.spec.ts`: `lane 2 borrower acknowledges...`, `lane 3 optional photos are skipped...`, `lane 8 interrupted camera upload resumes...` | Covered locally. Live gap. |
| 7 | Return, matching confirmations, points, counts, feed privacy and retry | `tests/journeys/issue-9.spec.ts`: `lane 2 borrower records Return...`, `lane 6 racing and replayed Return...`, `lane 8 Community feed shows a safe completion entry...` | Covered locally. Live gap. |
| 8 | Dispute blocks completion; silence invokes evidence-based review | `tests/journeys/issue-8.spec.ts`: `lane 4 original deadline is enforced...`; `tests/journeys/issue-19.spec.ts`: `lane 2 administrator verifies a stalled item from recorded evidence`, `lane 5 administrator closes a stalled item without completion` | Covered locally. Live gap. |
| 9 | Item Need response creates a separate Borrow Request | `tests/journeys/issue-11.spec.ts`: `lane 2 Bob posts an item need, Alice answers with her drill, and Bob sends a separate Borrow Request` | Covered locally. Live gap. |
| 10 | Two-helper Help Need with independent completion and silent review | `tests/journeys/issue-12.spec.ts`: `lane 3 a two-helper Need Post accepts one helper and keeps the second place available`; `tests/journeys/issue-13.spec.ts`: `both participants confirm one Help Exchange...`; `tests/journeys/issue-19.spec.ts`: `lane 3 administrator verifies a stalled help Exchange...` | Covered locally. A single two-helper end-to-end completion with the second helper silent is a gap. Live gap. |
| 11 | Vouch does not approve or award points | `tests/journeys/issue-14.spec.ts`: `lane 2 administrator grants sponsor Vouch applicant reads notice but pending until ordinary approval`, `lane 6 valid intent replay keeps one statement and unchanged access points and weight` | Covered locally. Live gap. |
| 12 | Private messages and selected-only Dispute evidence | `tests/journeys/issue-15.spec.ts`: `lane 6 nonparticipant administrator unrelated member foreign member and outsider cannot browse private content`; `tests/journeys/issue-17.spec.ts`: `lane 2 participant submits one of several messages and the administrator sees only that snapshot` | Covered locally. Live gap. |
| 13 | Dispute windows, responses, remedies, resolution, and expiry | `tests/journeys/issue-8.spec.ts`: `lane 2 participant reports...`; `tests/journeys/issue-16.spec.ts`: `lane 2 participants propose repair...`, `lane 3 a contested report enters administrator review...` | Covered locally. Live gap. |
| 14 | Verified penalties and linked correction; client cannot write score | `tests/journeys/issue-18.spec.ts`: `lane 1 damage decision, -10 history, and later linked correction`; `tests/server/issue-18.test.ts`: verified misconduct and correction cases | Covered locally. Live gap. |
| 15 | Weighted reputation and 50 Unproven baseline | `tests/journeys/issue-4.spec.ts`: `lane 2 approved member directory local and global start at 50 Unproven...`, `lane 3 two Communities keep local histories and use 20 to 1 global weighting` | Covered locally. Live gap. |
| 16 | Foreign trust indicator reveals type and status only | `tests/journeys/issue-18.spec.ts`: `lane 7 raw redacted trust output carries type and status only`; `tests/journeys/issue-4.spec.ts`: `lane 6 shared viewer sees type and status...` | Covered locally. Live gap. |
| 17 | Frozen electorate, thresholds, and separate removal action | `tests/journeys/issue-21.spec.ts`: `lane 2 an administrator opens a vote...`, `lane 3 a separate administrator action enacts a passed result...`, `lane 4 literal threshold outcomes...` | Covered locally. Live gap. |
| 18 | Test checkout and webhook convergence; payment never gates access | `tests/journeys/issue-22.spec.ts`: `lane 3 real test payment failure retry and subscription cancellation...`, `lane 7 concurrent and out of order receipts converge...`, `lane 9 another account cannot read billing...` | Covered locally with Stripe test integration. Live hosted test endpoint gap. |
| 19 | Membership, Exchange, Dispute, and vote notice delivery and retry | `tests/journeys/issue-23.spec.ts`: `lane 2 administrator retries a failed decision email...`, `tests/journeys/issue-9.spec.ts`: `lane 9 failed reminder is obsoleted...`, `tests/journeys/issue-19.spec.ts`: `lane 9 a failed decision email retries...` | Covered locally for membership, Exchange, and review notices. A single failure-and-retry suite spanning all four notice families is a gap. Live gap. |
| 20 | Mobile, keyboard, screen reader, PWA, draft, upload recovery | `tests/journeys/issue-24.spec.ts`: `lane 2 install metadata...`, `lane 5 interrupted Handoff camera upload...`, `lane 9 registration, draft errors, scheduling and confirmation expose names and keyboard focus`; feature suites have keyboard and viewport lanes | Covered locally for PWA and keyboard labels. No explicit screen-reader run is recorded. Live gap. |
| 21 | Metrics reconcile to persisted source rows | `tests/journeys/issue-25.spec.ts`: `lane ${lane} persisted pilot metrics reconcile and export on desktop and mobile` | Covered locally. Live metrics receipt gap. |

## PRD section 44 capabilities

| # | Capability | Concrete test evidence | Status and remaining gap |
| --- | --- | --- | --- |
| 1 | Create private Community | `tests/journeys/issue-2.spec.ts`: `lane 2 registration verification creates exactly one active first administrator` | Covered locally. Live gap. |
| 2 | Invite a user | `tests/journeys/issue-3.spec.ts`: membership invite lanes | Covered locally. Live gap. |
| 3 | Approve a user | `tests/journeys/issue-3.spec.ts`: membership approval lanes | Covered locally. Live gap. |
| 4 | Stripe test subscription | `tests/journeys/issue-22.spec.ts`: `lane 2 complete real test Checkout linked to the account` | Covered locally. Live hosted test gap. |
| 5 | Create item listing | `tests/journeys/issue-5.spec.ts`: `lane 2 Alice publishes drill and Bob discovers saved detail in Community feed` | Covered locally. Live gap. |
| 6 | Create Help offer | `tests/journeys/issue-12.spec.ts`: `lane 2 publish a Help Listing, commit as requester, and accept as owner/helper` | Covered locally. Live gap. |
| 7 | Create item Need Post | `tests/journeys/issue-11.spec.ts`: `lane 2 Bob posts an item need...` | Covered locally. Live gap. |
| 8 | Create Help Need Post | `tests/journeys/issue-12.spec.ts`: `lane 3 a two-helper Need Post accepts one helper...` | Covered locally. Live gap. |
| 9 | Browse community activity | `tests/journeys/issue-5.spec.ts`: `lane 2 Alice publishes drill and Bob discovers saved detail in Community feed` | Covered locally. Live gap. |
| 10 | Submit Borrow Request | `tests/journeys/issue-6.spec.ts`: `lane 2 Bob requests Friday through Sunday...` | Covered locally. Live gap. |
| 11 | Approve borrower | `tests/journeys/issue-6.spec.ts`: `lane 2 Bob requests Friday through Sunday and Alice approves...` | Covered locally. Live gap. |
| 12 | Examine borrower reputation | `tests/journeys/issue-6.spec.ts`: `lane 2 Bob requests Friday through Sunday and Alice approves after seeing 50 Unproven` | Covered locally. Live gap. |
| 13 | Enforce minimum reputation | `tests/journeys/issue-6.spec.ts`: `lane 4 below-minimum and no-longer-eligible approvals are refused...` | Covered locally. Live gap. |
| 14 | Schedule handoff | `tests/journeys/issue-7.spec.ts`: `lane 2 borrower acknowledges, pair confirms schedule and condition...` | Covered locally. Live gap. |
| 15 | Prompt for optional handoff photos | `tests/journeys/issue-7.spec.ts`: `lane 3 optional photos are skipped and photo-free Handoff completes` | Covered locally. Live gap. |
| 16 | Acknowledge condition and replacement value | `tests/journeys/issue-7.spec.ts`: `lane 2 borrower acknowledges, pair confirms schedule and condition...` | Covered locally. Live gap. |
| 17 | Record Return | `tests/journeys/issue-9.spec.ts`: `lane 2 borrower records Return...` | Covered locally. Live gap. |
| 18 | Prompt for optional Return photos | `tests/journeys/issue-9.spec.ts`: `lane 3 optional photos are skipped or retried...` | Covered locally. Live gap. |
| 19 | Complete Exchange | `tests/journeys/issue-9.spec.ts`: `lane 2 borrower records Return, owner confirms...` | Covered locally. Live gap. |
| 20 | Update reputation for outcome | `tests/journeys/issue-9.spec.ts`: `lane 2 borrower records Return, owner confirms...`; `tests/journeys/issue-13.spec.ts`: Help completion awards | Covered locally. Live gap. |
| 21 | Publicly thank a member | `tests/journeys/issue-10.spec.ts`: `A participant thanks their partner after completion and the note appears on the profile and private Community feed` | Covered locally. Live gap. |
| 22 | Vouch for a member | `tests/journeys/issue-14.spec.ts`: `lane 2 administrator grants sponsor Vouch applicant reads notice...` | Covered locally. Live gap. |
| 23 | Report a Dispute | `tests/journeys/issue-8.spec.ts`: `lane 2 participant reports, uploads evidence and the counterparty responds...` | Covered locally. Live gap. |
| 24 | Review Dispute as administrator | `tests/journeys/issue-16.spec.ts`: `lane 3 a contested report enters administrator review...` | Covered locally. Live gap. |
| 25 | Participate in disciplinary vote | `tests/journeys/issue-21.spec.ts`: `lane 2 an administrator opens a vote...` | Covered locally. Live gap. |
| 26 | Suspend or remove member | `tests/journeys/issue-20.spec.ts`: `lane 1 owner suspends a borrower...`, `lane 2 owner removes a member...` | Covered locally. Live gap. |
| 27 | Privately message participant | `tests/journeys/issue-15.spec.ts`: `lane 2 two members start from inbox and exchange persisted text...` | Covered locally. Live gap. |
| 28 | View transparent reputation history | `tests/journeys/issue-4.spec.ts`: `lane 2 approved member directory local and global start at 50 Unproven...`; `tests/journeys/issue-18.spec.ts`: correction history lane | Covered locally. Live gap. |
| 29 | Commit to and complete Help exchange | `tests/journeys/issue-12.spec.ts`: Help commitment; `tests/journeys/issue-13.spec.ts`: `both participants confirm one Help Exchange before it completes and awards only the helper` | Covered locally. Live gap. |

## Cross-cutting gaps

- No exact issue-26 journey currently runs all Alice and Bob steps in one persisted Community and verifies final database rows alongside the UI.
- No test has been run against an HTTPS pilot backend. The current local fixture helper explicitly rejects non-local Supabase URLs.
- The combined authorization matrix across anonymous, unverified, pending, rejected, suspended, removed, and unrelated actors is distributed across upstream suites. No issue-26 table-driven matrix proves every applicable path across commands, RLS, Storage, and Realtime in one run.
- The existing tests use fixture setup, but no hosted bootstrap exists. The real Community must be created through the product UI after the operator gate.
- Screen-reader verification, hosted worker timing and retry, hosted email, and hosted Stripe recovery still need real pilot receipts.
- The issue-26 action-to-visible performance measure has no recorded baseline or samples. Do not report a performance pass from the upstream issue-specific measurements.
