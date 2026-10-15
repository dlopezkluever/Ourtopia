# Mutual Aid Community Platform — MVP spec

Status: Engineering specification.

## Problem Statement

People in a private community want to lend useful items and help one another, but coordinating access, handoffs, returns, and disagreements informally makes trust fragile. Item owners need enough relevant history to decide whether to lend; borrowers and helpers need a simple path to participate; administrators need a fair, auditable way to resolve problems. A new community cannot yet complete any of these workflows in this repository, which contains product documents but no application.

## Solution

Deliver a mobile-first private-community app where verified people join by Invite and administrator approval, publish Listings and Need Posts, coordinate item and help Exchanges, and communicate privately. Use optional condition evidence, clear responsibility acknowledgments, and two-party completion to keep ordinary sharing light while retaining records for Disputes. Show a transparent Community Solidarity Score for each membership and an interaction-weighted Global Solidarity Score, together with separate serious-incident indicators. Give Community Administrators membership, moderation, Dispute, and Community Disciplinary Vote tools. Offer a $5 monthly subscription workflow in Stripe test mode without gating pilot access. Run one real community on an HTTPS pilot URL, with the PRD's end-to-end journeys working on mobile and desktop.

## User Stories

1. As a person, I want to register and verify my email, so that I can participate under an accountable account.
2. As an account holder, I want to sign in, sign out, and recover access, so that I can use my account securely.
3. As a verified person, I want to create a private Community, so that I can organize sharing among people I know.
4. As a Community Administrator, I want to issue an expiring Invite, so that someone can request membership without exposing the Community publicly.
5. As an invitee, I want to request membership after signing in and verifying email, so that an administrator can review me.
6. As a Community Administrator, I want to approve or reject a membership request, so that I control participation.
7. As an applicant, I want to see the outcome of my request, so that I know whether I can participate.
8. As a Community Member in several Communities, I want to switch Communities, so that I see the right local content and standing.
9. As a Community Member, I want to browse a directory of approved members, so that I know whom I am sharing with.
10. As a Community Member, I want to see my Community Solidarity Score, Global Solidarity Score, titles, and completed-exchange counts, so that I understand my standing.
11. As a new Community Member, I want my score to show 50 — Unproven until I complete an Exchange, so that my lack of history is represented honestly.
12. As a Community Member, I want to inspect the Reputation Events behind my scores, so that I can understand every change.
13. As a Community Member, I want another member's global score and count plus shared-Community history, so that I can judge trust without seeing private activity elsewhere.
14. As an item owner, I want to create, edit, and withdraw a Listing with description, images, condition, replacement value, pickup notes, terms, availability, and a minimum Community Solidarity Score, so that borrowers know what is offered.
15. As a Community Member, I want to browse the activity feed and search or filter Listings by keyword, category, type, and availability, so that I can find something useful.
16. As a Community Member, I want to publish an item Need Post with dates and urgency, so that owners can respond to a need that has no matching Listing yet.
17. As an item owner, I want to answer an item Need Post with an existing or new Listing, so that the requester can submit a normal Borrow Request.
18. As a prospective borrower, I want to submit a Borrow Request for specific dates, so that the owner can consider lending to me.
19. As an item owner, I want to see the applicant's local and global standing, exchange counts, relevant local history, and serious-incident indicators, so that I can make an informed choice.
20. As an item owner, I want to approve or decline a Borrow Request, so that I retain discretion over my item.
21. As an item owner, I want my minimum local score enforced at approval, so that an ineligible request cannot reserve my item.
22. As a borrower, I want an approval to reserve my dates temporarily and notify me, so that I can acknowledge the terms before it expires.
23. As an item owner, I want overlapping approvals rejected even during concurrent decisions, so that my item cannot be promised twice.
24. As an owner or borrower, I want to propose and confirm handoff time and location, so that we can coordinate reliably.
25. As a borrower, I want to acknowledge return date, condition, replacement value, and responsibility terms, so that I understand the agreement before the Exchange becomes active.
26. As an owner or borrower, I want to record handoff condition and accessories and optionally upload photos, so that there is useful evidence if a problem arises.
27. As an owner or borrower, I want to cancel before handoff with a reason, so that a failed plan closes cleanly without automatic reputation loss.
28. As an Exchange participant, I want to see status, schedule, and relevant reminders, so that I know the next action.
29. As an owner or borrower, I want to record a Return and optionally upload photos, so that condition at return can be compared with handoff.
30. As an owner or borrower, I want to confirm return condition, so that an ordinary loan can complete when we agree.
31. As an Exchange participant, I want a condition disagreement to open a Dispute path, so that completion does not erase the problem.
32. As a Community Administrator, I want stalled confirmations brought to review after reminders, so that silence never automatically completes an Exchange.
33. As an item Exchange participant, I want completion to count once and award the specified Reputation Events, so that retries cannot inflate scores.
34. As a Community Member, I want to publicly thank someone after a completed Exchange, so that contributions are visible and the recipient can earn the one allowed thank-you point.
35. As a Community Member, I want completed Exchanges and thank-yous to appear in the feed without private evidence or messages, so that the Community sees contributions safely.
36. As a Community Member, I want to publish a Help Listing with my skill, availability, and geographic constraints, so that others can request my help.
37. As a Community Member, I want to publish a Help Need Post with schedule, location, duration, and helper count, so that others can commit to helping.
38. As a helper, I want to commit to a Help Listing or Help Need Post, so that the requester can accept me for a specific help Exchange.
39. As a requester, I want to accept helpers independently, so that a multi-helper Need Post can fill one place at a time.
40. As a help Exchange participant, I want both parties to confirm completion, so that the helper earns +3 and each participant gains one Qualifying Interaction only for completed help.
41. As a help Exchange participant, I want nonresponse to trigger reminders and administrator review, so that one silent person cannot force completion.
42. As an eligible Community Member, I want to Vouch for an applicant, so that the administrator can consider my trust statement without granting access or score points.
43. As two Community Members, we want a private conversation for coordination, so that we can arrange a handoff or help.
44. As an Exchange participant, I want to open a Dispute while an Exchange is active or within 30 days after completion, so that a problem can be reviewed.
45. As a Dispute participant, I want to submit evidence and responses, including selected messages, so that the administrator can review my account without browsing the rest of my conversation.
46. As a Community Administrator, I want to record a Dispute outcome and verified misconduct, so that consequences are reasoned and auditable.
47. As a Community Administrator, I want to correct a Reputation Event through a linked compensating event, so that history remains explainable.
48. As an item owner, I want unresolved Disputes and confirmed serious violations shown separately from scores, so that a low-volume Community incident is not hidden by an average.
49. As a Community Member viewing cross-Community trust indicators, I want only incident type and status, so that another Community's identity and evidence stay private.
50. As an accused Community Member, I want to see and answer a disciplinary allegation, so that I can respond before a vote closes.
51. As an eligible voter, I want one ballot in a Community Disciplinary Vote, so that the result reflects the approved membership at opening.
52. As a Community Administrator, I want the seven-day vote's quorum and two-thirds removal threshold calculated and recorded, so that I can enact a valid outcome.
53. As a Community Administrator, I want to suspend or remove a member and keep an audit record, so that I can protect the Community.
54. As a removed participant, I want access to my own open Exchanges and Disputes until resolution, so that removal does not strand obligations.
55. As a Community Member, I want to exercise and inspect a $5 monthly subscription in Stripe test mode, so that billing can be validated before real collection.
56. As a pilot participant, I want Community access regardless of test checkout status, so that the pilot is not blocked by simulated payment.
57. As a Community Member, I want in-app and email notices for relevant membership, Exchange, Dispute, and vote events, so that I can act on time.
58. As a mobile participant, I want an installable responsive app with camera upload and recoverable drafts or interrupted uploads, so that I can use it during real handoffs.
59. As a Community Administrator, I want pilot metrics based on real records, so that I can assess activation, supply, demand, Exchanges, trust, and repeat participation.
60. As a person using a keyboard or screen reader, I want the core journeys to remain operable, so that I can participate accessibly.

## Implementation Decisions

### Domain model and invariants

| Concept | Identity and relationships | Invariants |
| --- | --- | --- |
| Person and account | One authenticated person may hold memberships in several Communities. | Email verification is required before Community creation or a membership request. |
| Community | Private boundary with one or more Community Administrators. | Its creator is its first administrator; unrelated people cannot discover its records. |
| Invite | Issued by a Community Administrator for one Community, with expiry and redemption record. | It permits a membership request, never direct membership; expired or consumed Invites cannot be reused. |
| Membership | One person in one Community, with role, lifecycle state, and decision history. | Only active members start new Community activity. Suspension or removal does not erase prior records. |
| Vouch | Statement by an eligible sponsor about an applicant in the same Community. | It neither grants access nor changes a score; at most three per sponsor in a rolling year by default. |
| Listing | Item or Help offer owned by a Community Member. | Community-scoped; only the owner or an authorized moderator changes it. Item availability is explicit date ranges. |
| Need Post | Open item or Help need owned by a Community Member. | An item Need Post response only points to a Listing; it is not a Borrow Request or Exchange. |
| Borrow Request | A borrower's application to one item Listing for proposed dates. | Several may be pending; one item cannot have overlapping approved reservations. |
| Exchange | One item loan or one requester-helper commitment, with participants, Community, schedule, state, and event history. | One completed Exchange contributes one Qualifying Interaction to each participant, at most once. Every helper has a separate Help Exchange. |
| Handoff and Return | Timestamped item condition, accessories, acknowledgments, and optional evidence. | Photos are optional; retries cannot duplicate evidence or advance state twice. Help Exchanges have neither record. |
| Reputation Event and scores | A verified event belongs to a recipient, Community, rule, and source; the server calculates scores from the append-only ledger. | Rule, source, and recipient identify an automatic award. Corrections append linked events. A client cannot write a score or verified event directly. |
| Dispute | Case linked to an Exchange, reporter, respondents, evidence, responses, and outcome. | Opens while active or within 30 days after completion. It never grants administrators general access to private conversations. |
| Community Disciplinary Vote | Case with accused member, frozen electorate, ballots, timestamps, and immutable outcome. | One ballot per eligible voter; an accused member cannot vote; passing result requires quorum and two-thirds in favor. |
| Subscription | Person's Stripe test-mode subscription and verified webhook history. | Billing status never grants or removes MVP Community access. |

Every Community-owned entity carries an immutable Community identifier. Cross-Community score aggregation uses verified history even after membership removal, while detailed records obey the viewer's access boundary. Timestamps and deadlines use UTC in storage and local time in display; item reservation calendar dates follow ADR 0004.

### State machines

State transitions are server operations in one transaction with authorization, guard checks, state update, event or audit append, and notification enqueue. A repeated operation with the same intent returns the prior result; a stale or invalid transition fails without partial effects. Background deadlines use the same transition operations as interactive clients.

**Membership.** `approved` is the administrator's recorded decision, not a waiting state: approval makes the membership `active` in the same transaction. This preserves the PRD's immediate access after administrator approval.

| From | Command and actor | Guard | To and effect |
| --- | --- | --- | --- |
| None | Redeem Invite; verified invitee | Invite valid and unconsumed | `pending`; consume Invite and notify administrators. |
| `pending` | Approve; Community Administrator | Same Community, still pending | `active`; record approval and audit event, notify applicant. |
| `pending` | Reject; Community Administrator | Same Community, still pending | `rejected`; record reason and audit event, notify applicant. |
| `active` | Suspend; Community Administrator | Same Community, reason provided | `suspended`; stop new activity and audit. |
| `suspended` | Reinstate; Community Administrator | Same Community, reason provided | `active`; restore new-activity rights and audit. |
| `active` or `suspended` | Remove; Community Administrator after valid vote when vote-based | Same Community and recorded reason | `removed`; stop new activity and audit, retain narrow access to own unresolved obligations. |

`rejected` and `removed` are terminal for that membership request. A later application requires a new Invite and decision. A suspended or removed member may finish their own existing Exchanges and Disputes under the narrow participant exception, but cannot initiate new Listings, Need Posts, Borrow Requests, messages, or votes.

**Borrow Request and item Exchange.** The member-facing lifecycle begins at `requested`. The Borrow Request owns that state and the approval decision; approval atomically creates or links the item Exchange. The Exchange then owns fulfillment states. This avoids multiple active Exchange records for pending applicants.

| From | Command and actor | Guard | To and effect |
| --- | --- | --- | --- |
| None | Submit Borrow Request; active member | Listing available, requested dates valid | Request `requested`; notify owner. |
| Request `requested` | Approve; Listing owner | Meets minimum local score; owner-choice policy; no overlapping approved reservation | Request `approved`, Exchange `approved`; reserve dates for 48 hours, notify borrower. |
| Request `requested` | Decline; Listing owner | Request pending | Request `rejected`; notify borrower. |
| Exchange `approved` | Acknowledge terms; borrower | Before 48-hour expiry; confirms return date, condition, replacement value, responsibility | Exchange `handoff_pending`; retain reservation, enable scheduling. |
| Exchange `approved` | Expire; server deadline | No acknowledgment by deadline | Request `expired`, Exchange `expired`; release reservation, notify both. |
| Exchange `handoff_pending` | Confirm Handoff; participants | Confirmed schedule and recorded condition/accessories; photo prompt shown, upload optional | `checked_out`; record Handoff once. |
| Exchange `checked_out` | Record Return; either participant | Physical item returned, condition recorded; photo prompt shown | `return_pending`; notify counterparty for confirmation. |
| Exchange `return_pending` | Confirm Return; both participants | Both confirm condition without discrepancy | `returned`; physical Return and condition agreement recorded. |
| Exchange `returned` | Finalize; server | Required confirmations present and no blocking Dispute | `completed`; issue Qualifying Interactions and Reputation Events atomically once, publish safe feed event. |
| Exchange `approved` or `handoff_pending` | Cancel; either participant | Handoff has not occurred; reason supplied | `cancelled`; release reservation, record reason, no automatic score loss. |
| Exchange `checked_out` or `return_pending` | Report issue; either participant | Active Exchange | Keep fulfillment state, attach open Dispute; block ordinary Finalize. |
| Exchange `completed` | Report issue; either participant | Within 30 days of completion | Keep `completed`, attach open Dispute; any score correction is compensating, never state rollback. |

`disputed` is a derived presentation of an open Dispute on the Exchange, not a replacement for its fulfillment state. A conflicting Return confirmation opens the Dispute path instead of reaching `returned`. Seven days after a requested confirmation remains missing despite reminders, the Exchange enters an administrator review queue while retaining its current state. Administrator review never completes an Exchange merely because time passed. For an item Exchange, verified completion requires a recorded Handoff and Return, at least one participant's Return confirmation, no unresolved condition disagreement, and an administrator decision citing the records that establish Return and condition. If those facts cannot be verified, the administrator closes the Exchange as `closed_without_completion` with a reason. The decision and any completion effects occur once in the guarded transition. Concurrency control covers approval and reservation overlap atomically.

**Help Exchange.** Accepting a helper creates one Exchange per helper. Its states are `committed` → `scheduled` → `completion_pending` → `completed`. The requester or helper may cancel `committed` or `scheduled` with a reason. Either may confirm work in `scheduled`, moving to `completion_pending`; the second matching confirmation completes it, counts one Qualifying Interaction for each, and awards helper +3 once. A conflicting account opens a Dispute. Seven days of missing confirmation despite reminders enters administrator review, never automatic completion. Administrator verified completion requires one participant's completion confirmation, supporting Exchange records or submitted evidence of work, no unresolved conflicting account, and a reasoned decision citing that evidence. Otherwise the administrator closes the Exchange as `closed_without_completion` with a reason. Each helper's state and outcome are independent of other helpers on the same Need Post.

**Dispute.** `no_issue` means there is no case. One open case per Exchange issue is permitted; a new report on an already open case adds evidence or response rather than creating a competing resolution.

| From | Command and actor | Guard | To and effect |
| --- | --- | --- | --- |
| None | Report issue; Exchange participant | Active Exchange or within 30 days after completion | `issue_reported`; notify other participant and administrator. |
| `issue_reported` | Submit response or proposed repair; participant | Case open | `repairing` or `replacement_agreed` when both agree; preserve evidence. |
| `issue_reported`, `repairing`, or `replacement_agreed` | Confirm settlement; both participants | Recorded agreed remedy and both confirmations | `resolved`; record outcome and unblock eligible Exchange completion. |
| `issue_reported` or `repairing` | Contest or request review; either participant | Case open | `disputed`; preserve positions and notify administrator. |
| `disputed` or unresolved `issue_reported` | Open review; Community Administrator | Same Community; evidence and responses available to both participants | `admin_review`; record reviewer action. |
| `admin_review` | Decide; Community Administrator | Reasoned outcome recorded | `resolved` or `unresolved`; apply only verified Reputation Events and record audit. |

An administrator may move `replacement_agreed` to `admin_review` if the remedy stalls. `resolved` and `unresolved` are closed outcomes; a later correction appends a linked record and compensating Reputation Event rather than rewriting history. Unresolved cases remain prominent trust indicators. Reporting an issue never exposes unsubmitted messages to the administrator.

**Community Disciplinary Vote.** `open` begins with a frozen eligible voter set and a seven-day close time. During `open`, each eligible voter may cast one immutable ballot and the accused may submit a response but not vote. At the deadline, server closure records `passed` only if turnout is at least `ceil(0.30 × eligible voters)` and at least two-thirds of cast ballots favor removal; otherwise it records `failed`. Zero eligible voters blocks opening. A passing vote permits an administrator's audited removal transition; it does not silently mutate membership. Duplicate ballots and late ballots fail.

### Authorization boundaries

| Actor | Allowed scope | Explicit denial |
| --- | --- | --- |
| Unverified account | Own authentication and verification flow | Community creation and membership request. |
| Invitee with pending or rejected membership | Own Invite, application, and decision | Community content and new activity. |
| Active Community Member | Community feed, directory, Listings, Need Posts, own requests and Exchanges, permitted local profiles | Records of other private Communities and another person's private evidence. |
| Listing owner | Own Listing, its Borrow Requests, allocation decision, own Exchanges | Another owner's Listing mutation or unrelated private conversation. |
| Exchange participant | Own Exchange, evidence, Dispute, and relevant messages | Other Exchanges' private logistics and evidence. |
| Community Administrator | Membership decisions, moderation, submitted Dispute evidence, vote initiation, reasoned Reputation Event adjustment, audit view | General access to private conversations or other Communities' evidence. |
| Suspended or removed member | Own existing open Exchange and Dispute obligations and own reputation history | New Community activity; broad Community browsing after removal. |
| Any member viewing another person's global trust | Global score and count; incident type and status | Other Communities' identities, messages, evidence, and detailed Reputation Events absent shared membership. |
| Server and verified Stripe webhook | Policy transitions, deadlines, score calculation, subscription status | Client-authored score, admin status, vote result, or payment status. |

Enforce these boundaries at both server operations and Supabase Row Level Security, including storage objects and realtime subscriptions. Authorization is checked at execution time, including after a client disconnects or a membership changes. Audit entries for administrator actions, outcomes, and corrections are append-only.

### Major API and server operations

The exact HTTP shape is an implementation detail; these named operations are the stable contract. Every mutation authenticates its actor, checks Community scope and current state, accepts an idempotency key or source identity where retries are possible, and returns the resulting state or a typed authorization, validation, conflict, or expiry error.

| Operation group | Required commands and outputs |
| --- | --- |
| Community and membership | Create Community; issue and redeem Invite; approve or reject application; suspend, reinstate, or remove membership; list only accessible Communities and member directory. Return membership state and audit identity. |
| Listings and needs | Create, edit, withdraw, browse, search, and filter item or Help Listings and item or Help Need Posts; respond to item Need Post with a Listing. Return Community-scoped records and availability. |
| Allocation | Submit or decline Borrow Request; owner approval through the allocation policy boundary; expire reservation. Approval checks trust minimum and prevents overlapping reservations in one transaction. Return reservation deadline and Exchange identity. |
| Item Exchange | Acknowledge terms; propose and confirm Handoff schedule; record Handoff and optional evidence; cancel before Handoff; record Return and optional evidence; confirm condition; finalize or route disagreement to Dispute; send reminders and queue stalled review. Return state, next actor, and deadline. |
| Help Exchange | Commit and accept helper; schedule; confirm completion; cancel; route disagreement or silence to review. Return independent status for each helper. |
| Reputation | Append verified event; append linked correction; compute Community and Global Solidarity Scores and Qualifying Interaction counts; list explanation visible to actor; expose redacted cross-Community incident indicator. |
| Trust and governance | Submit Vouch; open Dispute; submit evidence, selected messages, response, or remedy; resolve or mark unresolved; open disciplinary vote, cast ballot, close vote; enact removal. Return immutable audit and outcome identifiers. |
| Communication | Start Community-scoped conversation, send and read participant-only messages; enqueue and deliver in-app or email notices with retry state. |
| Billing and pilot | Create Stripe test checkout session; ingest verified webhook idempotently; expose test subscription status; derive pilot metrics from persisted activity. |

- Build the documented React, TypeScript, Vite, Tailwind, shadcn/ui preset, Supabase, and Stripe architecture as responsive PWA vertical slices. Each slice includes UI, server behavior, persistence, authorization, and an observable acceptance journey.
- Use Supabase Auth for verified accounts. A verified account may create a private Community and becomes its first Community Administrator. Invite redemption creates a membership request; only administrator approval grants access. A Vouch is separate from an Invite and membership approval.
- Carry the Community boundary on every Community-owned record and enforce it with Row Level Security. Preserve narrowly scoped access to a removed person's own open Exchanges and Disputes. Participants alone can read conversations; administrators see only messages deliberately submitted as Dispute evidence.
- Keep authorization and state transitions for allocation, Exchanges, Reputation Events, moderation, votes, and subscriptions on the server. Record administrator actions and reputation corrections append-only.
- Use one server-side allocation policy boundary receiving the Listing, candidate Borrow Requests, and decision actor. Implement Owner Chooses for MVP; keep First Approved and Community Vote as future policies. Multiple requests can remain pending, but approved overlapping reservations cannot coexist. Owner approval reserves dates for 48 hours, then expires unless the borrower acknowledges terms.
- Keep Borrow Requests, item Need Posts, and Help Need Posts distinct in the domain even if storage is shared. A Need Post response does not itself create an Exchange. One committed helper creates one help Exchange; multiple helpers on one Need Post complete independently.
- Require the borrower to acknowledge return date, condition, replacement value, and responsibility terms before an item Exchange activates. Capture condition and accessories at Handoff and Return, with optional photos. Either participant can cancel before Handoff with a reason. After Handoff, problems use Return or Dispute.
- Complete an ordinary item Exchange only after both parties confirm Return condition. Complete ordinary help only after requester and helper confirm. After seven days of nonresponse despite reminders, send the case to administrator review without automatic completion. An administrator may verify completion only under the evidence rules above; otherwise close without completion. A participant may open a Dispute while active or within 30 days after completion.
- Compute Community Solidarity Score on the server as `clamp(50 + sum(verified Reputation Event points), 0, 100)`. A completed item or help Exchange is one Qualifying Interaction for each participant. Compute Global Solidarity Score as the completed-exchange-count-weighted average of Community scores, rounded to the nearest integer with halves rounded up. A Community with zero Qualifying Interactions has zero global weight; with none anywhere, show 50 — Unproven. Show Unproven locally until the first local completed Exchange. Use the PRD title thresholds afterward.
- Award item owner +2, successful borrower +1, completed helper +3, and thank-you recipient +1 at most once per completed Exchange. Posts, receiving help, and Vouches add no automatic points. Only administrator verification may award late return −2, unresolved damage −10, or confirmed theft −30. Identify each automatic event by rule, source, and recipient so retries cannot award twice. Corrections append a linked, reasoned compensating event.
- Show unresolved Disputes and confirmed serious violations separately from the numeric score. Cross-Community display exposes incident type and status but hides private Community identity, messages, and evidence from nonmembers. Members can inspect all events behind their own scores; others can inspect detailed events only in shared Communities. Membership removal preserves verified reputation history and its global contribution.
- Open a Community Disciplinary Vote for seven days. Freeze eligible voters at opening as approved, unsuspended members other than the accused. Require `ceil(0.30 × eligible voters)` for turnout and at least two-thirds of cast votes for removal; zero eligible voters cannot start a vote. Record closure and counts immutably. The administrator enacts a passing removal; suspension remains a separate power.
- Keep operational defaults centrally configurable: Invite lifetime seven days; at most three Vouches per eligible member in a rolling year when an administrator grants eligibility; listing availability uses explicit date ranges without recurrence. Store timestamps in UTC and display in local time. Enforce deadlines server-side.
- Use Stripe test mode for the $5 monthly subscription. Verify each webhook signature against the raw request body before recording it. Store the Stripe event ID uniquely with processing state, map the Stripe customer and subscription to the account, and reconcile subscription status from Stripe's current subscription object under one serialized subscription writer. A duplicate processed event returns the prior result; a pending or failed receipt remains retryable. An older event delivered later cannot restore stale status; Stripe event creation timestamps are not an ordering key. Test payment status does not grant or remove Community access. Live charging requires a later release.
- Deliver notifications in app and by email for time-sensitive events. Delivery failure creates retryable status without changing the underlying Exchange, Dispute, vote, or membership outcome.
- Use the PRD's contribution-oriented, lightweight normal flow and structured Dispute flow. Build on an HTTPS pilot URL for one real Community. Treat 20 active members, five completed Exchanges, and one repeat participant as a validation milestone, not an implementation gate.

## Testing Decisions

- Test externally observable behavior: what each actor can do and see, durable state after retries or deadlines, and which private data each actor cannot read. Do not assert component structure, table layout, or internal call order.
- The highest seam is authenticated browser journeys against a test backend for the full member and administrator flows. Add direct authorization checks against the data boundary for RLS and privacy, and focused server-level checks for score arithmetic, allocation concurrency, deadlines, idempotency, and vote thresholds where a browser journey cannot establish the invariant reliably.
- Cover the PRD's Alice and Bob item loan from Invite to feed entry, a multi-helper Help Need Post, a Dispute with corrected Reputation Events, a two-Community weighted Global Solidarity Score, a disciplinary vote, and Stripe test checkout and webhook retries.
- Verify that unapproved, suspended, removed, and unrelated people cannot see or mutate protected Community records; that nonparticipants cannot read private conversations; and that cross-Community indicators disclose only permitted fields.
- Verify failure cases: expired or reused Invite; below-minimum Borrow Request; overlapping concurrent approvals; expired reservation; duplicate Handoff, Return, confirmation, thank-you, event, and webhook submissions; interrupted photo upload; silent counterparty; Dispute deadline; no quorum; and notification delivery failure.
- The repository has no application or test suite, so there is no existing test prior art to follow. Use the execution plan's browser journey plus direct unauthorized-data-check pattern as the starting convention for the first slice, then reuse it across later slices.

### Acceptance tests

1. A verified person creates a private Community and is its active Community Administrator; an unrelated account cannot discover it by UI or direct data query.
2. An administrator issues an Invite; an invitee verifies email, redeems it, remains pending without content access, and becomes active only after approval. Rejection, expiry, and reuse do not grant access.
3. Suspending an active member blocks new Listings, Need Posts, Borrow Requests, messages, and ballots. Reinstatement restores those rights. Removal blocks new activity but preserves access to that person's open Exchange and Dispute obligations.
4. Alice lists a drill with a $180 replacement value and minimum local score 45. Bob requests Friday through Sunday; Alice sees his Community and Global Solidarity Scores as 50 — Unproven, zero completed Exchanges, and no unresolved Disputes. Alice approves him.
5. Two overlapping pending Borrow Requests coexist. Concurrent attempts to approve both yield exactly one approved reservation. The losing attempt returns a conflict and creates no Exchange or notification. Expiry after 48 hours releases a reservation if the borrower never acknowledges.
6. Bob acknowledges terms, the pair schedules and records Handoff, and optional photo upload can be skipped or retried. The Exchange reaches `checked_out` only once; cancellation is rejected after Handoff.
7. Bob returns the item, both confirm matching condition, and the Exchange reaches `returned` then `completed`. Each participant receives exactly one Qualifying Interaction; Alice gets +2, Bob +1; the feed omits private notes and evidence. Replayed requests change nothing.
8. A disagreement at Return opens a Dispute and blocks ordinary completion. A missing confirmation after reminders and seven days reaches administrator review, not automatic completion. The administrator either cites the required Return evidence and records verified completion once or closes the Exchange without completion and records a reason.
9. A member publishes an item Need Post, an owner answers with a Listing, and the author submits a separate Borrow Request. The response alone creates neither Exchange nor Reputation Event.
10. A Help Need Post asks for two helpers. One helper commits and completes while the second slot remains open. Requester and helper each confirm; only that helper earns +3 and both gain one Qualifying Interaction. A silent second participant triggers review without affecting the first outcome. Administrator verified completion requires the documented confirmation, supporting evidence, and reasoned decision; silence alone grants no points.
11. An eligible member Vouches for an applicant; the applicant remains pending and neither score changes. Duplicate, over-limit, and post-rejection Vouches fail.
12. Two active members exchange private messages. A nonparticipant administrator cannot query their conversation; a participant can submit selected messages as Dispute evidence, after which only those selected messages become reviewable.
13. An Exchange participant reports damage while active or within 30 days after completion, adds evidence, and the other participant responds. They can record a mutual remedy or escalate through `disputed` and `admin_review` to a reasoned `resolved` or `unresolved` outcome. A report after the deadline fails.
14. Verified late return, unresolved damage, and confirmed theft yield −2, −10, and −30 once per rule, source, and recipient. An administrator correction adds a linked compensating event; prior history remains visible. A client cannot create these events or change a score directly.
15. A member with 400 completed Exchanges in one Community and 20 in another receives a Global Solidarity Score with 20:1 weighting and half-up rounding. Zero-interaction Communities have no weight. A person with none displays 50 — Unproven. Scores clamp to 0–100.
16. An owner sees an unresolved Dispute or confirmed serious violation from another Community as type and status even when its weighted score effect is small, but cannot see that Community's name, messages, or evidence.
17. A Community Administrator opens a seven-day removal vote. The accused sees the allegation and responds. The electorate is frozen; each eligible member casts at most one ballot; closure applies the rounded-up 30% quorum and two-thirds threshold. Zero-voter opening, late ballots, and duplicate closure fail safely. Passing removal requires an audited administrator action.
18. Stripe test checkout, retry, cancellation, duplicate verified webhook delivery, and events delivered out of order produce status matching Stripe's current subscription. Forged client status fails; all pilot members retain Community access regardless of checkout result.
19. Time-sensitive membership, Exchange, Dispute, and vote notices appear in app and email; a delivery failure leaves the underlying state intact and a retryable delivery record.
20. Core journeys work by touch, keyboard, and screen reader on mobile and desktop. The installed PWA caches its shell, preserves a draft where practical, and recovers an interrupted upload without duplicate evidence.
21. Pilot metrics for invitations, approvals, Listings, Need Posts, Borrow Requests, completed Exchanges, repeat participants, Disputes, and contribution counts match underlying persisted records on the HTTPS pilot URL.

## Out of Scope

- Live payment collection and access gating by payment; production billing activation is the first post-MVP release.
- Public or cross-Community discovery of Communities or Listings, algorithmic matching, advanced recommendations, and a national marketplace.
- Full identity verification, lodging, vehicle sharing, childcare, and native mobile apps.
- Cash collateral, deposits, escrow, insurance, automatic damage reimbursement, cryptocurrency, or tokenized or purchasable reputation.
- Shared spaces, dedicated events, recurring availability, advanced governance, custom voting rules, Community treasuries, and federation.
- First Approved and Community Vote allocation as executable item-assignment policies; only Owner Chooses runs in MVP. Community Disciplinary Votes remain in scope.
- Push-notification improvements beyond the basic PWA and required in-app and email notices.

## Further Notes

- The PRD's functional completion contract has 29 capabilities; the execution plan maps them to 17 dependency-aware slices. Completion requires all slices' acceptance checks and demonstrated journeys on mobile and desktop, not reaching the pilot participation milestone.
- The source documents are the PRD, MVP execution plan, domain glossary, and ADRs 0001–0008. ADR 0001 defines reputation math; ADRs 0002–0008 define its implementation boundaries and other shared architecture. If they conflict during implementation, reconcile the decision in those documents before coding.
- The configured target is the repository's GitHub issue tracker. The published issue is the agent-facing copy of this specification.
