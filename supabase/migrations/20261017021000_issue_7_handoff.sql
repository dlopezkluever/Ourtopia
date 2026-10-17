create table public.item_handoffs (
  exchange_id uuid primary key references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  revision integer not null default 0,
  schedule_revision integer not null default 0,
  starts_at timestamptz,
  location text check (length(location) between 1 and 500),
  proposed_by uuid references auth.users(id),
  schedule_confirmed_at timestamptz,
  condition text check (length(condition) between 1 and 2000),
  accessories text check (length(accessories) <= 2000),
  condition_recorded_by uuid references auth.users(id),
  owner_condition_ack_at timestamptz,
  borrower_condition_ack_at timestamptz,
  handed_off_at timestamptz,
  cancelled_reason text check (length(cancelled_reason) between 1 and 2000),
  check ((starts_at is null) = (location is null)),
  check (handed_off_at is null or (schedule_confirmed_at is not null and condition is not null
    and owner_condition_ack_at is not null and borrower_condition_ack_at is not null))
);
insert into public.item_handoffs(exchange_id, community_id)
  select r.exchange_id, e.community_id from public.item_reservations r join public.exchanges e on e.id = r.exchange_id;
create function private.initialize_item_handoff() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.item_handoffs(exchange_id, community_id) select new.exchange_id, community_id from public.exchanges where id = new.exchange_id;
  return new;
end;
$$;
create trigger initialize_item_handoff after insert on public.item_reservations
  for each row execute function private.initialize_item_handoff();
alter table public.item_handoffs enable row level security;
revoke all on public.item_handoffs from anon, authenticated;
grant select on public.item_handoffs to authenticated;
create policy handoff_read on public.item_handoffs for select to authenticated using (public.can_read_exchange(exchange_id));

create or replace function private.guard_item_exchange_transition() returns trigger language plpgsql set search_path = '' as $$
declare reservation public.item_reservations;
begin
  if new.state = old.state then return new; end if;
  if old.state in ('expired', 'cancelled', 'completed', 'closed_without_completion') then
    raise exception using errcode = '55000', message = 'A terminal item Exchange cannot move again.';
  end if;
  select * into reservation from public.item_reservations where exchange_id = new.id;
  if not found then return new; end if;
  if old.state = 'approved' and new.state not in ('handoff_pending', 'cancelled', 'expired', 'closed_without_completion') then
    raise exception using errcode = '55000', message = 'This item approval can no longer move to that state.';
  end if;
  if old.state = 'handoff_pending' and new.state not in ('checked_out', 'cancelled', 'closed_without_completion') then
    raise exception using errcode = '55000', message = 'This Handoff cannot move to that state.';
  end if;
  if (old.state = 'checked_out' and new.state not in ('return_pending', 'closed_without_completion'))
    or (old.state = 'return_pending' and new.state not in ('returned', 'closed_without_completion'))
    or (old.state = 'returned' and new.state <> 'completed') then
    raise exception using errcode = '55000', message = 'An item that left the owner must follow Return or recovery.';
  end if;
  if new.state = 'cancelled' and old.state not in ('approved', 'handoff_pending') then
    raise exception using errcode = '55000', message = 'Cancellation is only available before Handoff.';
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

create function private.item_custody_until_verified_return(p_before text, p_after text, p_unresolved boolean)
returns boolean language sql immutable set search_path = '' as $$
  select case when p_before in ('approved', 'handoff_pending') and p_after in ('cancelled', 'expired', 'closed_without_completion')
    then false else p_unresolved or p_after in ('checked_out', 'return_pending') end;
$$;
create or replace function private.sync_item_reservation() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.item_reservations set custody_unresolved = private.item_custody_until_verified_return(old.state, new.state, custody_unresolved)
    where exchange_id = new.id;
  if new.state <> 'handoff_pending' then perform private.invalidate_handoff_reminders(new.id); end if;
  return new;
end;
$$;

create table public.exchange_evidence (
  id uuid primary key,
  exchange_id uuid not null references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  uploader_id uuid not null references auth.users(id),
  purpose text not null default 'handoff' check (purpose = 'handoff'),
  object_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  state text not null default 'pending' check (state in ('pending', 'ready')),
  created_at timestamptz not null default now()
);
create index exchange_evidence_exchange on public.exchange_evidence(exchange_id, created_at);
create unique index item_handed_off_once on public.exchange_events(exchange_id) where kind = 'item_handed_off';
create function private.guard_item_handoff_record() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception using errcode = '42501', message = 'Handoff history is retained.'; end if;
  if not exists(select 1 from public.exchanges e where e.id = new.exchange_id and e.kind = 'item' and e.community_id = new.community_id) then
    raise exception using errcode = '23514', message = 'Handoff records must match their item Exchange and Community.';
  end if;
  if tg_op = 'UPDATE' then
    if (new.exchange_id, new.community_id) is distinct from (old.exchange_id, old.community_id) then
      raise exception using errcode = '42501', message = 'Handoff identity is immutable.';
    end if;
    if tg_table_name = 'exchange_evidence' then
      if (new.id, new.uploader_id, new.purpose, new.object_path, new.mime_type, new.byte_size, new.created_at)
        is distinct from (old.id, old.uploader_id, old.purpose, old.object_path, old.mime_type, old.byte_size, old.created_at)
        or (old.state = 'ready' and new.state <> 'ready') then
        raise exception using errcode = '42501', message = 'Evidence identity and completed uploads are immutable.';
      end if;
    elsif old.handed_off_at is not null and (new.starts_at, new.location, new.schedule_revision, new.condition, new.accessories,
      new.condition_recorded_by, new.owner_condition_ack_at, new.borrower_condition_ack_at, new.handed_off_at)
      is distinct from (old.starts_at, old.location, old.schedule_revision, old.condition, old.accessories,
        old.condition_recorded_by, old.owner_condition_ack_at, old.borrower_condition_ack_at, old.handed_off_at) then
      raise exception using errcode = '42501', message = 'A recorded Handoff cannot be rewritten.';
    end if;
  end if;
  return new;
end;
$$;
create trigger handoff_record_integrity before insert or update or delete on public.item_handoffs
  for each row execute function private.guard_item_handoff_record();
create trigger evidence_record_integrity before insert or update or delete on public.exchange_evidence
  for each row execute function private.guard_item_handoff_record();
alter table public.exchange_evidence enable row level security;
revoke all on public.exchange_evidence from anon, authenticated;
grant select on public.exchange_evidence to authenticated;
create policy evidence_read on public.exchange_evidence for select to authenticated using (
  public.can_read_exchange(exchange_id) and (state = 'ready' or uploader_id = auth.uid()));
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values('exchange-evidence', 'exchange-evidence', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);
create function public.can_access_exchange_evidence(p_path text, p_upload boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.exchange_evidence v join public.exchanges e on e.id = v.exchange_id
    where v.object_path = p_path and public.can_read_exchange(e.id)
    and case when p_upload then v.uploader_id = auth.uid() and v.state = 'pending' and e.state in ('handoff_pending', 'checked_out')
      else v.state = 'ready' or v.uploader_id = auth.uid() end);
$$;
revoke all on function public.can_access_exchange_evidence(text, boolean) from public, anon;
grant execute on function public.can_access_exchange_evidence(text, boolean) to authenticated;
create policy exchange_evidence_download on storage.objects for select to authenticated
  using (bucket_id = 'exchange-evidence' and public.can_access_exchange_evidence(name));
create policy exchange_evidence_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'exchange-evidence' and public.can_access_exchange_evidence(name, true));

create function private.handoff_view(p_exchange uuid) returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(h) || jsonb_build_object('state', e.state, 'community_id', e.community_id,
    'owner_id', e.provider_id, 'borrower_id', e.receiver_id, 'reservation', to_jsonb(r),
    'evidence', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at) from public.exchange_evidence v
      where v.exchange_id = e.id and (v.state = 'ready' or v.uploader_id = auth.uid())), '[]'::jsonb))
  from public.item_handoffs h join public.exchanges e on e.id = h.exchange_id
    join public.item_reservations r on r.exchange_id = e.id where e.id = p_exchange;
$$;
create function public.read_item_handoff(p_exchange_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_read_exchange(p_exchange_id) then raise exception using errcode = '42501', message = 'Handoff unavailable.'; end if;
  return private.handoff_view(p_exchange_id);
end;
$$;

-- Upcoming Handoff reminders use the issue-23 reminder identity keyed by the Exchange.
-- A due time no notice carries makes every queued reminder obsolete until a new confirmation reschedules it.
create function private.invalidate_handoff_reminders(p_exchange uuid) returns void language sql security definer set search_path = '' as $$
  update public.notification_reminders set due_at = 'infinity'
    where source_key = p_exchange and kind = 'item_handoff_upcoming' and due_at <> 'infinity';
$$;

create function public.command_item_handoff(p_intent_id uuid, p_exchange_id uuid, p_expected_revision integer, p_action text, p_details jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); e public.exchanges; r public.item_reservations; h public.item_handoffs;
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'revision', p_expected_revision, 'action', p_action, 'details', p_details);
  outcome jsonb; event_id uuid; notice_kind text; instant timestamptz; meeting text;
begin
  if not public.can_read_exchange(p_exchange_id) then raise exception using errcode = '42501', message = 'Handoff unavailable.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'command_item_handoff', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id and kind = 'item' for update;
  select * into r from public.item_reservations where exchange_id = e.id for update;
  select * into h from public.item_handoffs where exchange_id = e.id for update;
  if not found or not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Handoff unavailable.'; end if;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor and status in ('active', 'suspended', 'removed') for share;
  if not found then raise exception using errcode = '42501', message = 'Handoff unavailable.'; end if;
  if e.state not in ('approved', 'handoff_pending') or h.handed_off_at is not null or h.revision is distinct from p_expected_revision then
    raise exception using errcode = '55000', message = 'This Handoff changed. Refresh before continuing.';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then raise exception using errcode = '22023', message = 'Handoff details are required.'; end if;
  if p_action = 'acknowledge_terms' then
    if actor <> e.receiver_id then raise exception using errcode = '42501', message = 'Only the borrower acknowledges these terms.'; end if;
    if e.state <> 'approved' or clock_timestamp() >= r.acknowledgment_due_at then
      raise exception using errcode = '55000', message = 'The 48-hour acknowledgment deadline has passed.';
    end if;
    if p_details <> '{"return_date":true,"condition":true,"replacement_value":true,"responsibility":true}'::jsonb then
      raise exception using errcode = '22023', message = 'Acknowledge return date, condition, replacement value, and responsibility.';
    end if;
    update public.item_reservations set acknowledged_at = clock_timestamp() where exchange_id = e.id;
    update public.exchanges set state = 'handoff_pending' where id = e.id;
    notice_kind := 'item_terms_acknowledged';
  elsif p_action = 'cancel' then
    if nullif(btrim(p_details->>'reason'), '') is null or length(p_details->>'reason') > 2000 then
      raise exception using errcode = '22023', message = 'Supply a cancellation reason.';
    end if;
    update public.item_handoffs set cancelled_reason = btrim(p_details->>'reason') where exchange_id = e.id;
    update public.exchanges set state = 'cancelled' where id = e.id;
    perform private.invalidate_handoff_reminders(e.id);
    notice_kind := 'item_handoff_cancelled';
  else
    if e.state <> 'handoff_pending' then raise exception using errcode = '55000', message = 'Acknowledge the terms before arranging Handoff.'; end if;
    if p_action = 'propose_schedule' then
      instant := (p_details->>'starts_at')::timestamptz; meeting := btrim(p_details->>'location');
      if instant is null or instant <= clock_timestamp() or nullif(meeting, '') is null or length(meeting) > 500 then
        raise exception using errcode = '22023', message = 'Choose a future Handoff time and a meeting location.';
      end if;
      perform private.invalidate_handoff_reminders(e.id);
      update public.item_handoffs set starts_at = instant, location = meeting, proposed_by = actor,
        schedule_revision = schedule_revision + 1, schedule_confirmed_at = null, condition = null, accessories = null,
        condition_recorded_by = null, owner_condition_ack_at = null, borrower_condition_ack_at = null where exchange_id = e.id;
      notice_kind := 'item_handoff_proposed';
    elsif p_action = 'confirm_schedule' then
      if h.starts_at is null or h.proposed_by = actor or h.schedule_confirmed_at is not null then
        raise exception using errcode = '55000', message = 'The other participant must confirm the current proposal.';
      end if;
      update public.item_handoffs set schedule_confirmed_at = clock_timestamp() where exchange_id = e.id;
      notice_kind := 'item_handoff_scheduled';
    elsif p_action = 'record_condition' then
      if h.schedule_confirmed_at is null then raise exception using errcode = '55000', message = 'Confirm the current schedule first.'; end if;
      if nullif(btrim(p_details->>'condition'), '') is null or length(p_details->>'condition') > 2000
        or p_details->>'accessories' is null or length(p_details->>'accessories') > 2000 then
        raise exception using errcode = '22023', message = 'Record the condition and accessories, or say none.';
      end if;
      update public.item_handoffs set condition = btrim(p_details->>'condition'), accessories = p_details->>'accessories', condition_recorded_by = actor,
        owner_condition_ack_at = case when actor = e.provider_id then clock_timestamp() end,
        borrower_condition_ack_at = case when actor = e.receiver_id then clock_timestamp() end where exchange_id = e.id;
      notice_kind := 'item_handoff_condition_recorded';
    elsif p_action = 'confirm_handoff' then
      if h.schedule_confirmed_at is null or h.condition is null or h.condition_recorded_by = actor then
        raise exception using errcode = '55000', message = 'The other participant must acknowledge the recorded condition and accessories.';
      end if;
      if p_details <> '{"condition_acknowledged":true}'::jsonb then raise exception using errcode = '22023', message = 'Acknowledge the item was received in the recorded condition.'; end if;
      update public.item_handoffs set handed_off_at = clock_timestamp(),
        owner_condition_ack_at = coalesce(owner_condition_ack_at, clock_timestamp()),
        borrower_condition_ack_at = coalesce(borrower_condition_ack_at, clock_timestamp()) where exchange_id = e.id;
      update public.exchanges set state = 'checked_out' where id = e.id;
      perform private.invalidate_handoff_reminders(e.id);
      notice_kind := 'item_handed_off';
    else raise exception using errcode = '22023', message = 'Unknown Handoff action.';
    end if;
  end if;
  update public.item_handoffs set revision = revision + 1 where exchange_id = e.id returning * into h;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, notice_kind, actor);
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(e.community_id, actor, notice_kind, p_intent_id) returning id into event_id;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event_id, e.community_id, case when actor = e.provider_id then e.receiver_id else e.provider_id end, channel, notice_kind
      from unnest(array['in_app','email']) channel;
  if p_action = 'confirm_schedule' then
    perform public.schedule_notification_reminder(e.community_id, e.id, event_id, e.provider_id, channel, 'item_handoff_upcoming',
      greatest(clock_timestamp(), h.starts_at - interval '24 hours')) from unnest(array['in_app','email']) channel;
  end if;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  outcome := private.handoff_view(e.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'command_item_handoff', payload, outcome);
  return outcome;
end;
$$;

create function public.prepare_exchange_evidence(p_intent_id uuid, p_exchange_id uuid, p_evidence_id uuid, p_mime_type text, p_byte_size integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; outcome jsonb; v public.exchange_evidence;
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'evidence', p_evidence_id, 'mime', p_mime_type, 'size', p_byte_size);
begin
  if not public.can_read_exchange(p_exchange_id) then raise exception using errcode = '42501', message = 'Evidence unavailable.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'prepare_exchange_evidence', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id and kind = 'item' for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  if e.state <> 'handoff_pending' or not public.can_read_exchange(e.id) then raise exception using errcode = '55000', message = 'Photos can be added before Handoff.'; end if;
  if (select count(*) from public.exchange_evidence where exchange_id = e.id) >= 8 then raise exception using errcode = '22023', message = 'Up to eight Handoff photos are allowed.'; end if;
  insert into public.exchange_evidence(id, exchange_id, community_id, uploader_id, object_path, mime_type, byte_size)
    values(p_evidence_id, e.id, e.community_id, actor, e.id::text || '/' || p_evidence_id::text, p_mime_type, p_byte_size) returning * into v;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_evidence_prepared', actor);
  outcome := to_jsonb(v);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'prepare_exchange_evidence', payload, outcome);
  return outcome;
end;
$$;

create function public.complete_exchange_evidence(p_intent_id uuid, p_evidence_id uuid)
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
  if e.state not in ('handoff_pending', 'checked_out') or not public.can_read_exchange(e.id) then raise exception using errcode = '55000', message = 'Reserved photos can be completed during this open Handoff obligation.'; end if;
  if not exists(select 1 from storage.objects where bucket_id = 'exchange-evidence' and name = v.object_path
      and (metadata->>'size')::bigint = v.byte_size and metadata->>'mimetype' = v.mime_type) then
    raise exception using errcode = '22023', message = 'Upload the matching photo before completing it.';
  end if;
  if v.state = 'pending' then
    update public.exchange_evidence set state = 'ready' where id = v.id returning * into v;
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_evidence_completed', actor);
    insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  end if;
  outcome := to_jsonb(v);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'complete_exchange_evidence', payload, outcome);
  return outcome;
end;
$$;

create trigger handoff_audit_append_only before update or delete on public.community_events
  for each row when (old.kind like 'item\_%') execute function private.reject_history_rewrite();
drop policy event_read on public.community_events;
create policy event_read on public.community_events for select to authenticated using (
  public.is_active_member(community_id) and kind not like 'item\_%' and kind not in ('conversation_started', 'message_sent',
    'help_commitment_offered', 'help_commitment_accepted', 'help_scheduled', 'help_cancelled',
    'test_billing_requested', 'borrow_requested', 'borrow_approved', 'borrow_rejected', 'borrow_expired'));

revoke all on function private.initialize_item_handoff(), private.item_custody_until_verified_return(text, text, boolean),
  private.handoff_view(uuid), private.invalidate_handoff_reminders(uuid), private.guard_item_handoff_record() from public, anon, authenticated;
revoke all on function public.read_item_handoff(uuid), public.command_item_handoff(uuid, uuid, integer, text, jsonb),
  public.prepare_exchange_evidence(uuid, uuid, uuid, text, integer), public.complete_exchange_evidence(uuid, uuid) from public, anon;
grant execute on function public.read_item_handoff(uuid), public.command_item_handoff(uuid, uuid, integer, text, jsonb),
  public.prepare_exchange_evidence(uuid, uuid, uuid, text, integer), public.complete_exchange_evidence(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
