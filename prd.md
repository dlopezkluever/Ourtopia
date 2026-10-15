# Mutual Aid Community Platform
## Product Requirements Document

**Status:** MVP Definition; implementation decisions recorded

**Platform:** Mobile-first Progressive Web App  
**Initial validation target:** 1 community, 20 active members, 5 completed exchanges  
**Working concept:** Private community mutual-aid and resource-sharing network
**Agent execution plan:** [MVP execution plan](docs/MVP-EXECUTION-PLAN.md)

---

# 1. Product Summary

The product is a private, community-based platform that helps trusted groups share resources, labor, spaces, and activities without turning every interaction into a commercial transaction.

Members join closed communities, list things they are willing to share, offer their time or skills, request resources or assistance, and coordinate exchanges through a lightweight scheduling and trust system.

The platform is designed around four core principles:

1. **Share unused resources**
2. **Help people within trusted communities**
3. **Reward contribution and responsible behavior**
4. **Create enough accountability that generosity does not require blind trust**

The product should feel substantially more casual than Airbnb, Turo, or a rental marketplace.

It should feel closer to:

> “People in my community helping one another, with software handling the annoy3ng coordination and trust problems.”

The product should not require users to monetize their possessions or labor.

The default economic model is:

> **Free sharing, voluntary gratitude, community reputation, and accountability.**

---

# 2. Product Positioning

## 2.1 Core Positioning

The general product is a:

**Private mutual-aid operating system for communities.**

It is not primarily:

- a rental marketplace
- Craigslist
- Facebook Marketplace
- Airbnb for objects
- a gig-work platform
- a payment marketplace

Instead, it coordinates reciprocal community behavior.

---

# 2.2 Initial Market

The initial niche may focus heavily on groups interested in:

- mutual aid
- democratic socialism
- cooperatives
- local community organization
- anti-consumerism
- sharing economies
- religious communities
- intentional communities
- neighborhood associations
- clubs
- friend groups

The product itself should not be structurally limited to one ideology.

Its architecture should support communities with radically different identities and cultures.

Examples:

- local socialist organization
- church congregation
- neighborhood group
- university club
- outdoors club
- extended family network
- intentional community
- apartment building
- maker community

---

# 2.3 Brand Personality

The initial product may use playful socialist terminology.

Examples:

- **Solidarity Score**
- **Comrade**
- **Lumpen**
- **Revolutionary**
- **The Gulag**
- **Collective**
- **Comrade since 2026**
- **Contributions to the Collective**

These labels should be treated primarily as a configurable presentation layer.

The underlying concepts should use neutral internal names such as:

- reputation score
- membership status
- suspension
- community
- contribution

This keeps the architecture reusable if later communities prefer different terminology.


### **For UI Design**: please use Shadcn with the --preset b4iB4lDuK  
---

# 3. Product Goals

## 3.1 Primary Goal

Make it substantially easier and safer for members of an existing community to share resources and labor with one another.

---

# 3.2 MVP Validation Goal

The first meaningful validation milestone is:

- 1 functioning community
- 20 members
- meaningful inventory or service listings
- at least 5 completed exchanges
- at least one repeat participant

An exchange can include:

- borrowed object
- completed help request
- use of shared space
- community activity coordinated through the platform

The MVP should optimize for achieving this milestone rather than for scale.

---

# 3.3 Product Success Signals

Early success should be measured using:

- activated community members
- listings created
- requests created
- requests fulfilled
- completed exchanges
- percentage of members contributing
- repeat exchanges
- successful returns
- disputes
- unresolved disputes
- average Solidarity Score
- time from request to accepted exchange

---

# 4. Community Model

## 4.1 Community Structure

The platform supports multiple independent communities.

A user may belong to multiple communities in MVP.

For MVP, communities are:

- private
- invite-based
- administrator-managed

Section 44 is the functional MVP completion contract, including the help exchange addition. Supporting security, accessibility, and mobile requirements still apply. Other suggested screens and features are not separate MVP completion gates.

Future community discovery may be added later.

---

# 4.2 Community Creation

Any registered user may create a community.

New communities are private by default.

The creator becomes the initial:

**Community Administrator**

---

# 4.3 Joining a Community

MVP membership requires:

1. an administrator-issued invitation
2. an account
3. administrator approval

An invite only allows a person to request membership. A vouch is a separate trust statement that an eligible existing member can submit for an applicant; it does not grant access or replace administrator approval.

Full identity verification is explicitly excluded from MVP.

Basic email verification should still be required.

Phone verification may be added later.

---

# 4.4 Member Vouching

Existing members may receive a limited ability to vouch for new members.

A vouch represents:

> “I personally believe this person can be trusted to participate responsibly in this community.”

A vouch becomes part of both users' reputation history.

If a vouched member becomes a strong contributor, the sponsor may receive a small positive reputation effect.

If a vouched member commits serious violations, the sponsor may receive a small reputation penalty.

The effect should remain intentionally small.

Members should not be destroyed reputationally because someone they vouched for later behaved badly.

For MVP, vouches are visible trust statements with administrator-controlled eligibility and limits. They do not automatically change either person's score. Sponsor and applicant score effects are post-MVP.

---

# 5. Membership Roles

MVP roles:

### Member

Can:

- view the community
- create listings
- make requests
- offer help
- request help
- request shared resources
- approve or decline requests for their resources
- participate in community votes
- submit reputation feedback
- report incidents
- vouch for members if permitted

---

### Community Administrator

Can perform all member actions plus:

- approve members
- reject membership requests
- remove members
- suspend members
- review disputes
- create community announcements
- modify community rules
- set community preferences
- manually modify reputation scores with a recorded reason
- start community disciplinary votes
- moderate posts/listings

Manual reputation changes must always create an audit record.

---

# 6. Monthly Platform Fee

Planned pricing after MVP:

**$5 per member per month**

The MVP includes a working Stripe subscription workflow in **test mode**. Live payment collection and production billing activation are the first planned work after MVP, and are not required to declare MVP complete. Test-mode payments do not make a member paid in the real world.

Once production billing is activated after MVP, the fee provides access to the platform/community. During MVP, test checkout does not gate participation.

This is not a fee for individual borrowing transactions.

The platform team receives the subscription revenue.

Community-specific financial treasuries and automatic revenue sharing are not required for V1.

Community organizations may separately collect dues outside the platform if they choose.

A future version may support:

- community dues
- community treasuries
- configurable revenue sharing
- fundraising
- donations

Those should remain outside MVP unless implementation proves trivial.

---

# 7. Core Content Types

The MVP contains four primary contribution/request types.

---

## 7.1 Share an Item

A user offers a physical resource.

Examples:

- drill
- kayak
- camping tent
- bicycle
- ladder
- pressure washer
- guitar
- sports equipment
- camera
- cookware

Fields:

- title
- description
- category
- images
- approximate replacement value
- current condition
- availability
- lending conditions
- minimum Solidarity Score
- approval policy
- location/pickup notes
- suggested gratitude
- optional maintenance contribution suggestion

---

## 7.2 Offer Help

A user offers time or skills.

Examples:

- moving help
- basic car maintenance
- tutoring
- cooking
- yardwork
- coding help
- furniture assembly
- language practice

Fields:

- title
- description
- category
- estimated availability
- skill level
- geographic constraints
- scheduling preferences

---

## 7.3 Request Something

A member creates a **Need Post** seeking an item or resource from the community. This is distinct from a **Borrow Request**, which applies to a specific item listing and proposed borrowing period.

Example:

> “Does anyone have a tent I can use next weekend?”

Fields:

- title
- description
- requested dates
- category
- urgency
- optional image
- optional replacement-value range

Members may respond by linking an existing item listing or creating a new one. The Need Post author then submits a Borrow Request through the normal owner approval and item exchange flow.

---

## 7.4 Request Help

A member creates a **Need Post** seeking another person's time or assistance.

Example:

> “Need two people to help move a couch Saturday afternoon.”

Fields:

- title
- description
- requested date/time
- approximate duration
- number of helpers needed
- location
- category

---

## 7.5 Help Exchanges

A member can commit to an offer of help or respond to a help Need Post. Each committed helper creates a separate exchange, including when a Need Post asks for multiple helpers. The requester and helper each confirm ordinary completion before the exchange affects reputation. Help exchanges do not require item condition photos or a replacement value.

If one participant does not confirm completion after seven days and reminders, an administrator reviews the exchange. It is not completed automatically. The administrator may verify completion from one participant's confirmation and supporting evidence of work, with a recorded reason and no unresolved conflicting account. Otherwise the administrator closes it without completion.

---

# 8. Future Content Types

Explicitly postponed:

### Shared Spaces

Examples:

- workshop
- pool
- backyard
- meeting room
- studio

Overnight lodging should not be included when shared spaces first launch.

---

### Events

Examples:

- community soccer game
- hiking trip
- tool workshop
- cookout
- volunteer day

Basic activity posts may exist in the feed before a dedicated event system is built.

---

# 9. Listing Discovery

Members can browse resources within their communities.

MVP discovery should include:

- community feed
- listings page
- search
- basic category filters
- availability indicator
- Solidarity Score requirement
- listing owner profile
- request button

Example categories:

- tools
- outdoors
- recreation
- electronics
- kitchen
- transportation equipment
- sports
- creative
- household
- labor
- education
- miscellaneous

---

# 10. Lending Workflow

A standard item exchange follows:

```text
Discover item
    ↓
View listing
    ↓
Request dates
    ↓
Owner reviews borrower
    ↓
Owner approves / rejects
    ↓
Borrow agreement generated
    ↓
Handoff
    ↓
Condition photos recorded
    ↓
Borrow period
    ↓
Return
    ↓
Return photos recorded
    ↓
Both parties confirm
    ↓
Exchange completed
    ↓
Reputation effects applied
```

---

# 11. Owner Approval Controls

The owner remains the final authority over their property.

Listings can support different allocation rules.

Possible modes:

### Owner Chooses

Owner manually chooses among requests.

### First Approved

Owner approves the first acceptable borrower.

### Community Vote

Multiple competing requests may be submitted to the community for voting.

### Automatic Eligibility

Future feature based on defined reputation criteria.

For MVP, the owner reviews Borrow Requests and chooses whom to approve. The domain should leave a clear extension point for other allocation policies, but First Approved and Community Vote allocation behavior are post-MVP. This Community Vote is distinct from the MVP Community Disciplinary Vote.

Several Borrow Requests for overlapping dates may remain pending, but the system must prevent approval of overlapping exchanges for the same item.

---

# 12. Trust and Evidence

The platform must preserve the casual nature of sharing while generating enough evidence to resolve serious disputes.

Evidence should be captured without making every transaction feel like a legal contract.

---

# 13. Check-Out Evidence

At handoff, users should be encouraged to record:

- item photographs
- existing scratches/damage
- included accessories
- current condition
- handoff date/time

The application should support camera uploads directly from mobile devices.

Condition photos are prompted for but optional at handoff and return. A normal exchange may be completed without photos. The borrower's condition and replacement-value acknowledgment is required.

The borrower confirms:

> The item was received in the documented condition.

---

# 14. Return Evidence

Upon return:

- owner may upload new photos
- borrower may upload photos
- both parties confirm condition
- discrepancies may trigger dispute flow

An uneventful return should take only a few taps.

Photo uploads remain optional. Both parties confirm the return condition for ordinary completion or report a discrepancy.

A disagreement opens a dispute. If one party has not responded after seven days and reminders, an administrator reviews the record; the platform does not silently complete the exchange. The administrator may verify completion from the recorded Handoff and Return, one participant's Return confirmation, and cited evidence of Return and condition when no unresolved disagreement remains. Otherwise the administrator closes it without completion.

---

# 15. Borrower Responsibility Agreement

Before approval becomes active, borrowers acknowledge:

- expected return date
- approximate replacement value
- condition expectations
- responsibility to communicate damage
- expectation that negligent damage should be repaired or otherwise resolved with the owner

Owner approval reserves the item's dates. The Borrow Request becomes an active exchange only when the borrower acknowledges these terms. If the borrower has not acknowledged within 48 hours, approval expires and the dates reopen.

Either party may cancel before handoff with a recorded reason. Cancellation alone does not automatically reduce reputation. Problems after handoff proceed through return or dispute.

This is not platform insurance.

The platform does not guarantee reimbursement.

---

# 16. Cash Collateral

Actual payment collateral is excluded from MVP.

Listings may show:

**Estimated replacement value**

Example:

> Replacement value: approximately $400

Borrowers explicitly acknowledge this value.

Future versions may allow refundable security deposits.

---

# 17. Gratitude Payments

Borrowing remains fundamentally free.

Owners may optionally enable:

- suggested gratitude amount
- maintenance contribution suggestion

Examples:

> “If you want, chip in $5 toward blades.”

> “Optional contribution toward gas.”

Payment cannot:

- determine request priority
- increase Solidarity Score
- guarantee approval
- convert the listing into a rental

The interface should visually distinguish gratitude from a rental price.

MVP shows optional suggested gratitude or maintenance text on a listing but provides no in-app gratitude payment flow.

---

# 18. Solidarity Score

The Solidarity Score is one of the central product systems.

Each member receives a **Community Solidarity Score** for each community they belong to. Each person also receives a **Global Solidarity Score** derived from their community scores.

Both scores use a:

**0–100 Solidarity Score**

A new member begins approximately in the middle as:

**50 — Unproven**

The precise starting value should remain configurable.

**Unproven** is the displayed standing until a person completes an exchange. After their first completed exchange, the score thresholds determine their title.

The Global Solidarity Score weights each community's score by the person's count of completed exchanges in that community. One completed item or help exchange counts once for each participant. For example, 400 completed exchanges in one community and 20 in another give those communities a 20:1 influence on the global score. Posts, thank-yous, and vouches do not add to that weight. Communities with no completed exchanges contribute no weight. A person with no completed exchanges across all communities displays **50 — Unproven** globally. Show the completed exchange count beside each score. Round the weighted average to the nearest integer, with halves rounded up.

---

# 19. Solidarity Score Philosophy

The score measures:

> Whether a community member contributes responsibly, keeps commitments, respects shared resources, and participates constructively.

Important principle:

**Receiving help is not bad behavior.**

Therefore:

- borrowing successfully is neutral or slightly positive
- requesting help is neutral
- owning little is irrelevant
- being poor is irrelevant
- damaging something and repairing it should not destroy reputation
- refusing to resolve damage should substantially reduce reputation
- lending and helping others increases reputation

The system should reward reciprocity without punishing people for legitimately needing help.

---

# 20. Reputation Components

The overall score should be derived from transparent submetrics.

User profiles should display:

- things shared
- successful borrows
- help offered/completed
- hours helped
- successful returns
- reliability
- stewardship
- thank-yous received
- people vouched for
- disputes
- unresolved disputes
- total completed interactions

Example:

```text
Solidarity Score

82 — Revolutionary
(37 interactions)

Things Shared             14
Successful Borrows        8
Hours Helped              19
Reliability               96%
Successful Returns        100%
Thank-Yous                21
Members Vouched For       3
Unresolved Disputes       0
```

---

# 21. Reputation Titles

Users ascend through humorous ideological ranks as their standing improves.

Initial proposed progression:

### Lumpen

Very new or low-standing user.

### Petty Bourgeoisie

Established but modest contributor.

### Comrade

Reliable community participant.

### Revolutionary

Highly trusted contributor.

### General

Major community contributor.

### Dictator

Extremely high long-term standing.

The exact thresholds should be configuration rather than hard-coded UI logic.

Example starting thresholds:

```text
0–39    Lumpen
40–54   Petty Bourgeoisie
55–69   Comrade
70–84   Revolutionary
85–94   General
95–100  Dictator
```

These names are intentionally playful.

Communities may eventually customize reputation titles.

---

# 22. Reputation Inputs

Potential positive signals:

- item successfully shared
- help request completed
- assistance offered
- successful item return
- on-time return
- positive counterparty feedback
- thank-you received
- responsible dispute resolution
- trusted member vouch
- long-term good behavior

Potential negative signals:

- no-show
- very late return without communication
- property damage
- dishonest condition reporting
- unresolved damage
- repeated accepted requests followed by cancellation
- theft
- harassment
- serious community rule violations

Weights should be configurable and implemented centrally rather than scattered throughout application logic.

For MVP, use the sample weights in Section 40 as initial centrally configured values. Community scores start at 50 and are clamped to 0–100. Every score change records its source. Only one thank-you per completed exchange may carry a reputation effect. Administrator adjustments require a reason and an audit record.

---

# 23. Reputation and Owner Discretion

Owners may:

- view another member's Community Solidarity Score for their shared community and Global Solidarity Score
- inspect reputation details
- inspect completed exchange count
- inspect unresolved disputes
- inspect vouches
- require a minimum Community Solidarity Score in the listing's community
- decline a request because of insufficient trust history

Example:

> Minimum Community Solidarity Score: 65

Owners can also see the borrower's Global Solidarity Score and the number of completed exchanges behind it when making a decision.

An unresolved dispute or confirmed serious violation must appear as a separate prominent trust indicator when a member requests an item, even if their Global Solidarity Score changes little because the incident occurred in a lower-volume community.

Across community boundaries, the indicator may disclose incident type and status but not the other community's identity, private evidence, or messages unless the viewer belongs to that community.

Owners may make trust decisions using behavior recorded within the platform.

The platform should not facilitate exclusion based on legally protected personal characteristics.

---

# 24. Dispute Resolution

Potential statuses:

```text
No Issue
Issue Reported
Repairing
Replacement Agreed
Resolved
Disputed
Admin Review
Unresolved
```

---

# 25. Damage Workflow

Example:

```text
Owner reports damage
    ↓
Uploads evidence
    ↓
Borrower receives notification
    ↓
Borrower responds
    ↓
Parties attempt resolution
    ↓
Resolved OR Admin Review
```

Possible resolutions:

- borrower repairs item
- borrower replaces item
- parties mutually agree no compensation necessary
- parties agree on another resolution
- dispute remains unresolved

The platform records the outcome.

Either exchange participant may report a dispute while an exchange is active or within 30 days after completion. Administrators review submitted evidence and record an outcome.

---

# 26. Serious Misconduct

Serious behavior may include:

- theft
- intentional destruction
- repeated unresolved damage
- harassment
- fraud
- severe community-rule violations

Possible consequences:

- reputation reduction
- temporary suspension
- restrictions on borrowing
- admin removal
- community disciplinary vote

---

# 27. Community Vote: “The Gulag”

Communities may vote to suspend or remove a member.

For MVP, the Community Disciplinary Vote is an administrator-initiated removal vote. Administrators retain separate authority to suspend a member temporarily. The accused member may view the allegation and submit a response before the vote closes.

The playful UI label may be:

**Send to the Gulag**

Internally this should be implemented as:

**Community Disciplinary Vote**

A vote should contain:

- accused member
- initiating reason
- evidence
- vote opening time
- vote closing time
- eligible voters
- votes for removal
- votes against removal
- final outcome

Communities should configure voting thresholds.

Example:

```text
Minimum turnout: 30%
Removal threshold: two-thirds of votes cast
```

MVP uses 30% minimum turnout and a two-thirds removal threshold.

Eligible voters are approved, unsuspended community members at vote opening, excluding the accused. Round the 30% turnout requirement up to a whole voter. Removal passes when at least two-thirds of votes cast favor removal. The administrator records and enacts the result.

The accused user should be able to view the allegation and submit a response.

---

# 28. Administrator Powers

Administrators can:

- approve members
- remove members
- suspend members
- moderate content
- create announcements
- initiate disciplinary review
- review submitted dispute evidence
- adjust reputation
- close disputes

Admin actions should create immutable audit records.

Removing a member immediately prevents new community activity. Existing exchanges, disputes, and their records remain accessible to the participants and community administrators until resolved.

---

# 29. Private Messaging

Users may privately communicate regarding:

- borrowing
- handoff logistics
- help requests
- scheduling

Any two approved members who share a community may start a private conversation scoped to that community. Only conversation participants can read it unless they submit selected messages as dispute evidence.

Private messages are not generally visible to administrators.

During disputes, participants may explicitly submit relevant messages as evidence.

Admins should only see:

- submitted evidence
- transaction records
- reports

They should not receive unrestricted access to private conversations.

---

# 30. Community Feed

The feed serves as the central community homepage.

Potential feed entries:

- new item shared
- help offered
- request posted
- request fulfilled
- member joined
- thank-you posted
- community announcement
- disciplinary vote
- major contribution milestone

Example:

> Rosa shared a pressure washer.

> Daniel completed 25 acts of solidarity.

> Malik needs help moving Saturday.

> Jamie reached Revolutionary status.

---

# 31. Profiles

Profiles should contain:

- display name
- profile photo
- short bio
- member since
- community memberships
- Solidarity Score
- title
- interaction count
- detailed reputation metrics
- resources shared
- active offers
- thank-you history
- vouches
- dispute indicators where appropriate

Profiles should prioritize community activity over traditional social-media vanity metrics.

---

# 32. Thank-Yous

Members should be able to publicly thank one another following exchanges.

Examples:

> “Alex lent us the camping equipment for the weekend. Absolute comrade.”

> “Thanks Maria for spending three hours helping with the move.”

Thank-yous:

- appear on profiles
- may appear in the community feed
- slightly influence reputation
- cannot be purchased

---

# 33. Search and Filtering

MVP search should support:

- keyword
- category
- listing type
- availability
- member
- minimum reputation eligibility

Future features may include:

- proximity
- map
- recommendations
- semantic search

---

# 34. Notifications

MVP notification events:

- membership approved
- membership rejected
- new borrow request
- request approved
- request rejected
- upcoming handoff
- upcoming return
- overdue return
- dispute opened
- dispute response
- thank-you received
- vouch request
- community vote opened
- vote ending soon

MVP requires in-app notifications and email for time-sensitive exchange, dispute, and vote events. PWA push notifications remain optional.

---

# 35. MVP Screens

## Authentication

- sign in
- create account
- email verification

## Community

- community home/feed
- membership approval
- community settings
- member directory

## Listings

- listing discovery
- listing details
- create listing
- edit listing

## Requests

- community requests
- request details
- create request

## Exchanges

- request item
- owner approval
- active exchanges
- handoff
- return
- completion

## Reputation

- member profile
- Solidarity Score
- reputation details

## Messaging

- inbox
- conversation

## Administration

- pending members
- member moderation
- disputes
- disciplinary votes
- audit history

## Billing

- membership subscription
- payment status

---

# 36. Recommended Technical Architecture

## Frontend

- React
- TypeScript
- Vite
- Progressive Web App
- Tailwind CSS

## Backend

- Supabase

Including:

- PostgreSQL
- Supabase Auth
- Supabase Storage
- Supabase Realtime
- Row Level Security
- Edge Functions where required

## Payments

Stripe

Initially used primarily for:

- $5/month membership subscription
- optional gratitude payments if included in initial release

---

# 37. Proposed Data Model

Primary tables:

```text
users / profiles

communities
community_members
community_invites
vouches

listings
listing_images
listing_availability

requests
request_responses

exchanges
exchange_handoff_photos
exchange_return_photos
exchange_events

messages
conversations
conversation_members

reputation_events
qualifying_interactions

thank_yous

disputes
dispute_evidence
dispute_responses

community_votes
community_vote_ballots

notifications

subscriptions

admin_actions
```

Borrow Requests and Need Posts must be distinguishable domain concepts even if they share storage.
This table list is illustrative. ADRs 0002–0008 define the records needed for transactions, reservations, help slots, evidence, and background work.

---

# 38. Key Entity Relationships

```text
User
 ├── belongs to Communities
 ├── creates Listings
 ├── creates Requests
 ├── participates in Exchanges
 ├── has Reputation
 ├── gives/receives Vouches
 └── gives/receives Thank-Yous

Community
 ├── has Members
 ├── has Listings
 ├── has Requests
 ├── has Admins
 ├── has Votes
 └── has Rules

Listing
 ├── belongs to User
 ├── belongs to Community
 └── generates Exchange Requests

Exchange
 ├── belongs to Community
 ├── has item Owner and Borrower or help Requester and Helper
 ├── references its source Listing or Need Post
 ├── has kind-specific details and event history
 └── may create Dispute
```

---

# 39. Security Requirements

All community content must respect community membership boundaries.

Supabase Row Level Security should enforce:

- users only see private communities they belong to
- users only access conversations they participate in
- users cannot edit another user's listings
- administrators receive only appropriate community-level permissions
- private messages cannot be globally queried by admins
- dispute evidence access is restricted
- reputation events cannot be arbitrarily created client-side
- billing state cannot be manipulated client-side

Sensitive operations should occur server-side.

---

# 40. Reputation Architecture Requirement

Community and Global Solidarity Scores should never be computed through frontend-only logic.

Use a server-controlled reputation event system.

Example:

```text
reputation_events

id
user_id
community_id
event_type
points
source_entity_type
source_entity_id
created_at
metadata
```

Examples:

```text
SUCCESSFUL_SHARE       +2
HELP_COMPLETED         +3
POSITIVE_REVIEW        +1
LATE_RETURN            -2
UNRESOLVED_DAMAGE      -10
THEFT_CONFIRMED        -30
```

MVP event rules:

| Event | Recipient | Points | Trigger |
| --- | --- | ---: | --- |
| Successful item share | Owner | +2 | Completed item exchange |
| Successful return | Borrower | +1 | Completed item exchange |
| Completed help | Helper | +3 | Completed help exchange |
| Positive thank-you | Recipient | +1 | At most one reputation-bearing thank-you per completed exchange |
| Late return | Borrower | -2 | Administrator verifies the late return |
| Unresolved damage | Responsible member | -10 | Administrator verifies unresolved damage |
| Confirmed theft | Responsible member | -30 | Administrator confirms theft |

Creating posts or listings, receiving help, and vouching have no automatic point effects in MVP. A reversed event is corrected by appending a compensating event with a reason and link to the original; verified history is preserved.

The exact weights should remain configurable.

Each Community Solidarity Score is computed from verified events in that community. The Global Solidarity Score is derived from community scores with interaction-count weighting. Both computations are server-controlled and explainable.

---

# 41. Auditability

Trust-related systems must remain explainable.

A user should be able to understand why their score changed.

Example:

```text
+2  Shared camping tent successfully
+3  Helped Jordan move
-2  Returned drill two days late
+1  Received thank-you from Hannah
```

Avoid opaque algorithmic scoring.

---

# 42. PWA Requirements

The application should:

- install to home screen
- work well on mobile
- support camera uploads
- provide responsive layout
- cache basic shell assets
- support push notifications when possible
- gracefully recover from interrupted uploads
- preserve draft posts where practical

Desktop must remain fully functional.

Mobile is the primary experience.

---

# 43. Explicit MVP Exclusions

Do not build these during initial MVP unless required by dependency:

- public community discovery
- full identity verification
- overnight lodging
- vehicle sharing
- childcare
- real-money security deposits
- escrow
- insurance
- automatic damage reimbursement
- algorithmic matching
- advanced recommendation engine
- native iOS application
- native Android application
- complex event-management system
- community treasury
- cryptocurrency
- tokenized reputation
- national marketplace
- cross-community item discovery

These features should not influence architecture enough to delay MVP.

---

# 44. MVP Functional Definition

MVP is complete when a group can:

1. create a private community
2. invite another user
3. approve that user
4. complete the platform membership subscription workflow in Stripe test mode
5. create an item listing
6. create a help offer
7. create an item Need Post
8. create a help Need Post
9. browse community activity
10. submit a Borrow Request for a listed item
11. approve a borrower
12. examine borrower community and global reputation
13. require minimum reputation
14. schedule a handoff
15. be prompted to upload optional handoff photos
16. acknowledge condition/replacement value
17. record return
18. be prompted to upload optional return photos
19. complete exchange
20. modify reputation based on outcome
21. publicly thank another member
22. vouch for another member
23. report a dispute
24. review dispute as administrator
25. participate in a disciplinary vote
26. suspend/remove a member
27. privately message another participant
28. view transparent community and global reputation history
29. commit to a help offer or Need Post and complete a help exchange with confirmation from both participants

Production payment collection is the first planned capability after MVP and is not an MVP completion gate.

---

# 45. MVP Acceptance Scenario

The canonical end-to-end test should be:

### Step 1

Alice creates:

**Richmond Mutual Aid Collective**

### Step 2

Alice sends Bob an invite. An eligible member may separately vouch for Bob.

### Step 3

Bob creates an account.

### Step 4

Alice approves Bob.

### Step 5

Bob may complete the $5 monthly membership subscription flow in Stripe test mode. His community access does not depend on test checkout.

### Step 6

Alice lists:

**Makita Cordless Drill**

Replacement value:

**$180**

Minimum Solidarity Score:

**45**

### Step 7

Bob requests the drill Friday through Sunday.

### Step 8

Alice views:

```text
Bob
Community Solidarity Score: 50 — Unproven
Global Solidarity Score: 50 — Unproven
0 completed exchanges
No unresolved disputes
```

### Step 9

Alice approves Bob.

### Step 10

At handoff, Alice photographs the drill.

Bob acknowledges its condition.

### Step 11

Bob returns the drill Sunday.

### Step 12

Alice uploads a return photo and confirms:

**Returned in good condition**

### Step 13

The exchange becomes:

**Completed**

### Step 14

Alice and Bob receive appropriate reputation events.

### Step 15

Bob publicly thanks Alice.

### Step 16

The community feed displays the successful exchange.

If this complete workflow functions cleanly on mobile, the primary MVP loop works.

---

# 46. UX Principle: Casual Until Something Goes Wrong

### **For UI Design**: please use Shadcn with the --preset b4iB4lDuK 

This should guide the entire implementation.

For normal users:

> The platform feels lightweight, friendly, and communal.

For disputes:

> The platform suddenly has excellent records.

Therefore:

- happy path = few screens
- evidence collection = easy
- disputes = structured
- reputation = transparent
- admin actions = recorded

Do not make normal exchanges feel like legal proceedings.

---

# 47. UX Principle: Contribution Over Consumption

The interface should subtly encourage members to contribute.

Instead of emphasizing:

> “What can I get?”

The application should regularly expose:

> “What can I share?”

> “Who needs help?”

> “What can I contribute?”

Examples:

Homepage modules might include:

**The Collective Needs Help**

**Things Available Today**

**Ways You Can Contribute**

**Recent Acts of Solidarity**

This should be achieved through product design rather than guilt or forced quotas.

---

# 48. UX Principle: Reputation Without Financializing Everything

The Solidarity Score should create accountability without becoming a tradable currency.

Users cannot:

- buy reputation
- purchase reputation boosts
- transfer score
- exchange score for goods
- directly spend score

It represents behavior, not wealth.

---

# 49. Initial Product Metrics

For the first test community, track:

### Activation

- invited users
- approved users
- paid users

### Supply

- item listings
- help offers

### Demand

- resource requests
- help requests

### Transactions

- requests submitted
- requests approved
- exchanges started
- exchanges completed

### Trust

- successful exchanges
- disputes
- unresolved disputes
- damaged items

### Community Health

- users who contributed
- users who only received
- repeat contributors
- repeat borrowers
- vouches
- thank-yous

---

# 50. Initial Validation Threshold

The product advances beyond MVP experimentation after achieving:

```text
1 community
20 members
5 completed transactions
```

After reaching that milestone, evaluate:

- Did members actually share valuable things?
- Did reputation affect trust decisions?
- Were owners comfortable lending?
- Did evidence capture feel excessive?
- Did people contribute without being forced?
- Did users return?
- Did disputes occur?
- Was Solidarity Score useful?
- Did community administrators provide enough governance?
- Did the ideological/community framing increase engagement?

Only after answering these questions should the platform expand materially.

---

# 51. Post-MVP Roadmap

## Phase 2

- shared spaces
- dedicated events
- push notifications improvements
- community-custom reputation titles
- richer scheduling
- recurring availability
- richer moderation tools

## Phase 3

- refundable collateral
- identity verification
- optional phone verification
- community discovery
- geographic discovery
- organization accounts

## Phase 4

- community treasuries
- community dues
- community revenue sharing
- advanced governance
- custom voting rules
- custom community constitutions

## Phase 5

- native mobile applications
- multi-community discovery
- federation between communities
- sophisticated reputation portability
- larger-scale mutual-aid networks

---

# 52. Codex Development Principle

Implementation should proceed vertically rather than by building every backend primitive before usable functionality exists.

Use the blockers in the [MVP execution plan](docs/MVP-EXECUTION-PLAN.md) for actual implementation order. The sequence below is illustrative.

The recommended sequence is:

```text
Auth
↓
Community creation/membership
↓
Listings + requests
↓
Borrow approval
↓
Exchange lifecycle
↓
Condition photos
↓
Solidarity Score
↓
Vouches + thank-yous
↓
Messaging
↓
Disputes
↓
Admin governance
↓
Billing in Stripe test mode
↓
Polish + PWA
```

Each phase should end with a functioning user-visible workflow and integration tests.

Avoid prematurely implementing post-MVP infrastructure.

---

# 53. Product North Star

The application succeeds if it creates behavior like:

> “I barely use this thing. Someone in the community could use it, so of course they can borrow it.”

and:

> “Someone nearby needs help. I have the skill and a free afternoon, so I'll help.”

while simultaneously giving users enough confidence to think:

> “If someone abuses that trust, there is a record, a reputation consequence, and a community that can respond.”

That combination of:

**generosity + reciprocity + trust + accountability**

is the core product.
