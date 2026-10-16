-- Borrow Requests, Owner Chooses allocation, and item reservations (ADRs 0002, 0003, 0004, 0007, 0008).
create extension if not exists btree_gist with schema extensions;

create table public.allocation_settings (
  singleton boolean primary key default true check (singleton),
  acknowledgment_window interval not null default interval '48 hours' check (acknowledgment_window > interval '0')
);
insert into public.allocation_settings default values;

create table public.borrow_requests (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  listing_id uuid not null,
  owner_id uuid not null references auth.users(id),
  borrower_id uuid not null references auth.users(id),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'expired')),
  version integer not null default 1,
  exchange_id uuid unique references public.exchanges(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  foreign key (listing_id, community_id) references public.listings(id, community_id),
  check (owner_id <> borrower_id),
  check (starts_on <= ends_on and starts_on >= date '2000-01-01' and ends_on <= date '2100-12-31'),
  check ((status in ('approved', 'expired')) = (exchange_id is not null)),
  check ((status = 'requested') = (decided_at is null))
);
create index borrow_requests_listing on public.borrow_requests(listing_id, created_at);
create index borrow_requests_owner on public.borrow_requests(owner_id, created_at);
create index borrow_requests_borrower on public.borrow_requests(borrower_id, created_at);

-- Calendar dates are inclusive in the UI and stored half-open through the day after the last date.
create table public.item_reservations (
  exchange_id uuid primary key references public.exchanges(id),
  request_id uuid not null unique references public.borrow_requests(id),
  listing_id uuid not null references public.listings(id),
  starts_on date not null,
  ends_on date not null,
  dates daterange generated always as (daterange(starts_on, ends_on + 1, '[)')) stored,
  acknowledgment_due_at timestamptz not null,
  acknowledged_at timestamptz,
  custody_unresolved boolean not null default false,
  blocking boolean not null default true,
  condition text not null,
  replacement_value numeric(12,2) not null,
  lending_conditions text not null,
  created_at timestamptz not null default now(),
  check (starts_on <= ends_on),
  constraint item_reservation_no_overlap exclude using gist (listing_id with =, dates with &&) where (blocking)
);
create index item_reservation_due on public.item_reservations(acknowledgment_due_at) where acknowledged_at is null and blocking;
create index item_reservation_custody on public.item_reservations(listing_id) where custody_unresolved;

alter table public.allocation_settings enable row level security;
alter table public.borrow_requests enable row level security;
alter table public.item_reservations enable row level security;
revoke all on public.allocation_settings, public.borrow_requests, public.item_reservations from anon, authenticated;
grant select on public.borrow_requests, public.item_reservations to authenticated;
create policy borrow_request_read on public.borrow_requests for select to authenticated using (
  auth.uid() in (owner_id, borrower_id)
  and (public.is_active_member(community_id) or (exchange_id is not null and public.can_read_exchange(exchange_id))));
create policy reservation_read on public.item_reservations for select to authenticated using (public.can_read_exchange(exchange_id));

-- Borrow Request audit is participant business; ordinary members and administrators do not read it.
drop policy event_read on public.community_events;
create policy event_read on public.community_events for select to authenticated
  using (public.is_active_member(community_id) and kind not in ('conversation_started', 'message_sent',
    'help_commitment_offered', 'help_commitment_accepted', 'help_scheduled', 'help_cancelled',
    'borrow_requested', 'borrow_approved', 'borrow_rejected', 'borrow_expired'));
create trigger borrow_audit_append_only before update or delete on public.community_events
  for each row when (old.kind like 'borrow\_%') execute function private.reject_history_rewrite();

create function private.guard_borrow_request() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (new.id, new.community_id, new.listing_id, new.owner_id, new.borrower_id, new.starts_on, new.ends_on, new.created_at)
    is distinct from (old.id, old.community_id, old.listing_id, old.owner_id, old.borrower_id, old.starts_on, old.ends_on, old.created_at)
    or (old.exchange_id is not null and new.exchange_id is distinct from old.exchange_id) then
    raise exception using errcode = '42501', message = 'Borrow Request identity, dates, and Exchange are immutable.';
  end if;
  if new.status <> old.status and not ((old.status = 'requested' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved' and new.status = 'expired')) then
    raise exception using errcode = '55000', message = 'This Borrow Request decision has already been made.';
  end if;
  return new;
end;
$$;
create trigger borrow_request_integrity before update or delete on public.borrow_requests
  for each row execute function private.guard_borrow_request();

create function private.guard_item_reservation() returns trigger language plpgsql set search_path = '' as $$
declare exchange public.exchanges; request public.borrow_requests;
begin
  if tg_op = 'DELETE' then raise exception using errcode = '42501', message = 'Reservation history is retained.'; end if;
  if tg_op = 'UPDATE' and ((new.exchange_id, new.request_id, new.listing_id, new.starts_on, new.ends_on, new.acknowledgment_due_at,
      new.condition, new.replacement_value, new.lending_conditions, new.created_at)
    is distinct from (old.exchange_id, old.request_id, old.listing_id, old.starts_on, old.ends_on, old.acknowledgment_due_at,
      old.condition, old.replacement_value, old.lending_conditions, old.created_at)
    or (old.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at)) then
    raise exception using errcode = '42501', message = 'Reservation dates, deadline, acknowledgment, and terms change only through allocation.';
  end if;
  select * into exchange from public.exchanges where id = new.exchange_id;
  select * into request from public.borrow_requests where id = new.request_id;
  if exchange.kind is distinct from 'item' or exchange.source_kind is distinct from 'listing' or exchange.source_id is distinct from new.listing_id
    or request.exchange_id is distinct from exchange.id or request.listing_id is distinct from new.listing_id
    or request.community_id is distinct from exchange.community_id or request.owner_id is distinct from exchange.provider_id
    or request.borrower_id is distinct from exchange.receiver_id or (request.starts_on, request.ends_on) is distinct from (new.starts_on, new.ends_on)
    or (tg_op = 'INSERT' and (exchange.state <> 'approved' or new.acknowledged_at is not null)) then
    raise exception using errcode = '23514', message = 'A reservation must match its approved item Exchange and Borrow Request.';
  end if;
  if new.acknowledged_at is not null and (tg_op = 'INSERT' or old.acknowledged_at is null)
    and (exchange.state <> 'approved' or clock_timestamp() >= new.acknowledgment_due_at) then
    raise exception using errcode = '55000', message = 'The 48-hour acknowledgment deadline has passed.';
  end if;
  if not new.custody_unresolved and exchange.state in ('checked_out', 'return_pending') then
    raise exception using errcode = '55000', message = 'The borrower still holds this item.';
  end if;
  new.blocking := exchange.state in ('approved', 'handoff_pending', 'checked_out', 'return_pending') or new.custody_unresolved;
  return new;
end;
$$;
create trigger item_reservation_integrity before insert or update or delete on public.item_reservations
  for each row execute function private.guard_item_reservation();

create function private.guard_item_exchange_transition() returns trigger language plpgsql set search_path = '' as $$
declare reservation public.item_reservations;
begin
  select * into reservation from public.item_reservations where exchange_id = new.id;
  if not found or new.state = old.state then return new; end if;
  if old.state = 'expired' or (old.state = 'approved' and new.state not in ('handoff_pending', 'cancelled', 'expired')) then
    raise exception using errcode = '55000', message = 'This item approval can no longer move to that state.';
  end if;
  if old.state = 'approved' and new.state = 'handoff_pending' and reservation.acknowledged_at is null then
    raise exception using errcode = '55000', message = 'The borrower must acknowledge the terms before the 48-hour deadline.';
  end if;
  if new.state = 'expired' and (old.state <> 'approved' or reservation.acknowledged_at is not null or clock_timestamp() < reservation.acknowledgment_due_at) then
    raise exception using errcode = '55000', message = 'Only an unacknowledged approval past its deadline can expire.';
  end if;
  return new;
end;
$$;
create trigger item_exchange_transition before update of state on public.exchanges
  for each row when (old.kind = 'item') execute function private.guard_item_exchange_transition();

-- Exchange state drives the stored blocking status; custody stays unresolved once the item leaves the owner.
create function private.sync_item_reservation() returns trigger language plpgsql set search_path = '' as $$
begin
  update public.item_reservations set custody_unresolved = custody_unresolved or new.state in ('checked_out', 'return_pending')
    where exchange_id = new.id;
  return new;
end;
$$;
create trigger item_reservation_state after update of state on public.exchanges
  for each row when (old.kind = 'item') execute function private.sync_item_reservation();

revoke all on function private.guard_borrow_request(), private.guard_item_reservation(), private.guard_item_exchange_transition(),
  private.sync_item_reservation() from public, anon, authenticated;

create function private.borrow_intent(p_actor uuid, p_intent uuid, p_command text, p_payload jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare prior public.command_intents;
begin
  if p_intent is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || p_intent::text, 0));
  select * into prior from public.command_intents where actor_id = p_actor and intent_id = p_intent;
  if found then
    if prior.command <> p_command or prior.payload <> p_payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    return prior.result;
  end if;
  return null;
end;
$$;

create function private.borrow_view(p_request_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(b) || jsonb_build_object(
    'exchange_state', e.state,
    'reservation', case when r.exchange_id is null then null else jsonb_build_object(
      'exchange_id', r.exchange_id, 'starts_on', r.starts_on, 'ends_on', r.ends_on, 'dates', r.dates::text,
      'acknowledgment_due_at', r.acknowledgment_due_at, 'acknowledged_at', r.acknowledged_at, 'blocking', r.blocking,
      'custody_unresolved', r.custody_unresolved) end)
  from public.borrow_requests b
  left join public.exchanges e on e.id = b.exchange_id
  left join public.item_reservations r on r.exchange_id = b.exchange_id
  where b.id = p_request_id;
$$;

create function private.record_borrow_activity(p_community uuid, p_actor uuid, p_intent uuid, p_kind text, p_recipients uuid[])
returns void language plpgsql set search_path = '' as $$
declare audit_event uuid;
begin
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community, p_actor, p_kind, p_intent) returning id into audit_event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select audit_event, p_community, recipient, channel, p_kind from unnest(p_recipients) recipient cross join unnest(array['in_app', 'email']) channel
    on conflict (event_id, recipient_id, channel, kind) do nothing;
  insert into public.notification_hints(recipient_id) select distinct recipient from unnest(p_recipients) recipient;
end;
$$;

-- The allocation policy boundary. Owner Chooses is the only executable MVP policy; it approves exactly one candidate.
create function private.allocate_item(p_listing public.listings, p_candidates uuid[], p_decision_actor uuid)
returns uuid language plpgsql set search_path = '' as $$
declare request public.borrow_requests;
begin
  if p_decision_actor is distinct from p_listing.owner_id then
    raise exception using errcode = '42501', message = 'Only the Listing owner chooses a borrower.';
  end if;
  if cardinality(p_candidates) is distinct from 1 then
    raise exception using errcode = '22023', message = 'Owner Chooses approves exactly one Borrow Request.';
  end if;
  select * into request from public.borrow_requests where id = p_candidates[1] and listing_id = p_listing.id;
  if not found or request.status <> 'requested' then
    raise exception using errcode = '55000', message = 'This Borrow Request is no longer awaiting a decision.';
  end if;
  perform 1 from public.memberships where community_id = p_listing.community_id and user_id = request.borrower_id and status = 'active' for share;
  if not found then raise exception using errcode = '55000', message = 'The borrower is no longer an active member of this Community.'; end if;
  if p_listing.status <> 'published' or not exists (select 1 from public.listing_availability a
    where a.listing_id = p_listing.id and a.dates @> daterange(request.starts_on, request.ends_on + 1, '[)')) then
    raise exception using errcode = '55000', message = 'The Listing or its requested dates are no longer available.';
  end if;
  if request.starts_on < current_date then raise exception using errcode = '55000', message = 'The requested dates have already started.'; end if;
  if private.community_score(request.borrower_id, request.community_id) < p_listing.minimum_score then
    raise exception using errcode = '23514', message = 'The borrower is below this Listing''s minimum Community Solidarity Score.';
  end if;
  if exists (select 1 from public.item_reservations r join public.exchanges e on e.id = r.exchange_id
    where r.listing_id = p_listing.id and (r.custody_unresolved or e.state in ('checked_out', 'return_pending'))) then
    raise exception using errcode = '23P01', message = 'Item custody is unresolved. The owner must recover the item before another approval.';
  end if;
  if exists (select 1 from public.item_reservations r where r.listing_id = p_listing.id and r.blocking
    and r.dates && daterange(request.starts_on, request.ends_on + 1, '[)')) then
    raise exception using errcode = '23P01', message = 'These dates overlap a reservation that is already approved.';
  end if;
  return request.id;
end;
$$;

revoke all on function private.borrow_intent(uuid, uuid, text, jsonb), private.borrow_view(uuid),
  private.record_borrow_activity(uuid, uuid, uuid, text, uuid[]), private.allocate_item(public.listings, uuid[], uuid) from public, anon, authenticated;

create function public.submit_borrow_request(p_intent_id uuid, p_listing_id uuid, p_starts_on date, p_ends_on date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('listing', p_listing_id, 'starts_on', p_starts_on, 'ends_on', p_ends_on);
  listing public.listings;
  request public.borrow_requests;
  outcome jsonb;
begin
  select * into listing from public.listings where id = p_listing_id for share;
  if not found or actor is null then raise exception using errcode = '42501', message = 'Listing unavailable.'; end if;
  perform public.require_current_membership(listing.community_id);
  if actor = listing.owner_id then raise exception using errcode = '42501', message = 'Owners cannot borrow their own item.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'submit_borrow_request', payload);
  if outcome is not null then return outcome; end if;
  if p_starts_on is null or p_ends_on is null or p_starts_on > p_ends_on then
    raise exception using errcode = '22023', message = 'Choose a first and last borrowing day, with the last on or after the first.';
  end if;
  if p_starts_on < current_date then raise exception using errcode = '22023', message = 'Choose dates that have not started yet.'; end if;
  if listing.status <> 'published' or not exists (select 1 from public.listing_availability a
    where a.listing_id = listing.id and a.dates @> daterange(p_starts_on, p_ends_on + 1, '[)')) then
    raise exception using errcode = '55000', message = 'Choose dates inside one of this Listing''s availability ranges.';
  end if;
  insert into public.borrow_requests(community_id, listing_id, owner_id, borrower_id, starts_on, ends_on)
    values(listing.community_id, listing.id, listing.owner_id, actor, p_starts_on, p_ends_on) returning * into request;
  perform private.record_borrow_activity(listing.community_id, actor, p_intent_id, 'borrow_requested', array[listing.owner_id]);
  outcome := private.borrow_view(request.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'submit_borrow_request', payload, outcome);
  return outcome;
end;
$$;

create function public.decide_borrow_request(p_intent_id uuid, p_request_id uuid, p_expected_version integer, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('request', p_request_id, 'version', p_expected_version, 'decision', p_decision);
  listing public.listings;
  request public.borrow_requests;
  exchange public.exchanges;
  window_length interval;
  outcome jsonb;
begin
  select * into request from public.borrow_requests where id = p_request_id;
  if not found or actor is null or actor <> request.owner_id then
    raise exception using errcode = '42501', message = 'Only the Listing owner can decide this Borrow Request.';
  end if;
  perform public.require_current_membership(request.community_id);
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'Choose approve or decline.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'decide_borrow_request', payload);
  if outcome is not null then return outcome; end if;
  select * into listing from public.listings where id = request.listing_id for update;
  select * into request from public.borrow_requests where id = p_request_id for update;
  if request.status <> 'requested' or p_expected_version is distinct from request.version then
    raise exception using errcode = '55000', message = 'This Borrow Request changed. Refresh before deciding.';
  end if;
  if p_decision = 'rejected' then
    update public.borrow_requests set status = 'rejected', version = version + 1, decided_at = clock_timestamp() where id = request.id;
    perform private.record_borrow_activity(request.community_id, actor, p_intent_id, 'borrow_rejected', array[request.borrower_id]);
  else
    perform private.allocate_item(listing, array[request.id], actor);
    select acknowledgment_window into window_length from public.allocation_settings;
    insert into public.exchanges(community_id, kind, provider_id, receiver_id, source_kind, source_id, state)
      values(listing.community_id, 'item', actor, request.borrower_id, 'listing', listing.id, 'approved') returning * into exchange;
    update public.borrow_requests set status = 'approved', version = version + 1, exchange_id = exchange.id, decided_at = clock_timestamp() where id = request.id;
    begin
      insert into public.item_reservations(exchange_id, request_id, listing_id, starts_on, ends_on, acknowledgment_due_at, condition, replacement_value, lending_conditions)
        values(exchange.id, request.id, listing.id, request.starts_on, request.ends_on, clock_timestamp() + window_length,
          listing.condition, listing.replacement_value, listing.lending_conditions);
    exception when exclusion_violation then
      raise exception using errcode = '23P01', message = 'These dates overlap a reservation that is already approved.';
    end;
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(exchange.id, exchange.community_id, 'item_approved', actor);
    perform private.record_borrow_activity(request.community_id, actor, p_intent_id, 'borrow_approved', array[request.borrower_id]);
  end if;
  outcome := private.borrow_view(request.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'decide_borrow_request', payload, outcome);
  return outcome;
end;
$$;

revoke all on function public.submit_borrow_request(uuid, uuid, date, date), public.decide_borrow_request(uuid, uuid, integer, text) from public, anon;
grant execute on function public.submit_borrow_request(uuid, uuid, date, date), public.decide_borrow_request(uuid, uuid, integer, text) to authenticated;

-- Server deadline command. The audit event names the Listing owner and uses the Exchange as its stable identity.
create function public.expire_item_approval(p_exchange_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare exchange public.exchanges; reservation public.item_reservations; request_id uuid;
begin
  select * into exchange from public.exchanges where id = p_exchange_id and kind = 'item' for update;
  if not found then raise exception using errcode = '22023', message = 'Item Exchange unavailable.'; end if;
  select * into reservation from public.item_reservations where exchange_id = exchange.id for update;
  if not found then raise exception using errcode = '22023', message = 'Reservation unavailable.'; end if;
  if exchange.state = 'approved' and reservation.acknowledged_at is null and clock_timestamp() >= reservation.acknowledgment_due_at then
    update public.exchanges set state = 'expired' where id = exchange.id;
    update public.borrow_requests set status = 'expired', version = version + 1 where exchange_id = exchange.id;
    insert into public.exchange_events(exchange_id, community_id, kind) values(exchange.id, exchange.community_id, 'item_approval_expired');
    perform private.record_borrow_activity(exchange.community_id, exchange.provider_id, exchange.id, 'borrow_expired', array[exchange.provider_id, exchange.receiver_id]);
  end if;
  select id into request_id from public.borrow_requests where exchange_id = exchange.id;
  return private.borrow_view(request_id);
end;
$$;

create function public.expire_due_item_approvals()
returns integer language plpgsql security definer set search_path = '' as $$
declare due record; expired integer := 0;
begin
  for due in select r.exchange_id from public.item_reservations r join public.exchanges e on e.id = r.exchange_id
    where e.state = 'approved' and r.acknowledged_at is null and r.acknowledgment_due_at <= clock_timestamp()
    order by r.acknowledgment_due_at limit 100
  loop
    if public.expire_item_approval(due.exchange_id)->>'status' = 'expired' then expired := expired + 1; end if;
  end loop;
  return expired;
end;
$$;
revoke all on function public.expire_item_approval(uuid), public.expire_due_item_approvals() from public, anon, authenticated;
grant execute on function public.expire_item_approval(uuid), public.expire_due_item_approvals() to service_role;
select cron.schedule('ourtopia-item-approval-expiry', '* * * * *', 'select public.expire_due_item_approvals()');

notify pgrst, 'reload schema';
