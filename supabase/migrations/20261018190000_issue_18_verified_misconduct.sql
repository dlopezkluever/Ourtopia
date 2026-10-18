create unique index reputation_events_correction_once on public.reputation_events(corrects_event_id) where corrects_event_id is not null;

create function public.record_verified_misconduct(
  p_intent_id uuid, p_dispute_id uuid, p_rule text, p_recipient_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); d public.disputes; e public.exchanges; points integer; event_id uuid; community_event uuid;
  payload jsonb := jsonb_build_object('dispute', p_dispute_id, 'rule', p_rule, 'recipient', p_recipient_id, 'reason', p_reason);
  prior jsonb;
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found or actor is null or not public.is_community_administrator(d.community_id) then
    raise exception using errcode = '42501', message = 'A current same-Community administrator is required.';
  end if;
  select * into e from public.exchanges where id = d.exchange_id for update;
  if actor in (e.provider_id, e.receiver_id) then
    raise exception using errcode = '42501', message = 'Exchange participants cannot verify misconduct in their own case.';
  end if;
  prior := private.borrow_intent(actor, p_intent_id, 'record_verified_misconduct', payload);
  if prior is not null then return prior; end if;
  if p_rule is null or p_rule not in ('late_return', 'unresolved_damage', 'confirmed_theft') or p_recipient_id is null or p_recipient_id not in (e.provider_id, e.receiver_id)
    or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Choose a case participant, a verified rule, and a reason of 1 to 1000 characters.';
  end if;
  if p_rule = 'late_return' and (e.kind <> 'item' or p_recipient_id <> e.receiver_id) then
    raise exception using errcode = '22023', message = 'A late return is recorded against the borrower of an item Exchange.';
  end if;
  if d.closed_at is null or private.dispute_effective_outcome(d.id) is distinct from 'unresolved' then
    raise exception using errcode = '55000', message = 'Misconduct can be verified only from a closed unresolved decision.';
  end if;
  if exists (select 1 from public.reputation_events where source_kind = 'dispute' and source_id = d.id and rule = p_rule and recipient_id = p_recipient_id) then
    raise exception using errcode = '23505', message = 'This verified rule already applies to this member for this decision.';
  end if;
  points := case p_rule when 'late_return' then -2 when 'unresolved_damage' then -10 else -30 end;
  insert into public.reputation_events(community_id, recipient_id, rule, points, source_kind, source_id, exchange_id,
    verified_by_command, verified_by, reason)
  values(d.community_id, p_recipient_id, p_rule, points, 'dispute', d.id, e.id, 'record_verified_misconduct', actor, btrim(p_reason))
  returning id into event_id;
  if p_rule = 'confirmed_theft' then
    insert into public.trust_incidents(community_id, subject_id, type, status, source_kind, source_id)
    values(d.community_id, p_recipient_id, 'serious_violation', 'confirmed', 'reputation_event', event_id);
  end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id)
  values(d.community_id, actor, 'misconduct_verified', p_intent_id) returning id into community_event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
  values(community_event, d.community_id, p_recipient_id, 'in_app', 'misconduct_verified');
  insert into public.notification_hints(recipient_id) values(p_recipient_id);
  prior := jsonb_build_object('eventId', event_id, 'points', points, 'rule', p_rule, 'recipientId', p_recipient_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result)
  values(actor, p_intent_id, 'record_verified_misconduct', payload, prior);
  return prior;
end;
$$;

create function public.correct_reputation_event(p_intent_id uuid, p_event_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); original public.reputation_events; correction_id uuid; community_event uuid; result jsonb;
  payload jsonb := jsonb_build_object('event', p_event_id, 'reason', p_reason);
begin
  select * into original from public.reputation_events where id = p_event_id for update;
  if not found or actor is null or not public.is_community_administrator(original.community_id) then
    raise exception using errcode = '42501', message = 'A current same-Community administrator is required.';
  end if;
  result := private.borrow_intent(actor, p_intent_id, 'correct_reputation_event', payload);
  if result is not null then return result; end if;
  if original.source_kind <> 'dispute' or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Choose a misconduct event and provide a correction reason of 1 to 1000 characters.';
  end if;
  if exists (select 1 from public.reputation_events where corrects_event_id = original.id) then
    raise exception using errcode = '55000', message = 'This verified event already has a linked correction.';
  end if;
  insert into public.reputation_events(community_id, recipient_id, rule, points, source_kind, source_id, exchange_id,
    verified_by_command, verified_by, corrects_event_id, reason)
  values(original.community_id, original.recipient_id, 'correction:' || p_intent_id::text, -original.points,
    'reputation_correction', p_intent_id, original.exchange_id, 'correct_reputation_event', actor, original.id, btrim(p_reason))
  returning id into correction_id;
  update public.trust_incidents set status = 'overturned'
    where type = 'serious_violation' and source_kind = 'reputation_event' and source_id = original.id;
  insert into public.community_events(community_id, actor_id, kind, intent_id)
  values(original.community_id, actor, 'reputation_corrected', p_intent_id) returning id into community_event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
  values(community_event, original.community_id, original.recipient_id, 'in_app', 'reputation_corrected');
  insert into public.notification_hints(recipient_id) values(original.recipient_id);
  result := jsonb_build_object('eventId', correction_id, 'correctsEventId', original.id, 'points', -original.points);
  insert into public.command_intents(actor_id, intent_id, command, payload, result)
  values(actor, p_intent_id, 'correct_reputation_event', payload, result);
  return result;
end;
$$;

revoke all on function public.record_verified_misconduct(uuid, uuid, text, uuid, text), public.correct_reputation_event(uuid, uuid, text) from public, anon;
grant execute on function public.record_verified_misconduct(uuid, uuid, text, uuid, text), public.correct_reputation_event(uuid, uuid, text) to authenticated;
