-- Item Return, server Finalize, completion effects, safe feed entry, Return reminders and stalled review (issue 9).

create table public.item_return_settings (
  singleton boolean primary key default true check (singleton),
  confirmation_reminder_after interval not null default interval '24 hours' check (confirmation_reminder_after > interval '0'),
  review_after interval not null default interval '7 days' check (review_after > interval '0')
);
insert into public.item_return_settings default values;
alter table public.item_return_settings enable row level security;
revoke all on public.item_return_settings from anon, authenticated;

-- Reservation dates are inclusive calendar days (ADR 0004); the Return is due when the last day ends in UTC.
create function private.item_return_due(p_ends_on date) returns timestamptz language sql immutable set search_path = '' as $$
  select (p_ends_on + 1)::timestamp at time zone 'UTC';
$$;

create table public.item_returns (
  exchange_id uuid primary key references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  revision integer not null default 1,
  returned_at timestamptz not null,
  condition text not null check (length(condition) between 1 and 2000),
  accessories text not null check (length(accessories) <= 2000),
  recorded_by uuid not null references auth.users(id),
  owner_confirmed_at timestamptz,
  borrower_confirmed_at timestamptz,
  contested_by uuid references auth.users(id),
  contested_at timestamptz,
  contested_condition text check (length(contested_condition) between 1 and 2000),
  confirmation_reminder_due_at timestamptz not null,
  review_due_at timestamptz not null,
  check ((contested_by is null) = (contested_at is null) and (contested_at is null) = (contested_condition is null)),
  check (contested_at is null or owner_confirmed_at is null or borrower_confirmed_at is null)
);
create index item_returns_review_due on public.item_returns(review_due_at) where contested_at is null;
create function private.guard_item_return_record() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception using errcode = '42501', message = 'Return history is retained.'; end if;
  if not exists(select 1 from public.exchanges e where e.id = new.exchange_id and e.kind = 'item' and e.community_id = new.community_id
    and new.recorded_by in (e.provider_id, e.receiver_id) and (new.contested_by is null or new.contested_by in (e.provider_id, e.receiver_id))) then
    raise exception using errcode = '23514', message = 'Return records must match their item Exchange participants and Community.';
  end if;
  if tg_op = 'UPDATE' then
    if (new.exchange_id, new.community_id) is distinct from (old.exchange_id, old.community_id) then
      raise exception using errcode = '42501', message = 'Return identity is immutable.';
    end if;
    if ((old.owner_confirmed_at is not null and old.borrower_confirmed_at is not null) or old.contested_at is not null) and new is distinct from old then
      raise exception using errcode = '42501', message = 'A confirmed or contested Return cannot be rewritten.';
    end if;
  end if;
  return new;
end;
$$;
create trigger item_return_integrity before insert or update or delete on public.item_returns
  for each row execute function private.guard_item_return_record();
alter table public.item_returns enable row level security;
revoke all on public.item_returns from anon, authenticated;
grant select on public.item_returns to authenticated;
create policy item_return_read on public.item_returns for select to authenticated using (public.can_read_exchange(exchange_id));
create unique index item_returned_once on public.exchange_events(exchange_id) where kind = 'item_returned';
create unique index item_completed_once on public.exchange_events(exchange_id) where kind = 'item_completed';

-- Administrator review queue. Items carry no condition, evidence or logistics; disposition belongs to issue 19.
create table public.exchange_review_items (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  reason text not null check (reason in ('missing_return_confirmation', 'overdue_return')),
  queued_at timestamptz not null default now(),
  unique (exchange_id, reason)
);
create trigger exchange_review_items_append_only before update or delete on public.exchange_review_items
  for each row execute function private.reject_history_rewrite();
alter table public.exchange_review_items enable row level security;
revoke all on public.exchange_review_items from anon, authenticated;
grant select on public.exchange_review_items to authenticated;
create policy review_item_read on public.exchange_review_items for select to authenticated
  using (public.is_community_administrator(community_id) or public.can_read_exchange(exchange_id));

-- Safe Community feed. Only identity, the shared Listing and completion time; never notes, schedules or evidence.
create table public.community_feed (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  kind text not null check (kind = 'item_loan_completed'),
  exchange_id uuid not null unique references public.exchanges(id),
  listing_id uuid not null references public.listings(id),
  owner_id uuid not null references auth.users(id),
  borrower_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index community_feed_recent on public.community_feed(community_id, created_at desc);
create trigger community_feed_append_only before update or delete on public.community_feed
  for each row execute function private.reject_history_rewrite();
alter table public.community_feed enable row level security;
revoke all on public.community_feed from anon, authenticated;
grant select on public.community_feed to authenticated;
create policy community_feed_read on public.community_feed for select to authenticated using (public.is_active_member(community_id));

-- Only a confirmed physical Return clears custody. Disputed, missing and closed-without-completion Returns keep it.
create or replace function private.item_custody_until_verified_return(p_before text, p_after text, p_unresolved boolean)
returns boolean language sql immutable set search_path = '' as $$
  select case when p_before in ('approved', 'handoff_pending') and p_after in ('cancelled', 'expired', 'closed_without_completion') then false
    when p_before = 'return_pending' and p_after = 'returned' then false
    else p_unresolved or p_after in ('checked_out', 'return_pending') end;
$$;

create function private.guard_item_return_transition() returns trigger language plpgsql set search_path = '' as $$
declare r public.item_returns;
begin
  if new.state = old.state or new.state not in ('returned', 'completed') then return new; end if;
  select * into r from public.item_returns where exchange_id = new.id;
  if found and (r.owner_confirmed_at is null or r.borrower_confirmed_at is null or r.contested_at is not null) then
    raise exception using errcode = '55000', message = 'Both participants must confirm a matching Return condition.';
  end if;
  return new;
end;
$$;
create trigger item_return_transition before update of state on public.exchanges
  for each row when (old.kind = 'item') execute function private.guard_item_return_transition();

-- Return photos reuse the private evidence bucket, lifecycle and participant-only reads.
alter table public.exchange_evidence drop constraint exchange_evidence_purpose_check;
alter table public.exchange_evidence add constraint exchange_evidence_purpose_check
  check ((purpose in ('handoff', 'return') and dispute_id is null) or (purpose = 'dispute' and dispute_id is not null));
create or replace function public.can_access_exchange_evidence(p_path text, p_upload boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.exchange_evidence v join public.exchanges e on e.id = v.exchange_id
    left join public.disputes d on d.id = v.dispute_id where v.object_path = p_path
    and case when p_upload then v.uploader_id = auth.uid() and v.state = 'pending' and public.can_read_exchange(e.id)
      and case when v.dispute_id is not null then d.closed_at is null
        when v.purpose = 'return' then e.state in ('checked_out', 'return_pending')
        else e.state in ('handoff_pending', 'checked_out') end
    else (case when v.dispute_id is null then public.can_read_exchange(e.id) else public.can_read_dispute(d.id) end)
      and (v.state = 'ready' or v.uploader_id = auth.uid()) end);
$$;
create or replace function private.handoff_view(p_exchange uuid) returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(h) || jsonb_build_object('state', e.state, 'community_id', e.community_id,
    'owner_id', e.provider_id, 'borrower_id', e.receiver_id, 'reservation', to_jsonb(r),
    'evidence', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at) from public.exchange_evidence v
      where v.exchange_id = e.id and v.purpose <> 'return' and (v.state = 'ready' or v.uploader_id = auth.uid())), '[]'::jsonb))
  from public.item_handoffs h join public.exchanges e on e.id = h.exchange_id
    join public.item_reservations r on r.exchange_id = e.id where e.id = p_exchange;
$$;

-- Return reminders use the issue-23 reminder identity keyed by the Exchange.
create function private.invalidate_return_reminders(p_exchange uuid, p_kinds text[]) returns void language sql security definer set search_path = '' as $$
  update public.notification_reminders set due_at = 'infinity'
    where source_key = p_exchange and kind = any(p_kinds) and due_at <> 'infinity';
$$;
create function private.sync_return_reminders() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.state <> 'checked_out' then perform private.invalidate_return_reminders(new.id, array['item_return_upcoming', 'item_return_overdue']); end if;
  if new.state <> 'return_pending' then perform private.invalidate_return_reminders(new.id, array['item_return_confirmation_due']); end if;
  return new;
end;
$$;
create trigger item_return_reminder_state after update of state on public.exchanges
  for each row when (old.kind = 'item') execute function private.sync_return_reminders();
create function private.schedule_return_reminders() returns trigger language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; due timestamptz; event uuid;
begin
  select * into e from public.exchanges where id = new.exchange_id;
  select private.item_return_due(ends_on) into due from public.item_reservations where exchange_id = e.id;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(e.community_id, coalesce(new.actor_id, e.receiver_id), 'item_return_scheduled', e.id)
    returning id into event;
  if due - interval '24 hours' > clock_timestamp() then
    perform public.schedule_notification_reminder(e.community_id, e.id, event, e.receiver_id, channel, 'item_return_upcoming', due - interval '24 hours')
      from unnest(array['in_app', 'email']) channel;
  end if;
  perform public.schedule_notification_reminder(e.community_id, e.id, event, recipient, channel, 'item_return_overdue', greatest(clock_timestamp(), due))
    from unnest(array[e.receiver_id, e.provider_id]) recipient cross join unnest(array['in_app', 'email']) channel;
  return new;
end;
$$;
create trigger item_return_reminders after insert on public.exchange_events
  for each row when (new.kind = 'item_handed_off') execute function private.schedule_return_reminders();

create function private.return_view(p_exchange uuid) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('exchange_id', e.id, 'community_id', e.community_id, 'state', e.state,
    'owner_id', e.provider_id, 'borrower_id', e.receiver_id, 'completed_at', e.completed_at,
    'return_due_at', private.item_return_due(res.ends_on), 'revision', coalesce(r.revision, 0),
    'record', case when r.exchange_id is null then null else jsonb_build_object('returned_at', r.returned_at, 'condition', r.condition,
      'accessories', r.accessories, 'recorded_by', r.recorded_by, 'owner_confirmed_at', r.owner_confirmed_at,
      'borrower_confirmed_at', r.borrower_confirmed_at, 'contested_by', r.contested_by, 'contested_at', r.contested_at,
      'contested_condition', r.contested_condition, 'review_due_at', r.review_due_at) end,
    'handoff', jsonb_build_object('handed_off_at', h.handed_off_at, 'condition', h.condition, 'accessories', h.accessories),
    'evidence', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at, v.id) from public.exchange_evidence v
      where v.exchange_id = e.id and v.dispute_id is null and (v.state = 'ready' or v.uploader_id = auth.uid())), '[]'::jsonb),
    'open_dispute', exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null),
    'review', coalesce((select jsonb_agg(jsonb_build_object('reason', q.reason, 'queued_at', q.queued_at) order by q.queued_at)
      from public.exchange_review_items q where q.exchange_id = e.id), '[]'::jsonb),
    'standing', private.community_standing(auth.uid(), e.community_id))
  from public.exchanges e join public.item_reservations res on res.exchange_id = e.id
    join public.item_handoffs h on h.exchange_id = e.id left join public.item_returns r on r.exchange_id = e.id
  where e.id = p_exchange;
$$;
create function public.read_item_return(p_exchange_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_read_exchange(p_exchange_id) or not exists(select 1 from public.item_reservations where exchange_id = p_exchange_id) then
    raise exception using errcode = '42501', message = 'Return unavailable.';
  end if;
  return private.return_view(p_exchange_id);
end;
$$;

-- Server Finalize. Completion effects happen once: state, settlement, audit, notices and the feed entry share one transaction.
create function private.finalize_item_exchange(p_exchange uuid, p_actor uuid, p_intent uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; r public.item_returns; h public.item_handoffs; event uuid;
begin
  select * into e from public.exchanges where id = p_exchange and kind = 'item' for update;
  select * into r from public.item_returns where exchange_id = e.id;
  select * into h from public.item_handoffs where exchange_id = e.id;
  if e.state is distinct from 'returned' or h.handed_off_at is null or r.exchange_id is null or r.owner_confirmed_at is null
    or r.borrower_confirmed_at is null or r.contested_at is not null
    or exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null) then
    return false;
  end if;
  update public.exchanges set state = 'completed' where id = e.id;
  perform private.settle_exchange_completion(e.id);
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_completed', null);
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(e.community_id, p_actor, 'item_completed', p_intent) returning id into event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, e.community_id, recipient, channel, 'item_completed'
    from unnest(array[e.provider_id, e.receiver_id]) recipient cross join unnest(array['in_app', 'email']) channel;
  insert into public.community_feed(community_id, kind, exchange_id, listing_id, owner_id, borrower_id)
    values(e.community_id, 'item_loan_completed', e.id, e.source_id, e.provider_id, e.receiver_id) on conflict (exchange_id) do nothing;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  return true;
end;
$$;

create function public.command_item_return(p_intent_id uuid, p_exchange_id uuid, p_expected_revision integer, p_action text, p_details jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); e public.exchanges; r public.item_returns; settings public.item_return_settings;
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'revision', p_expected_revision, 'action', p_action, 'details', p_details);
  outcome jsonb; event uuid; event_kind text; counterpart uuid; condition_text text; issue text; counterpart_confirmed timestamptz;
begin
  if not public.can_read_exchange(p_exchange_id) then raise exception using errcode = '42501', message = 'Return unavailable.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'command_item_return', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id and kind = 'item' for update;
  perform 1 from public.item_reservations where exchange_id = e.id for update;
  if not found then raise exception using errcode = '42501', message = 'Return unavailable.'; end if;
  select * into r from public.item_returns where exchange_id = e.id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor and status in ('active', 'suspended', 'removed') for share;
  if not found or not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Return unavailable.'; end if;
  if e.state not in ('checked_out', 'return_pending') or coalesce(r.revision, 0) is distinct from p_expected_revision then
    raise exception using errcode = '55000', message = 'This Return changed. Refresh before continuing.';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then raise exception using errcode = '22023', message = 'Return details are required.'; end if;
  counterpart := case when actor = e.provider_id then e.receiver_id else e.provider_id end;
  counterpart_confirmed := case when counterpart = e.provider_id then r.owner_confirmed_at else r.borrower_confirmed_at end;
  select * into settings from public.item_return_settings;
  if p_action = 'record_return' then
    condition_text := btrim(p_details->>'condition');
    if nullif(condition_text, '') is null or length(condition_text) > 2000 or p_details->>'accessories' is null or length(p_details->>'accessories') > 2000 then
      raise exception using errcode = '22023', message = 'Record the Return condition and accessories, or say none.';
    end if;
    if e.state = 'return_pending' and (r.recorded_by <> actor or r.contested_at is not null or counterpart_confirmed is not null) then
      raise exception using errcode = '55000', message = 'The other participant already has this Return to confirm or contest.';
    end if;
    insert into public.item_returns(exchange_id, community_id, returned_at, condition, accessories, recorded_by, owner_confirmed_at, borrower_confirmed_at,
      confirmation_reminder_due_at, review_due_at)
      values(e.id, e.community_id, clock_timestamp(), condition_text, p_details->>'accessories', actor,
        case when actor = e.provider_id then clock_timestamp() end, case when actor = e.receiver_id then clock_timestamp() end,
        clock_timestamp() + settings.confirmation_reminder_after, clock_timestamp() + settings.review_after)
      on conflict (exchange_id) do update set revision = item_returns.revision + 1, returned_at = excluded.returned_at, condition = excluded.condition,
        accessories = excluded.accessories, owner_confirmed_at = excluded.owner_confirmed_at, borrower_confirmed_at = excluded.borrower_confirmed_at,
        confirmation_reminder_due_at = excluded.confirmation_reminder_due_at, review_due_at = excluded.review_due_at
      returning * into r;
    event_kind := case when e.state = 'checked_out' then 'item_return_recorded' else 'item_return_revised' end;
    if e.state = 'checked_out' then update public.exchanges set state = 'return_pending' where id = e.id; end if;
  elsif p_action in ('confirm_return', 'contest_return') then
    if e.state <> 'return_pending' or r.recorded_by = actor or r.contested_at is not null or counterpart_confirmed is null then
      raise exception using errcode = '55000', message = 'The other participant must confirm or contest the recorded Return.';
    end if;
    if p_action = 'confirm_return' then
      if p_details <> '{"condition_matches":true}'::jsonb then
        raise exception using errcode = '22023', message = 'Confirm that the recorded Return condition and accessories match.';
      end if;
      if exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null) then
        raise exception using errcode = '55000', message = 'An open Exchange issue blocks ordinary Return confirmation.';
      end if;
      update public.item_returns set revision = revision + 1,
        owner_confirmed_at = coalesce(owner_confirmed_at, case when actor = e.provider_id then clock_timestamp() end),
        borrower_confirmed_at = coalesce(borrower_confirmed_at, case when actor = e.receiver_id then clock_timestamp() end)
        where exchange_id = e.id returning * into r;
      update public.exchanges set state = 'returned' where id = e.id;
      insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_returned', actor);
      event_kind := 'item_return_confirmed';
    else
      condition_text := btrim(p_details->>'condition'); issue := coalesce(p_details->>'issue_type', 'damage');
      if nullif(condition_text, '') is null or length(condition_text) > 2000 or issue not in ('damage', 'missing_item', 'other')
        or exists(select 1 from jsonb_object_keys(p_details) k where k not in ('condition', 'issue_type')) then
        raise exception using errcode = '22023', message = 'Describe the condition you see and choose an issue type.';
      end if;
      update public.item_returns set revision = revision + 1, contested_by = actor, contested_at = clock_timestamp(), contested_condition = condition_text
        where exchange_id = e.id returning * into r;
      perform private.invalidate_return_reminders(e.id, array['item_return_confirmation_due']);
      perform public.report_exchange_issue(md5(p_intent_id::text || ':return-disagreement')::uuid, e.id, issue, 'Return condition disagreement. ' || condition_text);
      event_kind := 'item_return_contested';
    end if;
  else raise exception using errcode = '22023', message = 'Unknown Return action.';
  end if;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, event_kind, actor);
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(e.community_id, actor, event_kind, p_intent_id) returning id into event;
  if p_action = 'record_return' then
    insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
      select event, e.community_id, counterpart, channel, 'item_return_recorded' from unnest(array['in_app', 'email']) channel;
    perform public.schedule_notification_reminder(e.community_id, e.id, event, counterpart, channel, 'item_return_confirmation_due', r.confirmation_reminder_due_at)
      from unnest(array['in_app', 'email']) channel;
  elsif p_action = 'confirm_return' then
    if not private.finalize_item_exchange(e.id, actor, p_intent_id) then
      insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
        select event, e.community_id, counterpart, channel, 'item_returned' from unnest(array['in_app', 'email']) channel;
    end if;
  end if;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  outcome := private.return_view(e.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'command_item_return', payload, outcome);
  return outcome;
end;
$$;

create function public.prepare_return_evidence(p_intent_id uuid, p_exchange_id uuid, p_evidence_id uuid, p_mime_type text, p_byte_size integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; outcome jsonb; v public.exchange_evidence;
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'evidence', p_evidence_id, 'mime', p_mime_type, 'size', p_byte_size);
begin
  if not public.can_read_exchange(p_exchange_id) then raise exception using errcode = '42501', message = 'Evidence unavailable.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'prepare_return_evidence', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id and kind = 'item' for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  if not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Evidence unavailable.'; end if;
  if e.state not in ('checked_out', 'return_pending') then raise exception using errcode = '55000', message = 'Return photos can be added while the Return is open.'; end if;
  if (select count(*) from public.exchange_evidence where exchange_id = e.id and purpose = 'return') >= 8 then
    raise exception using errcode = '22023', message = 'Up to eight Return photos are allowed.';
  end if;
  insert into public.exchange_evidence(id, exchange_id, community_id, uploader_id, purpose, object_path, mime_type, byte_size)
    values(p_evidence_id, e.id, e.community_id, actor, 'return', e.id::text || '/' || p_evidence_id::text, p_mime_type, p_byte_size) returning * into v;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_return_evidence_prepared', actor);
  outcome := to_jsonb(v);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'prepare_return_evidence', payload, outcome);
  return outcome;
end;
$$;

create function private.complete_return_evidence(p_intent_id uuid, p_evidence_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; v public.exchange_evidence; outcome jsonb;
  payload jsonb := jsonb_build_object('evidence', p_evidence_id);
begin
  select * into v from public.exchange_evidence where id = p_evidence_id;
  if not found or actor is distinct from v.uploader_id or not public.can_read_exchange(v.exchange_id) then
    raise exception using errcode = '42501', message = 'Evidence unavailable.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'complete_exchange_evidence', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = v.exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  select * into v from public.exchange_evidence where id = p_evidence_id for update;
  if e.state not in ('checked_out', 'return_pending') or not public.can_read_exchange(e.id) then
    raise exception using errcode = '55000', message = 'Reserved Return photos can be completed while the Return is open.';
  end if;
  if not exists(select 1 from storage.objects where bucket_id = 'exchange-evidence' and name = v.object_path
      and (metadata->>'size')::bigint = v.byte_size and metadata->>'mimetype' = v.mime_type) then
    raise exception using errcode = '22023', message = 'Upload the matching photo before completing it.';
  end if;
  if v.state = 'pending' then
    update public.exchange_evidence set state = 'ready' where id = v.id returning * into v;
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_return_evidence_completed', actor);
    insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  end if;
  outcome := to_jsonb(v);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'complete_exchange_evidence', payload, outcome);
  return outcome;
end;
$$;

-- Same body as issue 8, plus Return photos dispatching to their own open-Return window.
create or replace function public.complete_exchange_evidence(p_intent_id uuid, p_evidence_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; v public.exchange_evidence; d public.disputes; outcome jsonb; recipients uuid[];
  payload jsonb := jsonb_build_object('evidence', p_evidence_id);
begin
  select * into v from public.exchange_evidence where id = p_evidence_id;
  if v.purpose = 'return' then return private.complete_return_evidence(p_intent_id, p_evidence_id); end if;
  if v.dispute_id is null then return public.complete_handoff_evidence(p_intent_id, p_evidence_id); end if;
  if actor is distinct from v.uploader_id or not public.can_read_exchange(v.exchange_id) then raise exception using errcode = '42501', message = 'Evidence unavailable.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'complete_exchange_evidence', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = v.exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  select * into d from public.disputes where id = v.dispute_id for update;
  select * into v from public.exchange_evidence where id = p_evidence_id for update;
  if not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Evidence unavailable.'; end if;
  if d.closed_at is not null then raise exception using errcode = '55000', message = 'This case is closed.'; end if;
  if not exists(select 1 from storage.objects where bucket_id = 'exchange-evidence' and name = v.object_path
    and (metadata->>'size')::bigint = v.byte_size and metadata->>'mimetype' = v.mime_type) then
    raise exception using errcode = '22023', message = 'Upload the matching photo before completing it.';
  end if;
  if v.state = 'pending' then
    update public.exchange_evidence set state = 'ready' where id = v.id returning * into v;
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'issue_evidence_submitted', actor);
    select array_agg(distinct recipient) into recipients from (
      select case when actor = e.provider_id then e.receiver_id else e.provider_id end as recipient
      union select user_id from public.memberships where community_id = e.community_id and role = 'administrator' and status = 'active' and user_id <> actor
    ) r;
    perform private.record_dispute_activity(d.id, actor, p_intent_id, 'item_dispute_response', recipients);
    insert into public.notification_hints(recipient_id) values(actor);
  end if;
  outcome := to_jsonb(v);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'complete_exchange_evidence', payload, outcome);
  return outcome;
end;
$$;

-- Stalled Returns stay in their fulfillment state; review grants no completion or points.
create function private.queue_item_return_review(p_exchange uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; r public.item_returns; due timestamptz; settings public.item_return_settings; item uuid; event uuid; recipients uuid[];
begin
  select * into settings from public.item_return_settings;
  select * into e from public.exchanges where id = p_exchange and kind = 'item' for update;
  select * into r from public.item_returns where exchange_id = e.id;
  select private.item_return_due(ends_on) into due from public.item_reservations where exchange_id = e.id;
  if not ((p_reason = 'missing_return_confirmation' and e.state = 'return_pending' and r.contested_at is null
      and (r.owner_confirmed_at is null or r.borrower_confirmed_at is null) and r.review_due_at <= clock_timestamp())
    or (p_reason = 'overdue_return' and e.state = 'checked_out' and due + settings.review_after <= clock_timestamp()
      and exists(select 1 from public.item_handoffs h where h.exchange_id = e.id and h.handed_off_at is not null))) then
    return false;
  end if;
  insert into public.exchange_review_items(exchange_id, community_id, reason) values(e.id, e.community_id, p_reason)
    on conflict (exchange_id, reason) do nothing returning id into item;
  if item is null then return false; end if;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_return_review_queued', null);
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(e.community_id, e.provider_id, 'item_return_review_queued', md5(e.id::text || ':' || p_reason)::uuid) returning id into event;
  select array_agg(distinct recipient) into recipients from (
    select unnest(array[e.provider_id, e.receiver_id]) as recipient
    union select user_id from public.memberships where community_id = e.community_id and role = 'administrator' and status = 'active'
  ) people;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, e.community_id, recipient, channel, 'item_return_review_queued' from unnest(recipients) recipient cross join unnest(array['in_app', 'email']) channel;
  insert into public.notification_hints(recipient_id) select unnest(recipients);
  return true;
end;
$$;

create function public.process_due_item_returns() returns jsonb language plpgsql security definer set search_path = '' as $$
declare due record; finalized integer := 0; queued integer := 0; settings public.item_return_settings;
begin
  select * into settings from public.item_return_settings;
  for due in select e.id, e.provider_id from public.exchanges e join public.item_returns r on r.exchange_id = e.id
    where e.state = 'returned' and not exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null)
    order by e.id limit 100
  loop
    if private.finalize_item_exchange(due.id, due.provider_id, md5(due.id::text || ':finalize')::uuid) then finalized := finalized + 1; end if;
  end loop;
  for due in (select e.id, 'missing_return_confirmation' as reason from public.exchanges e join public.item_returns r on r.exchange_id = e.id
      where e.state = 'return_pending' and r.contested_at is null and (r.owner_confirmed_at is null or r.borrower_confirmed_at is null)
        and r.review_due_at <= clock_timestamp()
        and not exists(select 1 from public.exchange_review_items q where q.exchange_id = e.id and q.reason = 'missing_return_confirmation')
    union all select e.id, 'overdue_return' from public.exchanges e join public.item_reservations res on res.exchange_id = e.id
      join public.item_handoffs h on h.exchange_id = e.id
      where e.state = 'checked_out' and h.handed_off_at is not null and private.item_return_due(res.ends_on) + settings.review_after <= clock_timestamp()
        and not exists(select 1 from public.exchange_review_items q where q.exchange_id = e.id and q.reason = 'overdue_return')) limit 100
  loop
    if private.queue_item_return_review(due.id, due.reason) then queued := queued + 1; end if;
  end loop;
  return jsonb_build_object('finalized', finalized, 'queued', queued);
end;
$$;
select cron.schedule('ourtopia-item-return-deadlines', '* * * * *', 'select public.process_due_item_returns()');

create function public.read_community_feed(p_community_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_member(p_community_id) then
    raise exception using errcode = '42501', message = 'Current active Community membership is required.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'title', l.title, 'completed_at', f.created_at,
      'owner', (select u.email from auth.users u join public.memberships m on m.user_id = u.id where u.id = f.owner_id and m.community_id = f.community_id and m.status = 'active'),
      'borrower', (select u.email from auth.users u join public.memberships m on m.user_id = u.id where u.id = f.borrower_id and m.community_id = f.community_id and m.status = 'active'))
    order by f.created_at desc, f.id)
    from (select * from public.community_feed where community_id = p_community_id order by created_at desc, id limit 20) f
    join public.listings l on l.id = f.listing_id), '[]'::jsonb);
end;
$$;

revoke all on function private.item_return_due(date), private.guard_item_return_record(), private.guard_item_return_transition(),
  private.invalidate_return_reminders(uuid, text[]), private.sync_return_reminders(), private.schedule_return_reminders(), private.return_view(uuid),
  private.finalize_item_exchange(uuid, uuid, uuid), private.complete_return_evidence(uuid, uuid), private.queue_item_return_review(uuid, text)
  from public, anon, authenticated;
revoke all on function public.read_item_return(uuid), public.command_item_return(uuid, uuid, integer, text, jsonb),
  public.prepare_return_evidence(uuid, uuid, uuid, text, integer), public.complete_exchange_evidence(uuid, uuid), public.read_community_feed(uuid),
  public.process_due_item_returns() from public, anon;
grant execute on function public.read_item_return(uuid), public.command_item_return(uuid, uuid, integer, text, jsonb),
  public.prepare_return_evidence(uuid, uuid, uuid, text, integer), public.complete_exchange_evidence(uuid, uuid), public.read_community_feed(uuid) to authenticated;
revoke all on function public.process_due_item_returns() from authenticated;
grant execute on function public.process_due_item_returns() to service_role;

notify pgrst, 'reload schema';
