# MVP execution plan

This document turns [the PRD](../prd.md) into implementation work. Section 44 of the PRD is the functional completion contract. [The glossary](../GLOSSARY.md) defines domain terms; [ADR 0001](./adr/0001-global-and-community-reputation.md) records the two-score reputation decision. If a task conflicts with those sources, resolve the conflict in the PRD and this plan before coding.

## Starting point and delivery rule

The repository currently contains product documents and no application code. Build the PRD's recommended React, TypeScript, Vite, Tailwind, shadcn/ui (`--preset b4iB4lDuK`), Supabase, and Stripe test-mode stack. Keep credentials in environment configuration. Each numbered slice below delivers a usable path through UI, server behavior, persistence, authorization, and a behavioral test. A slice is complete when its acceptance checks pass on mobile and desktop; a screen backed only by mock data is incomplete.

The MVP runs on an HTTPS pilot URL with one real community, while Stripe stays in test mode. Pilot participation is never gated on test checkout. Production billing activation is the first post-MVP task. The validation milestone is 20 active members, five completed exchanges, and one repeat participant; reaching the milestone is a product experiment, not a coding acceptance gate.

## System contracts

### Access and privacy

- A verified account may create a private community and becomes its first administrator. One account may join several communities.
- An administrator issues an Invite; the recipient creates or signs into an account, verifies email, requests membership, and waits for administrator approval. A Vouch is a separate trust statement and grants no access.
- Every community-owned record carries a community boundary enforced by Supabase Row Level Security. A member sees community content only while approved, with a narrow exception for their own open exchanges and disputes after removal. Conversation contents are visible only to participants; administrators see only messages explicitly submitted as evidence.
- Authorization for score changes, votes, moderation, subscription status, and exchange transitions runs server-side. Audit records for administrator actions and reputation corrections are append-only.
- Cross-community trust indicators expose incident type and status. They do not expose the other community's identity, messages, or evidence to a nonmember.
- A person may inspect the events behind all of their own community scores and global aggregate. Another member sees the score and count globally, but detailed events only for communities they share. Removing a membership preserves verified reputation history and its global contribution.

### Exchange transitions

Keep allocation behind one server-side policy boundary that receives the listing, candidate Borrow Requests, and decision actor. Its MVP policy is Owner Chooses. First Approved and Community Vote allocation can later use the same boundary without changing the Borrow Request or exchange lifecycle.

| Flow | Required transitions and constraints |
| --- | --- |
| Borrow Request | Pending → owner-approved, awaiting borrower acknowledgment → active → handed off → return awaiting confirmations → completed or disputed. Owner approval reserves dates for 48 hours; expiry releases them. Multiple requests may be pending, but overlapping approved reservations for one item are rejected atomically. |
| Item handoff | Borrower acknowledges return date, condition, and replacement value before activation. Prompt for photos at handoff and return; uploads are optional. Both parties confirm return condition. A disagreement opens a dispute. Seven days of silence after reminders sends the case to administrator review, never automatic completion. |
| Cancellation | Either party may cancel before handoff with a recorded reason and no automatic score loss. Problems after handoff enter return or dispute. |
| Help | One committed helper produces one exchange, including when a Need Post asks for several helpers. Both requester and helper confirm completion. Seven days of silence after reminders sends it to administrator review. |
| Dispute | Either participant may open one while an exchange is active or within 30 days after completion. The administrator records evidence, responses, and outcome, and can close a stalled exchange after review. A later correction adds a linked compensating event. |

### Reputation calculation

Community Solidarity Score is `clamp(50 + sum(verified reputation event points), 0, 100)`. A completed item or help exchange counts once for each participant in that community. For communities with at least one completed exchange, Global Solidarity Score is the completed-exchange-count-weighted average of their community scores, rounded to the nearest integer with halves rounded up. Communities with no completed exchanges carry zero global weight. With no completed exchanges anywhere, the global display is **50 — Unproven**. Display **Unproven** in either context until its first completed exchange; thereafter use the configured title thresholds from PRD §21. Display the underlying counts.

Initial automatic events are owner successful share `+2`, borrower successful return `+1`, helper completed help `+3`, and recipient positive thank-you `+1` for at most one thank-you per exchange. Only an administrator can verify late return `−2`, unresolved damage `−10`, or confirmed theft `−30`. A score event has a unique source and recipient so retries cannot award it twice. Posts, receiving help, and vouches carry no automatic points. Corrections append a reasoned, linked compensating event. Unresolved disputes and confirmed serious violations also appear as separate trust indicators; the global average never hides them.

### Implementation defaults

These defaults fill operational gaps without changing the agreed product decisions. Keep them centrally configured so a later pilot adjustment is small: invites expire after seven days; a member may vouch for up to three applicants in a rolling year when an administrator grants eligibility; a disciplinary vote stays open for seven days; listing availability uses explicit date ranges without recurrence. Store timestamps in UTC and display them in the viewer's local time. A deadline is enforced server-side, including after a client disconnects.

## Slices

Work the dependency frontier: any slice whose blockers are complete may start. Each acceptance check describes observable behavior, not a particular component or table.

| ID | Slice | Blocked by | What becomes usable |
| --- | --- | --- | --- |
| 01 | Account and community creation | None | Verified user signs in and creates a private community as administrator. |
| 02 | Invite and membership | 01 | Invitee requests membership; administrator approves or rejects; user switches among approved communities. |
| 03 | Reputation baseline and member profile | 02 | Members see community and global starting scores, counts, titles, and a member directory. |
| 04 | Item listing and discovery | 02, 03 | Member publishes and finds an item within their community. |
| 05 | Borrow Request and approval | 04 | Borrower applies; owner checks trust and approves a nonoverlapping reservation. |
| 06 | Item handoff | 05 | Borrower acknowledges terms and receives the item with optional evidence. |
| 07 | Item return and completion | 06 | Both parties confirm return and close an ordinary loan. |
| 08 | Item reputation and thank-yous | 07 | Completed item loans update transparent scores; participants may thank each other. |
| 09 | Item Need Posts | 04, 05 | An open item need leads through a listing to a Borrow Request. |
| 10 | Help offers and Help Need Posts | 02, 03 | Member posts an offer or need and commits to help. |
| 11 | Help completion and reputation | 10, 08 | Both parties confirm help; each helper's exchange and score update independently. |
| 12 | Vouches | 02 | Eligible member vouches for an applicant without granting access. |
| 13 | Private messages | 02 | Approved members coordinate privately. |
| 14 | Disputes and administration | 07, 11, 13 | Participant reports an issue; administrator reviews evidence and records a decision. |
| 15 | Disciplinary votes and removal | 14 | Community votes on removal; administrator enacts the result and open records remain usable. |
| 16 | Stripe subscription in test mode | 02 | Member can exercise $5 subscription checkout without changing access rights. |
| 17 | Pilot delivery and acceptance | 08–16 | Responsive PWA, required notifications, metrics, and complete acceptance journeys work on an HTTPS pilot URL. |

### 01 — Account and community creation

- A person can register, verify email, sign in, sign out, and recover access through Supabase Auth. An unverified account cannot request membership or create a community.
- A verified user creates a private community and immediately sees its home as its first administrator. Another signed-in user cannot discover or read that community without an Invite.
- A browser-level journey and a direct unauthorized-data check prove the happy path and privacy boundary.

### 02 — Invite and membership

- An administrator issues an expiring Invite. The recipient requests membership; the administrator approves or rejects with the result visible to the applicant. Reusing an expired or consumed Invite fails.
- An approved member can access only their communities and switch between them. Pending, rejected, suspended, and removed people cannot start new community activity.
- Membership decisions create audit records. Approval and rejection appear in the applicant's in-app notifications; email delivery has a retryable failure record.

### 03 — Reputation baseline and member profile

- New members see Community Solidarity Score 50 and Global Solidarity Score 50 with **Unproven** and zero completed exchanges. Two communities show distinct community profiles under one account.
- A member directory and profile show appropriate local activity and a global aggregate without leaking private content from another community.
- A server-owned score calculation and RLS tests show that the client cannot write a score or impersonate an administrator.

### 04 — Item listing and discovery

- A member creates, edits, and withdraws an item listing with title, description, category, images, condition, replacement value, pickup notes, lending conditions, availability dates, minimum Community Solidarity Score, and optional gratitude text.
- Approved members browse a mobile feed and listing view, search by keyword, and filter by category, type, and availability. An owner profile and request action are reachable from a listing.
- A member cannot edit another person's listing or view listings in a community they do not belong to. Images follow the same access boundary.

### 05 — Borrow Request and approval

- A member submits a Borrow Request with dates to an eligible listing. The owner sees local and global scores, completed-exchange counts, unresolved-dispute and confirmed-violation indicators, and the borrower's relevant local history.
- The owner chooses a borrower or declines. Approval reserves the dates for 48 hours; the borrower is notified; expiration releases the reservation. A request below the listing's local score minimum cannot be approved.
- Concurrent approval attempts for overlapping dates cannot both succeed, while several overlapping requests may remain pending. First Approved and Community Vote allocation are extension choices, with only owner choice executable in MVP.

### 06 — Item handoff

- The borrower acknowledges return date, condition expectations, replacement value, and responsibility terms before the reservation becomes an active exchange. A handoff records time, condition, accessories, and optional mobile camera photos.
- Owner and borrower can propose and confirm a handoff time and location; a change is visible to both and updates their reminders.
- Either party can cancel before handoff with a reason. An interrupted upload can be retried without creating duplicate evidence or changing exchange state twice.
- Both participants can see the current exchange status and schedule. The owner receives a handoff reminder in-app and by email.

### 07 — Item return and completion

- Either participant records a return with optional photos. Both confirm condition for an ordinary completion; a discrepancy opens a dispute route.
- Upcoming and overdue returns produce in-app and email notices. Seven days after one party fails to respond despite reminders, an administrator review item appears; the exchange remains incomplete.
- A completed exchange increments each participant's completed-exchange count exactly once. Duplicate confirmations and stale requests do not change the result.

### 08 — Item reputation and thank-yous

- A completed item loan awards the owner `+2` and borrower `+1` once, updates local and global scores, and shows each reason in history. Two communities with 400 and 20 completed exchanges influence the global score 20:1.
- Either participant may publish a thank-you tied to the completed exchange. The recipient receives `+1` at most once for that exchange; the thank-you appears on their profile and may appear in the feed.
- The completed exchange appears in the community feed without publishing private handoff notes or evidence.
- An administrator can make a reasoned adjustment or reverse an event with a linked compensating event. Clamping, retries, and cross-community isolation are verified through server-level tests.

### 09 — Item Need Posts

- A member publishes an item Need Post with description, category, dates, urgency, and optional image or value range. Members can find it in community requests and feed.
- A responder links an existing item listing or creates one. The Need Post author follows that listing's normal Borrow Request and owner approval flow.
- A response alone does not create an exchange or reputation event; only a completed exchange does.

### 10 — Help offers and Help Need Posts

- A member publishes a Help listing with skill, availability, and geographic constraints, or a Help Need Post with schedule, duration, location, and helper count.
- An approved member commits to help; the requester or offer owner accepts, creating one help exchange per helper. A request for two helpers can fill one place while the other remains open.
- The participants can coordinate and see scheduled help, without item condition, replacement value, or photo steps.

### 11 — Help completion and reputation

- Requester and helper each confirm completed help. Only then does the helper receive `+3`, each participant gain one completed exchange, and the global score recalculate.
- A silent counterparty produces reminders and administrator review after seven days, never automatic completion. Each helper's outcome is independent.
- The requester gains no points merely for receiving help. Thank-yous use the same once-per-exchange rule as item loans.

### 12 — Vouches

- An administrator controls who may vouch and the default limit. An eligible member can vouch for an applicant; the applicant and administrator can see the statement. The vouch does not approve membership or change a score.
- A vouch cannot be duplicated or submitted after the applicant is rejected or removed. The sponsor's history shows whom they vouched for, within the same community boundary.

### 13 — Private messages

- Two approved members in one community can start a private conversation and exchange messages for scheduling.
- A nonparticipant, including a community administrator, cannot query the conversation. Messages remain scoped to their community.

### 14 — Disputes and administration

- Either exchange participant reports an issue while active or within 30 days of completion, uploads evidence, and responds to the other party. The administrator sees submitted evidence and exchange records, then records a resolution or unresolved outcome.
- A participant may submit selected messages from their conversation as evidence. Administrators cannot browse the rest of the conversation.
- Verified late return, unresolved damage, and confirmed theft create `−2`, `−10`, and `−30` events respectively, once per verified source. Corrected outcomes append compensating events and preserve audit history.
- An owner viewing a borrower sees a prominent unresolved-dispute or confirmed-serious-violation indicator. For incidents in another community, the owner sees type and status without that community's identity, messages, or evidence.

### 15 — Disciplinary votes and removal

- An administrator opens a seven-day removal vote with reason and evidence. The accused can see the allegation and respond. Eligible voters are the approved, unsuspended members at opening, excluding the accused.
- Each eligible voter has one ballot. Turnout requires `ceil(0.30 × eligible voters)`; removal requires at least two-thirds of votes cast in favor. Closure records counts and result immutably, then the administrator enacts a passing decision.
- A vote cannot open with zero eligible voters. Failure to reach quorum, a tie, or a share of removal votes below two-thirds leaves the member in place.
- Administrators may separately suspend members. Removal stops new activity but preserves participant and administrator access to existing exchanges and disputes until resolution. Each action is audited.

### 16 — Stripe subscription in test mode

- A member can start, complete, and inspect a `$5/month` subscription in Stripe test mode. Server-verified webhook events, rather than client assertions, update test subscription status.
- Checkout failure, retry, cancellation, and duplicate webhook delivery produce stable status. A test subscription never blocks or grants community participation during MVP.
- Live keys are absent from the MVP environment. Activating real collection is documented as the first post-MVP deployment task.

### 17 — Pilot delivery and acceptance

- The app installs as a PWA, works on mobile and desktop, caches its basic shell, preserves a draft post where practical, and recovers from interrupted photo uploads. UI uses the specified shadcn preset and supports keyboard and screen-reader use for core flows.
- In-app notifications and email cover time-sensitive exchange, dispute, and vote events. Notification failure does not corrupt the underlying workflow; retry and delivery status are visible to administrators.
- A pilot metrics view or export derives invitations, approvals, listings, Need Posts, Borrow Requests, completed exchanges, repeat participants, disputes, and contribution counts from actual records.
- End-to-end journeys cover the PRD's Alice/Bob item loan, a multi-helper Help Need Post, a dispute with corrected reputation, a cross-community global score, a removal vote, and Stripe test checkout. Verify access denial at every community boundary.

## MVP completion check

PRD §44 coverage: **1–3** → 01–02; **4** → 16; **5** → 04; **6** → 10; **7** → 09; **8** → 10; **9** → 04, 09–10; **10–13** → 05; **14–16** → 06; **17–19** → 07; **20** → 08, 11, 14; **21** → 08; **22** → 12; **23–24** → 14; **25–26** → 15; **27** → 13; **28** → 03, 08; **29** → 10–11.

The MVP is complete when slices 01–17 pass, every PRD §44 capability is covered by a demonstrated journey, and the pilot URL supports a real community without live charging. Record remaining defects against the slice they break. After that, activate production billing in a separate release with live Stripe configuration, webhook verification, payment failure handling, and an explicit migration plan for pilot members.

