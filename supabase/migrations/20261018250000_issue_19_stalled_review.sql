-- Stalled review decisions (issue 19): an administrator verifies completion from recorded evidence or closes without
-- completion, and records recovery for an item closed while custody is unresolved. Every decision is one guarded command.

alter table public.exchange_review_items drop constraint exchange_review_items_reason_check;
alter table public.exchange_review_items add constraint exchange_review_items_reason_check
  check (reason in ('missing_return_confirmation', 'overdue_return', 'missing_help_confirmation', 'unresolved_dispute'));

create table public.stalled_review_decisions (
  exchange_id uuid primary key references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  review_reason text not null check (review_reason in ('missing_return_confirmation', 'overdue_return', 'missing_help_confirmation', 'unresolved_dispute')),
  outcome text not null check (outcome in ('verified_completion', 'closed_without_completion')),
  reason text not null check (length(btrim(reason)) between 10 and 4000),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  decided_by uuid not null references auth.users(id),
  decided_at timestamptz not null default clock_timestamp(),
  intent_id uuid not null
);
create trigger stalled_review_decisions_append_only before update or delete on public.stalled_review_decisions
  for each row execute function private.reject_history_rewrite();

create function private.guard_stalled_review_decision() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.exchanges e where e.id = new.exchange_id and e.community_id = new.community_id
    and new.decided_by not in (e.provider_id, e.receiver_id)) then
    raise exception using errcode = '23514', message = 'Stalled review decisions must match their Exchange Community and exclude its participants.';
  end if;
  return new;
end;
$$;
create trigger stalled_review_decision_integrity before insert on public.stalled_review_decisions
  for each row execute function private.guard_stalled_review_decision();
alter table public.stalled_review_decisions enable row level security;
revoke all on public.stalled_review_decisions from anon, authenticated;
grant select on public.stalled_review_decisions to authenticated;
create policy stalled_review_decision_read on public.stalled_review_decisions for select to authenticated
  using (public.is_community_administrator(community_id) or public.can_read_exchange(exchange_id));

-- Recovery of an item closed while custody was unresolved (no confirmed Return). Separate from the closure decision.
create table public.stalled_item_recoveries (
  exchange_id uuid primary key references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  reason text not null check (length(btrim(reason)) between 10 and 4000),
  decided_by uuid not null references auth.users(id),
  decided_at timestamptz not null default clock_timestamp(),
  intent_id uuid not null
);
create trigger stalled_item_recoveries_append_only before update or delete on public.stalled_item_recoveries
  for each row execute function private.reject_history_rewrite();

create function private.guard_stalled_item_recovery() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.exchanges e where e.id = new.exchange_id and e.community_id = new.community_id
    and e.kind = 'item' and e.state = 'closed_without_completion' and new.decided_by not in (e.provider_id, e.receiver_id)) then
    raise exception using errcode = '23514', message = 'Stalled recoveries must match a closed item Exchange and exclude its participants.';
  end if;
  return new;
end;
$$;
create trigger stalled_item_recovery_integrity before insert on public.stalled_item_recoveries
  for each row execute function private.guard_stalled_item_recovery();
alter table public.stalled_item_recoveries enable row level security;
revoke all on public.stalled_item_recoveries from anon, authenticated;
grant select on public.stalled_item_recoveries to authenticated;
create policy stalled_item_recovery_read on public.stalled_item_recoveries for select to authenticated
  using (public.is_community_administrator(community_id) or public.can_read_exchange(exchange_id));

-- Community events for these kinds carry item_ or help_ prefixes, so the community-wide feed never shows them.
-- Help decisions are added to the explicit exclusion list that issue 13 keeps for help events.
drop policy event_read on public.community_events;
create policy event_read on public.community_events for select to authenticated using (
  public.is_active_member(community_id) and kind not like 'item\_%' and kind not like 'issue\_%'
  and kind not like 'help\_stalled\_review\_%'
  and kind not in ('conversation_started', 'message_sent', 'help_commitment_offered', 'help_commitment_accepted',
    'help_scheduled', 'help_cancelled', 'help_completion_confirmed', 'help_completion_disputed', 'help_completion_due', 'help_completed',
    'help_completion_review_queued', 'help_confirmation_due', 'test_billing_requested', 'borrow_requested', 'borrow_approved', 'borrow_rejected', 'borrow_expired'));

-- The record requirements for verified completion. An empty array means the recorded evidence establishes completion.
-- Unresolved conflict = an open Exchange issue, or a closed issue whose recorded outcome is unresolved.
create function private.stalled_review_gaps(p_exchange uuid, p_evidence jsonb) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare e public.exchanges; h public.item_handoffs; r public.item_returns; c public.help_completions; gaps text[] := '{}';
  conflict boolean;
begin
  select * into e from public.exchanges where id = p_exchange;
  conflict := exists(select 1 from public.disputes d where d.exchange_id = e.id
    and (d.closed_at is null or private.dispute_effective_outcome(d.id) = 'unresolved'));
  if e.kind = 'item' then
    select * into h from public.item_handoffs where exchange_id = e.id;
    select * into r from public.item_returns where exchange_id = e.id;
    if h.exchange_id is null or h.handed_off_at is null then gaps := gaps || 'handoff'; end if;
    if r.exchange_id is null or e.state = 'checked_out' then gaps := gaps || 'return';
    elsif r.owner_confirmed_at is null and r.borrower_confirmed_at is null then gaps := gaps || 'confirmation';
    end if;
    if (r.exchange_id is not null and r.contested_at is not null) or conflict then gaps := gaps || 'conflict'; end if;
    if coalesce(p_evidence->>'return_record', '') <> 'true' or coalesce(p_evidence->>'condition', '') <> 'true' then gaps := gaps || 'evidence'; end if;
  else
    select * into c from public.help_completions where exchange_id = e.id;
    if c.exchange_id is null or (c.helper_confirmed_at is null and c.requester_confirmed_at is null) then gaps := gaps || 'confirmation'; end if;
    if conflict then gaps := gaps || 'conflict'; end if;
    if coalesce(p_evidence->>'work_record', '') <> 'true' or not exists(select 1 from public.exchange_events x
      where x.exchange_id = e.id and x.kind = 'help_scheduled') then gaps := gaps || 'evidence'; end if;
  end if;
  return gaps;
end;
$$;

-- Both Return confirmations match, no conflict remains, and the Exchange is returned: the ordinary path completes it.
create function private.stalled_normal_path_ready(p_exchange uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.exchanges e join public.item_returns r on r.exchange_id = e.id
      where e.id = p_exchange and e.kind = 'item' and e.state = 'returned' and r.owner_confirmed_at is not null
        and r.borrower_confirmed_at is not null and r.contested_at is null)
    and not exists(select 1 from public.disputes d where d.exchange_id = p_exchange
      and (d.closed_at is null or private.dispute_effective_outcome(d.id) = 'unresolved'));
$$;

create function private.stalled_review_view(p_exchange uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.exchanges; h public.item_handoffs; r public.item_returns; c public.help_completions; res public.item_reservations;
  decided public.stalled_review_decisions; recovered public.stalled_item_recoveries;
  record_evidence constant jsonb := '{"return_record":"true","condition":"true","work_record":"true"}';
begin
  select * into e from public.exchanges where id = p_exchange;
  select * into h from public.item_handoffs where exchange_id = e.id;
  select * into r from public.item_returns where exchange_id = e.id;
  select * into c from public.help_completions where exchange_id = e.id;
  select * into res from public.item_reservations where exchange_id = e.id;
  select * into decided from public.stalled_review_decisions where exchange_id = e.id;
  select * into recovered from public.stalled_item_recoveries where exchange_id = e.id;
  return jsonb_build_object('exchangeId', e.id, 'kind', e.kind, 'state', e.state, 'communityId', e.community_id,
    'providerId', e.provider_id, 'receiverId', e.receiver_id, 'completedAt', e.completed_at,
    'participant', auth.uid() in (e.provider_id, e.receiver_id),
    'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', q.reason, 'queuedAt', q.queued_at) order by q.queued_at, q.reason)
      from public.exchange_review_items q where q.exchange_id = e.id), '[]'::jsonb),
    'record', jsonb_build_object('handedOffAt', h.handed_off_at, 'returnedAt', r.returned_at, 'condition', r.condition,
      'ownerConfirmedAt', r.owner_confirmed_at, 'borrowerConfirmedAt', r.borrower_confirmed_at, 'contested', r.contested_at is not null,
      'helperConfirmedAt', c.helper_confirmed_at, 'requesterConfirmedAt', c.requester_confirmed_at, 'disagreement', c.disagreement,
      'openDispute', exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null),
      'unresolvedDispute', exists(select 1 from public.disputes d where d.exchange_id = e.id and private.dispute_effective_outcome(d.id) = 'unresolved')),
    'recordGaps', to_jsonb(private.stalled_review_gaps(e.id, record_evidence)),
    'decision', case when decided.exchange_id is null then null else jsonb_build_object('outcome', decided.outcome, 'reason', decided.reason,
      'evidence', decided.evidence, 'reviewReason', decided.review_reason, 'decidedBy', decided.decided_by, 'decidedAt', decided.decided_at) end,
    'custodyUnresolved', coalesce(res.custody_unresolved, false),
    'recovery', case when recovered.exchange_id is null then null else jsonb_build_object('reason', recovered.reason,
      'decidedBy', recovered.decided_by, 'decidedAt', recovered.decided_at) end,
    'canDecide', decided.exchange_id is null and public.is_active_member(e.community_id) and public.is_community_administrator(e.community_id)
      and auth.uid() not in (e.provider_id, e.receiver_id) and exists(select 1 from public.exchange_review_items q where q.exchange_id = e.id)
      and not private.stalled_normal_path_ready(e.id)
      and ((e.kind = 'item' and e.state in ('return_pending', 'checked_out', 'returned')) or (e.kind = 'help' and e.state = 'completion_pending')),
    'canRecover', e.kind = 'item' and e.state = 'closed_without_completion' and coalesce(res.custody_unresolved, false)
      and recovered.exchange_id is null and public.is_active_member(e.community_id) and public.is_community_administrator(e.community_id)
      and auth.uid() not in (e.provider_id, e.receiver_id));
end;
$$;

create function public.read_stalled_review(p_exchange_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.exchanges;
begin
  select * into e from public.exchanges where id = p_exchange_id;
  if not found or not (public.can_read_exchange(e.id) or (public.is_community_administrator(e.community_id)
    and exists(select 1 from public.exchange_review_items q where q.exchange_id = e.id))) then
    raise exception using errcode = '42501', message = 'Review unavailable.';
  end if;
  return private.stalled_review_view(e.id);
end;
$$;

-- Open review items for the Community. A closed item stays listed until its custody is recovered.
create function public.read_stalled_review_queue(p_community_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_community_administrator(p_community_id) then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('exchangeId', f.exchange_id, 'kind', f.kind, 'state', f.state, 'reasons', f.reasons,
      'queuedAt', f.queued_at) order by f.queued_at, f.exchange_id)
    from (select e.id as exchange_id, e.kind, e.state, min(q.queued_at) as queued_at,
        jsonb_agg(q.reason order by q.reason) as reasons
      from public.exchange_review_items q join public.exchanges e on e.id = q.exchange_id
      where q.community_id = p_community_id and e.community_id = p_community_id
        and ((e.state in ('return_pending', 'checked_out', 'returned', 'completion_pending')
            and not exists(select 1 from public.stalled_review_decisions s where s.exchange_id = e.id))
          or (e.kind = 'item' and e.state = 'closed_without_completion'
            and exists(select 1 from public.item_reservations r where r.exchange_id = e.id and r.custody_unresolved)
            and not exists(select 1 from public.stalled_item_recoveries x where x.exchange_id = e.id)))
      group by e.id, e.kind, e.state) f), '[]'::jsonb);
end;
$$;

-- One guarded transaction: the intent replays the prior result, and a changed payload fails. Verified completion reuses
-- the ordinary completion effects; closure only records the reason and moves the state, with no points or interactions.
create function public.decide_stalled_review(p_intent_id uuid, p_exchange_id uuid, p_outcome text, p_reason text, p_evidence jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; outcome jsonb; review text; gaps text[]; event uuid;
  reason_text text := btrim(coalesce(p_reason, ''));
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'outcome', p_outcome, 'reason', p_reason, 'evidence', p_evidence);
begin
  select * into e from public.exchanges where id = p_exchange_id;
  if not found or actor is null or not public.is_active_member(e.community_id) or not public.is_community_administrator(e.community_id)
    or actor in (e.provider_id, e.receiver_id) then
    raise exception using errcode = '42501', message = 'Only an active same-Community administrator who is not a participant decides this review.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'decide_stalled_review', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor and status = 'active' for share;
  if not found then raise exception using errcode = '42501', message = 'Only an active same-Community administrator who is not a participant decides this review.'; end if;
  if p_outcome is null or p_outcome not in ('verified_completion', 'closed_without_completion') then
    raise exception using errcode = '22023', message = 'Choose verified completion or closed without completion.';
  end if;
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'Cite the records behind this decision.';
  end if;
  if length(reason_text) not between 10 and 4000 then
    raise exception using errcode = '22023', message = 'Record a reason of at least 10 characters.';
  end if;
  select q.reason into review from public.exchange_review_items q where q.exchange_id = e.id order by q.queued_at desc, q.id desc limit 1;
  if review is null then raise exception using errcode = '55000', message = 'This Exchange is not in stalled review.'; end if;
  if exists(select 1 from public.stalled_review_decisions s where s.exchange_id = e.id) then
    raise exception using errcode = '55000', message = 'This review was already decided.';
  end if;
  if not ((e.kind = 'item' and e.state in ('return_pending', 'checked_out', 'returned')) or (e.kind = 'help' and e.state = 'completion_pending')) then
    raise exception using errcode = '55000', message = 'This Exchange is no longer awaiting review.';
  end if;
  if p_outcome = 'verified_completion' then
    gaps := private.stalled_review_gaps(e.id, p_evidence);
    if cardinality(gaps) > 0 then
      raise exception using errcode = '55000', message = 'Verified completion is missing: ' || array_to_string(gaps, ', ') || '.';
    end if;
  elsif exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null) then
    raise exception using errcode = '55000', message = 'Decide the open Exchange issue before closing this review.';
  elsif private.stalled_normal_path_ready(e.id) then
    raise exception using errcode = '55000', message = 'Both confirmations match and no issue remains, so this Exchange completes through the ordinary path.';
  end if;

  insert into public.stalled_review_decisions(exchange_id, community_id, review_reason, outcome, reason, evidence, decided_by, intent_id)
    values(e.id, e.community_id, review, p_outcome, reason_text, p_evidence, actor, p_intent_id);
  if p_outcome = 'verified_completion' then
    if e.kind = 'item' then
      if e.state = 'return_pending' then update public.exchanges set state = 'returned' where id = e.id; end if;
      perform private.complete_item_exchange(e.id, actor, p_intent_id, 'decide_stalled_review');
    else
      perform private.complete_help_exchange(e.id, actor, p_intent_id, 'decide_stalled_review');
    end if;
  else
    update public.exchanges set state = 'closed_without_completion' where id = e.id;
  end if;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id)
    values(e.id, e.community_id, e.kind || '_stalled_review_decided', actor);
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(e.community_id, actor, e.kind || '_stalled_review_decided', md5(p_intent_id::text || ':stalled-review')::uuid) returning id into event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, e.community_id, recipient, channel, e.kind || '_stalled_review_decided'
    from unnest(array[e.provider_id, e.receiver_id]) recipient cross join unnest(array['in_app', 'email']) channel;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  outcome := private.stalled_review_view(e.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'decide_stalled_review', payload, outcome);
  return outcome;
end;
$$;

-- Recovery is a separate recorded decision: the item left the owner and is back in the owner's control.
create function public.record_stalled_item_recovery(p_intent_id uuid, p_exchange_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; outcome jsonb; event uuid;
  reason_text text := btrim(coalesce(p_reason, ''));
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'reason', p_reason);
begin
  select * into e from public.exchanges where id = p_exchange_id;
  if not found or actor is null or not public.is_active_member(e.community_id) or not public.is_community_administrator(e.community_id)
    or actor in (e.provider_id, e.receiver_id) then
    raise exception using errcode = '42501', message = 'Only an active same-Community administrator who is not a participant records recovery.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'record_stalled_item_recovery', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor and status = 'active' for share;
  if not found then raise exception using errcode = '42501', message = 'Only an active same-Community administrator who is not a participant records recovery.'; end if;
  if e.kind <> 'item' or e.state <> 'closed_without_completion'
    or not exists(select 1 from public.stalled_review_decisions s where s.exchange_id = e.id and s.outcome = 'closed_without_completion') then
    raise exception using errcode = '55000', message = 'Only a stalled item closed without completion can record recovery.';
  end if;
  if not exists(select 1 from public.item_reservations r where r.exchange_id = e.id and r.custody_unresolved) then
    raise exception using errcode = '55000', message = 'This item has no unrecovered custody.';
  end if;
  if length(reason_text) not between 10 and 4000 then
    raise exception using errcode = '22023', message = 'Record how the owner recovered the item, in at least 10 characters.';
  end if;
  insert into public.stalled_item_recoveries(exchange_id, community_id, reason, decided_by, intent_id)
    values(e.id, e.community_id, reason_text, actor, p_intent_id);
  update public.item_reservations set custody_unresolved = false where exchange_id = e.id;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_stalled_recovery_recorded', actor);
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(e.community_id, actor, 'item_stalled_recovery_recorded', p_intent_id) returning id into event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, e.community_id, recipient, channel, 'item_stalled_recovery_recorded'
    from unnest(array[e.provider_id, e.receiver_id]) recipient cross join unnest(array['in_app', 'email']) channel;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  outcome := private.stalled_review_view(e.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'record_stalled_item_recovery', payload, outcome);
  return outcome;
end;
$$;

-- The verifier label stamps reputation awards. Ordinary completion keeps the issue 4 label, so its behavior is unchanged.
drop function private.settle_exchange_completion(uuid);
create function private.settle_exchange_completion(p_exchange_id uuid, p_verifier text default 'settle_exchange_completion')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare exchange public.exchanges;
begin
  select * into exchange from public.exchanges where id = p_exchange_id for update;
  if not found then raise exception using errcode = '22023', message = 'Exchange unavailable.'; end if;
  if exchange.state <> 'completed' then raise exception using errcode = '55000', message = 'Only a completed Exchange can be settled.'; end if;
  insert into public.qualifying_interactions(exchange_id, community_id, participant_id)
    values (exchange.id, exchange.community_id, exchange.provider_id), (exchange.id, exchange.community_id, exchange.receiver_id)
    on conflict (exchange_id, participant_id) do nothing;
  insert into public.reputation_events(community_id, recipient_id, rule, points, source_kind, source_id, exchange_id, verified_by_command)
    select exchange.community_id, case r.recipient_role when 'provider' then exchange.provider_id else exchange.receiver_id end,
      r.rule, r.points, 'exchange', exchange.id, exchange.id, p_verifier
    from public.reputation_rules r where r.exchange_kind = exchange.kind
    on conflict (rule, source_kind, source_id, recipient_id) do nothing;
  insert into public.exchange_events(exchange_id, community_id, kind) values (exchange.id, exchange.community_id, 'completion_settled')
    on conflict (exchange_id) where kind = 'completion_settled' do nothing;
  return jsonb_build_object(
    'exchangeId', exchange.id,
    'interactions', (select jsonb_agg(q.participant_id order by q.participant_id) from public.qualifying_interactions q where q.exchange_id = exchange.id),
    'events', (select jsonb_agg(jsonb_build_object('id', r.id, 'rule', r.rule, 'recipientId', r.recipient_id, 'points', r.points) order by r.rule)
      from public.reputation_events r where r.source_kind = 'exchange' and r.source_id = exchange.id)
  );
end;
$$;

-- Completion effects shared by ordinary confirmation (issues 9, 13) and verified completion. Callers own the state checks.
create function private.complete_item_exchange(p_exchange uuid, p_actor uuid, p_intent uuid, p_verifier text default 'settle_exchange_completion') returns void
language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; event uuid;
begin
  select * into e from public.exchanges where id = p_exchange for update;
  update public.exchanges set state = 'completed' where id = e.id;
  perform private.settle_exchange_completion(e.id, p_verifier);
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'item_completed', null);
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(e.community_id, p_actor, 'item_completed', p_intent) returning id into event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, e.community_id, recipient, channel, 'item_completed'
    from unnest(array[e.provider_id, e.receiver_id]) recipient cross join unnest(array['in_app', 'email']) channel;
  insert into public.community_feed(community_id, kind, exchange_id, listing_id, owner_id, borrower_id)
    values(e.community_id, 'item_loan_completed', e.id, e.source_id, e.provider_id, e.receiver_id) on conflict (exchange_id) do nothing;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
end;
$$;

create function private.complete_help_exchange(p_exchange uuid, p_actor uuid, p_intent uuid, p_verifier text default 'settle_exchange_completion') returns void
language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; event uuid;
begin
  select * into e from public.exchanges where id = p_exchange for update;
  update public.exchanges set state = 'completed' where id = e.id;
  perform private.settle_exchange_completion(e.id, p_verifier);
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'help_completed', null);
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(e.community_id, p_actor, 'help_completed', p_intent) returning id into event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, e.community_id, recipient, channel, 'help_completed'
      from unnest(array[e.provider_id, e.receiver_id]) recipient cross join unnest(array['in_app', 'email']) channel;
  insert into public.help_completion_feed(community_id, exchange_id, helper_id, requester_id)
    values(e.community_id, e.id, e.provider_id, e.receiver_id) on conflict(exchange_id) do nothing;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
end;
$$;

create or replace function private.finalize_item_exchange(p_exchange uuid, p_actor uuid, p_intent uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; r public.item_returns; h public.item_handoffs;
begin
  select * into e from public.exchanges where id = p_exchange and kind = 'item' for update;
  select * into r from public.item_returns where exchange_id = e.id;
  select * into h from public.item_handoffs where exchange_id = e.id;
  if e.state is distinct from 'returned' or h.handed_off_at is null or r.exchange_id is null or r.owner_confirmed_at is null
    or r.borrower_confirmed_at is null or r.contested_at is not null
    or exists(select 1 from public.disputes d where d.exchange_id = e.id and (d.closed_at is null or private.dispute_effective_outcome(d.id) = 'unresolved')) then
    return false;
  end if;
  perform private.complete_item_exchange(e.id, p_actor, p_intent);
  return true;
end;
$$;

create or replace function private.finalize_help_exchange(p_exchange uuid, p_actor uuid, p_intent uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; c public.help_completions;
begin
  select * into e from public.exchanges where id = p_exchange and kind = 'help' for update;
  select * into c from public.help_completions where exchange_id = e.id;
  if e.state is distinct from 'completion_pending' or c.exchange_id is null
    or c.helper_confirmed_at is null or c.requester_confirmed_at is null
    or exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null) then return false; end if;
  perform private.complete_help_exchange(e.id, p_actor, p_intent);
  return true;
end;
$$;

-- A verified decision is the only route past the Return-confirmation guard. Ordinary paths are unchanged.
create or replace function private.guard_item_return_transition() returns trigger language plpgsql set search_path = '' as $$
declare r public.item_returns;
begin
  if new.state = old.state or new.state not in ('returned', 'completed') then return new; end if;
  if new.state = 'completed' and not exists(select 1 from public.item_reservations where exchange_id = new.id) then return new; end if;
  if exists(select 1 from public.stalled_review_decisions s where s.exchange_id = new.id and s.outcome = 'verified_completion') then return new; end if;
  select * into r from public.item_returns where exchange_id = new.id;
  if not found or r.owner_confirmed_at is null or r.borrower_confirmed_at is null or r.contested_at is not null then
    raise exception using errcode = '55000', message = 'Both participants must confirm a matching Return condition.';
  end if;
  if exists(select 1 from public.disputes d where d.exchange_id = new.id and d.closed_at is null) then
    raise exception using errcode = '55000', message = 'An open Exchange issue blocks ordinary Return confirmation.';
  end if;
  return new;
end;
$$;

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
    or (old.state = 'returned' and new.state <> 'completed'
      and not (new.state = 'closed_without_completion' and exists(select 1 from public.stalled_review_decisions s
        where s.exchange_id = new.id and s.outcome = 'closed_without_completion'))) then
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

-- Unresolved item disputes leave the completion path and get their own review reason, so they cannot starve it.
create or replace function private.queue_item_return_review(p_exchange uuid, p_reason text) returns boolean
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
      and exists(select 1 from public.item_handoffs h where h.exchange_id = e.id and h.handed_off_at is not null))
    or (p_reason = 'unresolved_dispute' and e.state = 'returned' and exists(select 1 from public.disputes d
      where d.exchange_id = e.id and private.dispute_effective_outcome(d.id) = 'unresolved'))) then
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

-- The deadline worker finalizes completable Returns, then queues stalled ones. Rows already queued or under an open
-- or unresolved Exchange issue are excluded from selection, so a stuck case cannot consume the batch limit each minute.
create or replace function public.process_due_item_returns() returns jsonb language plpgsql security definer set search_path = '' as $$
declare due record; finalized integer := 0; queued integer := 0; settings public.item_return_settings;
begin
  select * into settings from public.item_return_settings;
  for due in select e.id, e.provider_id from public.exchanges e join public.item_returns r on r.exchange_id = e.id
    where e.state = 'returned' and not exists(select 1 from public.disputes d where d.exchange_id = e.id and (d.closed_at is null
      or private.dispute_effective_outcome(d.id) = 'unresolved'))
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
        and not exists(select 1 from public.exchange_review_items q where q.exchange_id = e.id and q.reason = 'overdue_return')
    union all select e.id, 'unresolved_dispute' from public.exchanges e join public.item_returns r on r.exchange_id = e.id
      where e.state = 'returned' and exists(select 1 from public.disputes d where d.exchange_id = e.id and private.dispute_effective_outcome(d.id) = 'unresolved')
        and not exists(select 1 from public.exchange_review_items q where q.exchange_id = e.id and q.reason = 'unresolved_dispute')) limit 100
  loop
    if private.queue_item_return_review(due.id, due.reason) then queued := queued + 1; end if;
  end loop;
  return jsonb_build_object('finalized', finalized, 'queued', queued);
end;
$$;

revoke all on function private.stalled_review_gaps(uuid, jsonb), private.stalled_review_view(uuid), private.guard_stalled_review_decision(),
  private.guard_stalled_item_recovery(), private.complete_item_exchange(uuid, uuid, uuid, text), private.complete_help_exchange(uuid, uuid, uuid, text),
  private.settle_exchange_completion(uuid, text), private.stalled_normal_path_ready(uuid)
  from public, anon, authenticated;
revoke all on function public.read_stalled_review(uuid), public.read_stalled_review_queue(uuid),
  public.decide_stalled_review(uuid, uuid, text, text, jsonb), public.record_stalled_item_recovery(uuid, uuid, text) from public, anon;
grant execute on function public.read_stalled_review(uuid), public.read_stalled_review_queue(uuid),
  public.decide_stalled_review(uuid, uuid, text, text, jsonb), public.record_stalled_item_recovery(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
