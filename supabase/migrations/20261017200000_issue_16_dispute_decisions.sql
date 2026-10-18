create table public.dispute_actions (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes(id),
  community_id uuid not null references public.communities(id),
  actor_id uuid not null references auth.users(id),
  action text not null check (action in ('remedy_proposed', 'remedy_agreed', 'settlement_confirmed', 'review_requested',
    'review_opened', 'outcome_recorded', 'outcome_corrected', 'item_recovered')),
  from_status text not null,
  to_status text not null,
  remedy_kind text check (remedy_kind in ('repair', 'replacement', 'no_compensation', 'other')),
  remedy_id uuid references public.dispute_actions(id),
  outcome text check (outcome in ('resolved', 'unresolved')),
  body text check (body is null or length(btrim(body)) between 1 and 4000),
  corrects_id uuid references public.dispute_actions(id),
  created_at timestamptz not null default clock_timestamp(),
  check (case action
    when 'remedy_proposed' then remedy_kind is not null and body is not null and remedy_id is null
    when 'remedy_agreed' then remedy_id is not null
    when 'settlement_confirmed' then remedy_id is not null
    when 'review_requested' then body is not null
    when 'outcome_recorded' then outcome is not null and (body is not null or remedy_id is not null)
    when 'outcome_corrected' then outcome is not null and body is not null and corrects_id is not null
    when 'item_recovered' then body is not null
    else true end)
);
create index dispute_actions_history on public.dispute_actions(dispute_id, created_at);
create unique index dispute_remedy_agreed_once on public.dispute_actions(remedy_id) where action = 'remedy_agreed';
create unique index dispute_settlement_confirmed_once on public.dispute_actions(remedy_id, actor_id) where action = 'settlement_confirmed';
create unique index dispute_one_outcome on public.dispute_actions(dispute_id) where action = 'outcome_recorded';
create unique index dispute_correction_once on public.dispute_actions(corrects_id) where action = 'outcome_corrected';
create trigger dispute_actions_append_only before update or delete on public.dispute_actions
  for each row execute function private.reject_history_rewrite();
create function private.guard_dispute_action() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.disputes d where d.id = new.dispute_id and d.community_id = new.community_id) then
    raise exception using errcode = '23514', message = 'Case actions must match their case Community.';
  end if;
  if exists(select 1 from public.dispute_actions a where a.id in (new.remedy_id, new.corrects_id) and a.dispute_id <> new.dispute_id) then
    raise exception using errcode = '23514', message = 'Linked case actions must belong to the same case.';
  end if;
  return new;
end;
$$;
create trigger dispute_action_integrity before insert on public.dispute_actions
  for each row execute function private.guard_dispute_action();
alter table public.dispute_actions enable row level security;
revoke all on public.dispute_actions from anon, authenticated;
grant select on public.dispute_actions to authenticated;
create policy dispute_action_read on public.dispute_actions for select to authenticated using (public.can_read_dispute(dispute_id));

create function private.dispute_action_allowed(p_dispute uuid, p_action text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare d public.disputes; e public.exchanges; remedy public.dispute_actions; agreed boolean; participant boolean; adjudicator boolean; is_open boolean;
  settling boolean;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found or auth.uid() is null then return false; end if;
  select * into e from public.exchanges where id = d.exchange_id;
  participant := auth.uid() in (d.reporter_id, d.respondent_id) and public.can_read_exchange(e.id);
  adjudicator := auth.uid() not in (e.provider_id, e.receiver_id) and public.is_community_administrator(d.community_id);
  is_open := d.closed_at is null;
  settling := is_open and d.status in ('issue_reported', 'repairing', 'replacement_agreed');
  select * into remedy from public.dispute_actions where dispute_id = d.id and action = 'remedy_proposed' order by created_at desc, id desc limit 1;
  agreed := remedy.id is not null and exists(select 1 from public.dispute_actions where remedy_id = remedy.id and action = 'remedy_agreed');
  return coalesce(case p_action
    when 'propose_remedy' then participant and settling
    when 'agree_remedy' then participant and settling and remedy.id is not null and not agreed and remedy.actor_id <> auth.uid()
    when 'confirm_settlement' then participant and settling and agreed and not exists(select 1 from public.dispute_actions
      where remedy_id = remedy.id and action = 'settlement_confirmed' and actor_id = auth.uid())
    when 'request_review' then participant and is_open and d.status in ('issue_reported', 'repairing')
    when 'open_review' then adjudicator and is_open and d.status in ('disputed', 'issue_reported', 'replacement_agreed')
    when 'decide' then adjudicator and is_open and d.status = 'admin_review'
    when 'correct_outcome' then adjudicator and not is_open
    when 'record_recovery' then adjudicator and e.kind = 'item' and exists(select 1 from public.item_reservations r
      where r.exchange_id = e.id and r.custody_unresolved)
    else false end, false);
end;
$$;

create function private.dispute_case_view(p_dispute uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d public.disputes; remedy public.dispute_actions; outcome public.dispute_actions;
begin
  select * into d from public.disputes where id = p_dispute;
  select * into remedy from public.dispute_actions where dispute_id = d.id and action = 'remedy_proposed' order by created_at desc, id desc limit 1;
  select * into outcome from public.dispute_actions where dispute_id = d.id and action in ('outcome_recorded', 'outcome_corrected')
    order by created_at desc, id desc limit 1;
  return jsonb_build_object('id', d.id, 'exchange_id', d.exchange_id, 'issue_type', d.issue_type, 'status', d.status,
    'reporter_id', d.reporter_id, 'respondent_id', d.respondent_id, 'created_at', d.created_at, 'closed_at', d.closed_at,
    'remedy', case when remedy.id is null then null else jsonb_build_object('id', remedy.id, 'kind', remedy.remedy_kind, 'terms', remedy.body,
      'proposer_id', remedy.actor_id, 'created_at', remedy.created_at,
      'agreed', exists(select 1 from public.dispute_actions where remedy_id = remedy.id and action = 'remedy_agreed'),
      'confirmed_by', coalesce((select jsonb_agg(actor_id order by created_at) from public.dispute_actions
        where remedy_id = remedy.id and action = 'settlement_confirmed'), '[]'::jsonb)) end,
    'outcome', case when outcome.id is null then null else jsonb_build_object('outcome', outcome.outcome, 'reason', outcome.body,
      'actor_id', outcome.actor_id, 'created_at', outcome.created_at, 'corrected', outcome.action = 'outcome_corrected', 'action_id', outcome.id) end,
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'actor_id', a.actor_id, 'from_status', a.from_status,
      'to_status', a.to_status, 'remedy_kind', a.remedy_kind, 'remedy_id', a.remedy_id, 'outcome', a.outcome, 'body', a.body,
      'corrects_id', a.corrects_id, 'created_at', a.created_at) order by a.created_at, a.id)
      from public.dispute_actions a where a.dispute_id = d.id), '[]'::jsonb),
    'next_actions', to_jsonb(array(select action from unnest(array['propose_remedy', 'agree_remedy', 'confirm_settlement', 'request_review',
      'open_review', 'decide', 'correct_outcome', 'record_recovery']) action where private.dispute_action_allowed(d.id, action))));
end;
$$;

create function public.read_dispute_decisions(p_exchange_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  declare e public.exchanges; h public.item_handoffs; r public.item_reservations; ret public.item_returns;
begin
  select * into e from public.exchanges where id = p_exchange_id;
  if not found or not (public.can_read_exchange(e.id) or (public.is_community_administrator(e.community_id)
    and exists(select 1 from public.disputes where exchange_id = e.id))) then
    raise exception using errcode = '42501', message = 'Case unavailable.';
  end if;
  select * into h from public.item_handoffs where exchange_id = e.id;
  select * into r from public.item_reservations where exchange_id = e.id;
  select * into ret from public.item_returns where exchange_id = e.id;
  return jsonb_build_object('exchange_id', e.id, 'kind', e.kind, 'state', e.state, 'completed_at', e.completed_at,
    'provider_id', e.provider_id, 'receiver_id', e.receiver_id, 'participant', auth.uid() in (e.provider_id, e.receiver_id),
    'records', jsonb_build_object(
      'handoff', case when h.exchange_id is null then null else jsonb_build_object('condition', h.condition, 'accessories', h.accessories,
        'handed_off_at', h.handed_off_at) end,
      'reservation', case when r.exchange_id is null then null else jsonb_build_object('starts_on', r.starts_on, 'ends_on', r.ends_on,
        'condition', r.condition, 'replacement_value', r.replacement_value, 'custody_unresolved', r.custody_unresolved, 'blocking', r.blocking) end,
      'return', case when ret.exchange_id is null then null else jsonb_build_object('returned_at', ret.returned_at, 'condition', ret.condition,
        'accessories', ret.accessories, 'recorded_by', ret.recorded_by, 'owner_confirmed_at', ret.owner_confirmed_at,
        'borrower_confirmed_at', ret.borrower_confirmed_at, 'contested_by', ret.contested_by, 'contested_at', ret.contested_at,
        'contested_condition', ret.contested_condition) end,
      'events', coalesce((select jsonb_agg(jsonb_build_object('kind', v.kind, 'actor_id', v.actor_id, 'created_at', v.created_at) order by v.created_at, v.id)
        from public.exchange_events v where v.exchange_id = e.id), '[]'::jsonb)),
    'cases', coalesce((select jsonb_agg(private.dispute_case_view(d.id) order by d.created_at, d.id)
      from public.disputes d where d.exchange_id = e.id), '[]'::jsonb));
end;
$$;

create function public.act_on_dispute(p_intent_id uuid, p_dispute_id uuid, p_action text, p_details jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); d public.disputes; e public.exchanges; remedy public.dispute_actions; prior public.dispute_actions;
  payload jsonb := jsonb_build_object('dispute', p_dispute_id, 'action', p_action, 'details', p_details);
  outcome jsonb; participant_action boolean := p_action in ('propose_remedy', 'agree_remedy', 'confirm_settlement', 'request_review');
  next_status text; recorded text; text_body text; chosen text; notice text; recipients uuid[]; counterparty uuid; closing text;
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found or actor is null or not ((actor in (d.reporter_id, d.respondent_id) and public.can_read_exchange(d.exchange_id))
    or public.is_community_administrator(d.community_id)) then
    raise exception using errcode = '42501', message = 'Case unavailable.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'act_on_dispute', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = d.exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  select * into d from public.disputes where id = p_dispute_id for update;
  if p_action is null or p_action not in ('propose_remedy', 'agree_remedy', 'confirm_settlement', 'request_review',
    'open_review', 'decide', 'correct_outcome', 'record_recovery') then
    raise exception using errcode = '22023', message = 'Unknown case action.';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then raise exception using errcode = '22023', message = 'Case action details are required.'; end if;
  if participant_action and not (actor in (d.reporter_id, d.respondent_id) and public.can_read_exchange(e.id)) then
    raise exception using errcode = '42501', message = 'Only case participants agree to remedies, confirm settlement or request review.';
  end if;
  if not participant_action and (actor in (e.provider_id, e.receiver_id) or not public.is_community_administrator(d.community_id)) then
    raise exception using errcode = '42501', message = 'Only an active same-Community administrator who is not a participant adjudicates this case.';
  end if;
  if p_action = 'record_recovery' and e.kind <> 'item' then
    raise exception using errcode = '22023', message = 'Help Exchanges have no item custody to recover.';
  end if;
  if not private.dispute_action_allowed(d.id, p_action) then
    raise exception using errcode = '55000', message = 'This case changed. Refresh before continuing.';
  end if;
  text_body := nullif(btrim(coalesce(p_details->>'reason', p_details->>'terms', p_details->>'note', '')), '');
  if text_body is not null and length(text_body) > 4000 then raise exception using errcode = '22023', message = 'Keep case text within 4000 characters.'; end if;
  counterparty := case when actor = d.reporter_id then d.respondent_id else d.reporter_id end;
  next_status := d.status;
  select * into remedy from public.dispute_actions where dispute_id = d.id and action = 'remedy_proposed' order by created_at desc, id desc limit 1;

  if p_action = 'propose_remedy' then
    chosen := p_details->>'kind';
    if chosen is null or chosen not in ('repair', 'replacement', 'no_compensation', 'other') or text_body is null then
      raise exception using errcode = '22023', message = 'Choose a remedy and describe its terms.';
    end if;
    insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, remedy_kind, body)
      values(d.id, d.community_id, actor, 'remedy_proposed', d.status, d.status, chosen, text_body);
    recorded := 'remedy_proposed'; notice := 'item_dispute_remedy'; recipients := array[counterparty];
  elsif p_action in ('agree_remedy', 'confirm_settlement') then
    if p_details->>'remedy_id' is distinct from remedy.id::text then
      raise exception using errcode = '55000', message = 'This remedy was replaced. Refresh before continuing.';
    end if;
    if p_action = 'agree_remedy' then
      next_status := case remedy.remedy_kind when 'repair' then 'repairing' when 'replacement' then 'replacement_agreed' else d.status end;
      recorded := 'remedy_agreed';
    else recorded := 'settlement_confirmed';
    end if;
    insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, remedy_id)
      values(d.id, d.community_id, actor, recorded, d.status, next_status, remedy.id);
    notice := 'item_dispute_remedy'; recipients := array[counterparty];
    if p_action = 'confirm_settlement' and (select count(*) from public.dispute_actions
      where remedy_id = remedy.id and action = 'settlement_confirmed') = 2 then
      next_status := 'resolved'; closing := 'resolved'; notice := 'item_dispute_outcome';
      insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, remedy_id, outcome)
        values(d.id, d.community_id, actor, 'outcome_recorded', d.status, 'resolved', remedy.id, 'resolved');
    end if;
  elsif p_action = 'request_review' then
    if text_body is null then raise exception using errcode = '22023', message = 'Explain why the case needs administrator review.'; end if;
    next_status := 'disputed';
    insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, body)
      values(d.id, d.community_id, actor, 'review_requested', d.status, next_status, text_body);
    recorded := 'review_requested'; notice := 'item_dispute_review';
    select array_agg(distinct recipient) into recipients from (select counterparty as recipient union
      select user_id from public.memberships where community_id = d.community_id and role = 'administrator' and status = 'active'
        and user_id not in (e.provider_id, e.receiver_id)) r;
  elsif p_action = 'open_review' then
    if d.status = 'replacement_agreed' and text_body is null then
      raise exception using errcode = '22023', message = 'Explain how the agreed replacement stalled.';
    end if;
    next_status := 'admin_review';
    insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, body)
      values(d.id, d.community_id, actor, 'review_opened', d.status, next_status, text_body);
    recorded := 'review_opened'; notice := 'item_dispute_review'; recipients := array[d.reporter_id, d.respondent_id];
  elsif p_action in ('decide', 'correct_outcome') then
    chosen := p_details->>'outcome';
    if chosen is null or chosen not in ('resolved', 'unresolved') or text_body is null then
      raise exception using errcode = '22023', message = 'Choose resolved or unresolved and record the reason for this outcome.';
    end if;
    notice := 'item_dispute_outcome'; recipients := array[d.reporter_id, d.respondent_id]; closing := chosen;
    if p_action = 'decide' then
      next_status := chosen; recorded := 'outcome_recorded';
      insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, outcome, body)
        values(d.id, d.community_id, actor, recorded, d.status, chosen, chosen, text_body);
    else
      select * into prior from public.dispute_actions where dispute_id = d.id and action in ('outcome_recorded', 'outcome_corrected')
        order by created_at desc, id desc limit 1;
      if prior.outcome = chosen then raise exception using errcode = '22023', message = 'A correction must change the recorded outcome.'; end if;
      recorded := 'outcome_corrected';
      insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, outcome, body, corrects_id)
        values(d.id, d.community_id, actor, recorded, d.status, d.status, chosen, text_body, prior.id);
    end if;
  else
    if text_body is null then raise exception using errcode = '22023', message = 'Record how the owner recovered the item.'; end if;
    if e.state in ('checked_out', 'return_pending') then
      update public.exchanges set state = 'closed_without_completion' where id = e.id;
    end if;
    update public.item_reservations set custody_unresolved = false where exchange_id = e.id;
    insert into public.dispute_actions(dispute_id, community_id, actor_id, action, from_status, to_status, body)
      values(d.id, d.community_id, actor, 'item_recovered', d.status, d.status, text_body);
    recorded := 'item_recovered'; notice := 'item_dispute_recovery'; recipients := array[d.reporter_id, d.respondent_id];
  end if;

  if next_status in ('resolved', 'unresolved') and d.closed_at is null then
    update public.disputes set status = next_status, closed_at = clock_timestamp() where id = d.id;
  elsif next_status <> d.status then
    update public.disputes set status = next_status where id = d.id;
  end if;
  if closing is not null then
    update public.trust_incidents set status = closing where source_kind = 'dispute' and source_id = d.id;
  end if;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'issue_' || recorded, actor);
  if closing is not null and recorded = 'settlement_confirmed' then
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'issue_outcome_recorded', actor);
  end if;
  perform private.record_dispute_activity(d.id, actor, p_intent_id, notice, recipients);
  insert into public.notification_hints(recipient_id) values(actor);
  outcome := private.dispute_case_view(d.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'act_on_dispute', payload, outcome);
  return outcome;
end;
$$;

create or replace function private.finalize_item_exchange(p_exchange uuid, p_actor uuid, p_intent uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; r public.item_returns; h public.item_handoffs; event uuid;
begin
  select * into e from public.exchanges where id = p_exchange and kind = 'item' for update;
  select * into r from public.item_returns where exchange_id = e.id;
  select * into h from public.item_handoffs where exchange_id = e.id;
  if e.state is distinct from 'returned' or h.handed_off_at is null or r.exchange_id is null or r.owner_confirmed_at is null
    or r.borrower_confirmed_at is null or r.contested_at is not null
    or exists(select 1 from public.disputes d where d.exchange_id = e.id and (d.closed_at is null or d.status = 'unresolved')) then
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

revoke all on function private.guard_dispute_action(), private.dispute_action_allowed(uuid, text), private.dispute_case_view(uuid)
  from public, anon, authenticated;
revoke all on function public.read_dispute_decisions(uuid), public.act_on_dispute(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.read_dispute_decisions(uuid), public.act_on_dispute(uuid, uuid, text, jsonb) to authenticated;
notify pgrst, 'reload schema';
