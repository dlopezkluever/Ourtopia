# Mutual Aid Community Platform
## Product Requirements Document

**Status:** MVP Definition  
**Platform:** Mobile-first Progressive Web App  
**Initial validation target:** 1 community, 20 active members, 5 completed exchanges  
**Working concept:** Private community mutual-aid and resource-sharing network

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

> “People in my community helping one another, with software handling the annoying coordination and trust problems.”

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

A user may eventually belong to multiple communities.

For MVP, communities are:

- private
- invite-based
- administrator-managed

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

1. an invitation or membership vouch code
2. an account
3. administrator approval

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

MVP pricing:

**$5 per member per month**

The fee provides access to the platform/community.

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

A member requests access to an item or resource.

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

Members may respond by offering an existing listing or creating a new offer.

---

## 7.4 Request Help

A user requests another person's time or assistance.

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

For MVP, the owner may select the allocation style.

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

---

# 15. Borrower Responsibility Agreement

Before approval becomes active, borrowers acknowledge:

- expected return date
- approximate replacement value
- condition expectations
- responsibility to communicate damage
- expectation that negligent damage should be repaired or otherwise resolved with the owner

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

---

# 18. Solidarity Score

The Solidarity Score is one of the central product systems.

Each user receives a:

**0–100 Solidarity Score**

A new member begins approximately in the middle as:

**50 — Unproven**

The precise starting value should remain configurable.

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

---

# 23. Reputation and Owner Discretion

Owners may:

- view another member's Solidarity Score
- inspect reputation details
- inspect completed exchange count
- inspect unresolved disputes
- inspect vouches
- require a minimum score
- decline a request because of insufficient trust history

Example:

> Minimum Solidarity Score: 65

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
Removal threshold: 66%
```

MVP may initially use fixed sensible defaults.

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

---

# 29. Private Messaging

Users may privately communicate regarding:

- borrowing
- handoff logistics
- help requests
- scheduling

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

Push notifications should be implemented through PWA capabilities when practical.

Email may act as fallback.

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

reputation_scores
reputation_events
reputation_components

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
 ├── has Owner
 ├── has Borrower
 ├── references Listing
 ├── contains Condition Evidence
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

The Solidarity Score should never be computed through frontend-only logic.

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

The exact weights should remain configurable.

The displayed score is computed from verified events.

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
4. collect platform membership payment
5. create an item listing
6. create a help offer
7. create an item request
8. create a help request
9. browse community activity
10. request a listed item
11. approve a borrower
12. examine borrower reputation
13. require minimum reputation
14. schedule a handoff
15. upload handoff photos
16. acknowledge condition/replacement value
17. record return
18. upload return photos
19. complete exchange
20. modify reputation based on outcome
21. publicly thank another member
22. vouch for another member
23. report a dispute
24. review dispute as administrator
25. participate in a disciplinary vote
26. suspend/remove a member
27. privately message another participant
28. view transparent reputation history

---

# 45. MVP Acceptance Scenario

The canonical end-to-end test should be:

### Step 1

Alice creates:

**Richmond Mutual Aid Collective**

### Step 2

Alice sends Bob a vouch/invite code.

### Step 3

Bob creates an account.

### Step 4

Alice approves Bob.

### Step 5

Bob pays the $5 monthly membership fee.

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
Solidarity: 58 — Comrade
12 interactions
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
Billing
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