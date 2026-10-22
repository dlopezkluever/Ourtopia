# P26 evidence matrix

This matrix separates existing CI behavior evidence from an HTTPS receipt. A test file listed here is an existing source of proof; it does not claim the current branch's local test has been run. Every live receipt below remains **POST-AUTHORIZATION**. P26 live lanes are the ten lanes in `tests/journeys/issue-26.spec.ts`, run on both desktop and mobile, supplemented by the specific upstream suites named per row. A generic P26 smoke is not a substitute for the focused journey.

## Engineering specification scenarios

| Spec | Acceptance scenario | Existing CI test files that prove behavior | HTTPS receipt still required |
| --- | --- | --- | --- |
| 1 | Private Community creation and unrelated denial | `tests/journeys/issue-2.spec.ts`; `tests/rls/issue-2.test.ts` | Yes, P26 lane 1 and lane 9; live invite/auth boundary |
| 2 | Invite, verified redemption, pending isolation, approval/rejection/expiry/reuse | `tests/journeys/issue-2.spec.ts`; `tests/rls/issue-2.test.ts` | Yes, P26 lane 1; live invite email and approval |
| 3 | Suspension/removal blocks new activity while obligations remain | `tests/server/issue-20.test.ts`; `tests/rls/issue-20.test.ts`; `tests/journeys/issue-20.spec.ts` | Yes, P26 lane 7 and lane 9 |
| 4 | Drill Listing, 45 minimum, Bob's 50 Unproven trust view and approval | `tests/journeys/issue-6.spec.ts`; `tests/server/issue-25.test.ts` | Yes, P26 lane 1; live Alice/Bob read and approval |
| 5 | Competing requests, one reservation winner, expiry | `tests/server/issue-6.test.ts`; `tests/journeys/issue-6.spec.ts` | Yes, P26 lane 3 |
| 6 | Terms, schedule, Handoff, optional/retried photos, cancellation guard | `tests/server/issue-7.test.ts`; `tests/rls/issue-7.test.ts`; `tests/journeys/issue-7.spec.ts` | Yes, P26 lane 2 and lane 3 |
| 7 | Return, dual confirmation, reputation, safe feed, idempotent replay | `tests/server/issue-9.test.ts`; `tests/server/issue-10.test.ts`; `tests/journeys/issue-9.spec.ts`; `tests/journeys/issue-10.spec.ts` | Yes, P26 lane 2; persisted state receipt |
| 8 | Dispute and stalled review evidence rules | `tests/server/issue-8.test.ts`; `tests/server/issue-19.test.ts`; `tests/rls/issue-19.test.ts`; `tests/journeys/issue-19.spec.ts` | Yes, P26 lane 5 |
| 9 | Item Need Post to Listing response to separate Borrow Request | `tests/server/issue-11.test.ts`; `tests/rls/issue-11.test.ts`; `tests/journeys/issue-11.spec.ts` | Yes, P26 lane 3 |
| 10 | Two-helper Need Post, independent completions, silence review | `tests/server/issue-12.test.ts`; `tests/server/issue-13.test.ts`; `tests/server/issue-19.test.ts`; `tests/journeys/issue-12.spec.ts`; `tests/journeys/issue-13.spec.ts` | Yes, P26 lane 4 and lane 5 |
| 11 | Vouch does not activate applicant or change score | `tests/server/issue-14.test.ts`; `tests/rls/issue-14.test.ts`; `tests/journeys/issue-14.spec.ts` | Yes, P26 lane 6 |
| 12 | Private messages and selected-only Dispute evidence | `tests/server/issue-15.test.ts`; `tests/server/issue-17.test.ts`; `tests/rls/issue-15.test.ts`; `tests/rls/issue-17.test.ts`; `tests/journeys/issue-15.spec.ts`; `tests/journeys/issue-17.spec.ts` | Yes, P26 lane 6 |
| 13 | Dispute report window, response, remedy, adjudication | `tests/server/issue-8.test.ts`; `tests/server/issue-16.test.ts`; `tests/rls/issue-16.test.ts`; `tests/journeys/issue-8.spec.ts`; `tests/journeys/issue-16.spec.ts` | Yes, P26 lane 6 |
| 14 | Verified penalties and linked correction; no client score writes | `tests/server/issue-18.test.ts`; `tests/rls/issue-18.test.ts`; `tests/journeys/issue-18.spec.ts` | Yes, P26 lane 6 |
| 15 | Two-Community 20:1 weighted score and unproven default | `tests/server/issue-4.test.ts`; `tests/rls/issue-4.test.ts`; `tests/journeys/issue-4.spec.ts` | Yes, P26 lane 7 |
| 16 | Foreign serious incident redaction | `tests/server/issue-18.test.ts`; `tests/rls/issue-18.test.ts`; `tests/journeys/issue-18.spec.ts` | Yes, P26 lane 7 |
| 17 | Frozen electorate, thresholds, defense, separate removal action | `tests/server/issue-21.test.ts`; `tests/rls/issue-21.test.ts`; `tests/journeys/issue-21.spec.ts` | Yes, P26 lane 7 |
| 18 | Stripe TEST checkout and reconciliation/retry/out-of-order | `tests/server/issue-22.test.ts`; `tests/journeys/issue-22.spec.ts`; `.github/workflows/verify.yml` billing-live job | Yes, P26 lane 8; deployed TEST checkout and signed webhook receipts |
| 19 | In-app/email notices and retry without state loss | `tests/server/issue-23.test.ts`; `tests/rls/issue-23.test.ts`; `tests/journeys/issue-23.spec.ts` | Yes, P26 lane 9; real provider acceptance and retry receipt |
| 20 | Touch, keyboard, screen reader, PWA install/cache/draft/upload recovery | `tests/journeys/issue-2.spec.ts`; `tests/journeys/issue-7.spec.ts`; `tests/journeys/issue-24.spec.ts`; `tests/server/issue-24.test.ts` | Yes, P26 lane 10, mobile install and screen-reader pass. **Defect:** no existing test file proves a screen-reader pass or installation on HTTPS. Assign to PWA/accessibility behavior. |
| 21 | Metrics reconcile with persisted source records | `tests/server/issue-25.test.ts`; `tests/rls/issue-25.test.ts`; `tests/journeys/issue-25.spec.ts` | Yes, P26 lane 10; reconcile the actual pilot records |

## PRD section 44 completion capabilities

| PRD §44 | Capability | Existing CI test files that prove behavior | HTTPS receipt still required |
| --- | --- | --- | --- |
| 1 | Create a private Community | `tests/server/issue-2.test.ts`; `tests/rls/issue-2.test.ts`; `tests/journeys/issue-2.spec.ts` | Yes, P26 lane 1 |
| 2 | Invite another user | `tests/server/issue-2.test.ts`; `tests/journeys/issue-2.spec.ts` | Yes, P26 lane 1; real Auth email |
| 3 | Approve that user | `tests/server/issue-2.test.ts`; `tests/journeys/issue-2.spec.ts` | Yes, P26 lane 1 |
| 4 | Stripe TEST membership subscription workflow | `tests/server/issue-22.test.ts`; `tests/journeys/issue-22.spec.ts`; `.github/workflows/verify.yml` billing-live job | Yes, P26 lane 8 |
| 5 | Create an item Listing | `tests/server/issue-5.test.ts`; `tests/rls/issue-5.test.ts`; `tests/journeys/issue-5.spec.ts` | Yes, P26 lane 1 and lane 3 |
| 6 | Create a Help offer | `tests/server/issue-12.test.ts`; `tests/rls/issue-12.test.ts`; `tests/journeys/issue-12.spec.ts` | Yes, P26 lane 4 |
| 7 | Create an item Need Post | `tests/server/issue-11.test.ts`; `tests/rls/issue-11.test.ts`; `tests/journeys/issue-11.spec.ts` | Yes, P26 lane 3 |
| 8 | Create a Help Need Post | `tests/server/issue-12.test.ts`; `tests/rls/issue-12.test.ts`; `tests/journeys/issue-12.spec.ts` | Yes, P26 lane 4 |
| 9 | Browse Community activity | `tests/server/issue-9.test.ts`; `tests/rls/issue-9.test.ts`; `tests/journeys/issue-9.spec.ts` | Yes, P26 lane 2 |
| 10 | Submit a Borrow Request | `tests/server/issue-6.test.ts`; `tests/rls/issue-6.test.ts`; `tests/journeys/issue-6.spec.ts` | Yes, P26 lane 1 and lane 3 |
| 11 | Approve a borrower | `tests/server/issue-6.test.ts`; `tests/journeys/issue-6.spec.ts` | Yes, P26 lane 1 |
| 12 | Examine local/global reputation | `tests/server/issue-4.test.ts`; `tests/rls/issue-4.test.ts`; `tests/journeys/issue-4.spec.ts` | Yes, P26 lane 1 and lane 7 |
| 13 | Require minimum reputation | `tests/server/issue-6.test.ts`; `tests/journeys/issue-6.spec.ts` | Yes, P26 lane 3 |
| 14 | Schedule a Handoff | `tests/server/issue-7.test.ts`; `tests/journeys/issue-7.spec.ts` | Yes, P26 lane 2 |
| 15 | Prompt for optional Handoff photos | `tests/server/issue-7.test.ts`; `tests/journeys/issue-7.spec.ts` | Yes, P26 lane 2 and lane 10 |
| 16 | Acknowledge condition and replacement value | `tests/server/issue-7.test.ts`; `tests/journeys/issue-7.spec.ts` | Yes, P26 lane 2 |
| 17 | Record Return | `tests/server/issue-9.test.ts`; `tests/journeys/issue-9.spec.ts` | Yes, P26 lane 2 |
| 18 | Prompt for optional Return photos | `tests/server/issue-9.test.ts`; `tests/journeys/issue-9.spec.ts` | Yes, P26 lane 2 and lane 10 |
| 19 | Complete an Exchange | `tests/server/issue-9.test.ts`; `tests/journeys/issue-9.spec.ts` | Yes, P26 lane 2 |
| 20 | Modify reputation from outcome | `tests/server/issue-4.test.ts`; `tests/server/issue-9.test.ts`; `tests/journeys/issue-9.spec.ts` | Yes, P26 lane 2 |
| 21 | Publicly thank a member | `tests/server/issue-10.test.ts`; `tests/rls/issue-10.test.ts`; `tests/journeys/issue-10.spec.ts` | Yes, P26 lane 2 |
| 22 | Vouch for a member | `tests/server/issue-14.test.ts`; `tests/rls/issue-14.test.ts`; `tests/journeys/issue-14.spec.ts` | Yes, P26 lane 6 |
| 23 | Report a Dispute | `tests/server/issue-8.test.ts`; `tests/journeys/issue-8.spec.ts` | Yes, P26 lane 6 |
| 24 | Administrator reviews a Dispute | `tests/server/issue-16.test.ts`; `tests/rls/issue-16.test.ts`; `tests/journeys/issue-16.spec.ts` | Yes, P26 lane 6 |
| 25 | Participate in disciplinary vote | `tests/server/issue-21.test.ts`; `tests/journeys/issue-21.spec.ts` | Yes, P26 lane 7 |
| 26 | Suspend or remove a member | `tests/server/issue-20.test.ts`; `tests/server/issue-21.test.ts`; `tests/journeys/issue-20.spec.ts`; `tests/journeys/issue-21.spec.ts` | Yes, P26 lane 7 |
| 27 | Private participant messaging | `tests/server/issue-15.test.ts`; `tests/rls/issue-15.test.ts`; `tests/journeys/issue-15.spec.ts` | Yes, P26 lane 6 |
| 28 | Transparent local/global reputation history | `tests/server/issue-4.test.ts`; `tests/server/issue-18.test.ts`; `tests/journeys/issue-4.spec.ts`; `tests/journeys/issue-18.spec.ts` | Yes, P26 lane 7 |
| 29 | Commit to Help and complete with both confirmations | `tests/server/issue-12.test.ts`; `tests/server/issue-13.test.ts`; `tests/journeys/issue-12.spec.ts`; `tests/journeys/issue-13.spec.ts` | Yes, P26 lane 4 and lane 5 |

## Defects and receipt gaps

- **Screen-reader and installed-PWA proof is absent.** Scenario 20 lacks CI evidence for a screen-reader pass and actual installation on HTTPS. Owner: PWA/accessibility behavior. The live lane 10 receipt is still required.
- **Every row still needs live HTTPS evidence.** Existing CI runs against the local disposable backend. It does not prove hosted configuration, real email delivery, deployed Stripe TEST checkout, hosted Storage or Realtime policies, or actual screen-reader operation. Those are post-authorization receipts, not defects that this preparation-only patch can close.
- **Current `scripts/verify/backend.ts` creates test users and records.** Remote runs require a dedicated authorized pilot project and isolated test identities. Never point this runner at production or a shared non-pilot project.
