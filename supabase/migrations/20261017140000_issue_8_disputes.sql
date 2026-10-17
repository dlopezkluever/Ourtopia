create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  reporter_id uuid not null references auth.users(id),
  respondent_id uuid not null references auth.users(id),
  issue_type text not null check (issue_type in ('damage', 'missing_item', 'other')),
  status text not null default 'issue_reported' check (status in ('issue_reported', 'repairing', 'replacement_agreed', 'disputed', 'admin_review', 'resolved', 'unresolved')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check (reporter_id <> respondent_id),
  check ((closed_at is null) = (status not in ('resolved', 'unresolved')))
);
create unique index dispute_one_open_issue on public.disputes(exchange_id, issue_type) where closed_at is null;
create table public.dispute_responses (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes(id),
  author_id uuid not null references auth.users(id),
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index dispute_responses_history on public.dispute_responses(dispute_id, created_at);
create trigger dispute_responses_append_only before update or delete on public.dispute_responses
  for each row execute function private.reject_history_rewrite();
create function private.guard_dispute_record() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception using errcode = '42501', message = 'Case history is retained.'; end if;
  if not exists(select 1 from public.exchanges e where e.id = new.exchange_id and e.community_id = new.community_id
    and new.reporter_id in (e.provider_id, e.receiver_id) and new.respondent_id in (e.provider_id, e.receiver_id)) then
    raise exception using errcode = '23514', message = 'Case identity must match its Exchange participants and Community.';
  end if;
  if tg_op = 'UPDATE' then
    if (new.id, new.exchange_id, new.community_id, new.reporter_id, new.respondent_id, new.issue_type, new.created_at)
      is distinct from (old.id, old.exchange_id, old.community_id, old.reporter_id, old.respondent_id, old.issue_type, old.created_at) then
      raise exception using errcode = '42501', message = 'Case identity is immutable.';
    end if;
    if old.closed_at is not null and (new.status, new.closed_at) is distinct from (old.status, old.closed_at) then
      raise exception using errcode = '55000', message = 'A closed case cannot reopen.';
    end if;
  end if;
  return new;
end;
$$;
create trigger dispute_record_integrity before insert or update or delete on public.disputes
  for each row execute function private.guard_dispute_record();
create function private.guard_dispute_response() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.disputes d where d.id = new.dispute_id and new.author_id in (d.reporter_id, d.respondent_id)) then
    raise exception using errcode = '23514', message = 'Only case participants submit responses.';
  end if;
  return new;
end;
$$;
create trigger dispute_response_author before insert on public.dispute_responses
  for each row execute function private.guard_dispute_response();

-- Completion time belongs to fulfillment and is never reset by opening a case.
alter table public.exchanges add column completed_at timestamptz;
update public.exchanges e set completed_at = coalesce((select min(v.created_at) from public.exchange_events v
  where v.exchange_id = e.id and v.kind = 'completion_settled'), e.created_at) where state = 'completed';
create function private.guard_disputed_completion() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.completed_at is not null and new.completed_at is distinct from old.completed_at then
    raise exception using errcode = '42501', message = 'Original completion time is immutable.';
  end if;
  if new.state = 'completed' and (tg_op = 'INSERT' or old.state <> 'completed') then
    if exists(select 1 from public.disputes where exchange_id = new.id and closed_at is null) then
      raise exception using errcode = '55000', message = 'An open Dispute blocks ordinary completion.';
    end if;
    new.completed_at := coalesce(new.completed_at, clock_timestamp());
  end if;
  return new;
end;
$$;
create trigger dispute_completion_guard before insert or update on public.exchanges
  for each row execute function private.guard_disputed_completion();

create function private.dispute_reporting_window(p_state text, p_completed timestamptz, p_now timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select p_state in ('approved', 'handoff_pending', 'checked_out', 'return_pending', 'returned', 'committed', 'scheduled', 'completion_pending')
    or (p_state = 'completed' and p_completed is not null and p_now <= p_completed + interval '720 hours');
$$;
create or replace function public.can_read_exchange(p_exchange_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.exchanges e where e.id = p_exchange_id
    and auth.uid() in (e.provider_id, e.receiver_id)
    and (public.is_active_member(e.community_id) or (exists(select 1 from public.memberships m
      where m.community_id = e.community_id and m.user_id = auth.uid() and m.status in ('suspended', 'removed'))
      and (private.dispute_reporting_window(e.state, e.completed_at, statement_timestamp())
        or exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null)))));
$$;
create function public.can_read_dispute(p_dispute_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.disputes d where d.id = p_dispute_id
    and (public.can_read_exchange(d.exchange_id) or public.is_community_administrator(d.community_id)));
$$;
revoke all on function public.can_read_dispute(uuid) from public, anon;
grant execute on function public.can_read_dispute(uuid) to authenticated;
alter table public.disputes enable row level security;
alter table public.dispute_responses enable row level security;
revoke all on public.disputes, public.dispute_responses from anon, authenticated;
grant select on public.disputes, public.dispute_responses to authenticated;
create policy dispute_read on public.disputes for select to authenticated using (public.can_read_dispute(id));
create policy dispute_response_read on public.dispute_responses for select to authenticated using (public.can_read_dispute(dispute_id));

alter table public.notification_outbox add column dispute_id uuid references public.disputes(id);
create function private.record_dispute_activity(p_dispute uuid, p_actor uuid, p_intent uuid, p_kind text, p_recipients uuid[])
returns void language plpgsql set search_path = '' as $$
declare community uuid;
begin
  select community_id into community from public.disputes where id = p_dispute;
  perform private.record_borrow_activity(community, p_actor, p_intent, p_kind, p_recipients);
  update public.notification_outbox set dispute_id = p_dispute where event_id in (
    select id from public.community_events where community_id = community and actor_id = p_actor and intent_id = p_intent and kind = p_kind);
end;
$$;
drop policy outbox_status_read on public.notification_outbox;
create policy outbox_status_read on public.notification_outbox for select to authenticated using (
  case when kind like 'item_dispute\_%' then recipient_id = auth.uid() and public.can_read_dispute(dispute_id)
    when kind in ('conversation_started', 'message_sent') then recipient_id = auth.uid() and public.is_active_member(community_id)
    when kind like 'item\_%' then recipient_id = auth.uid()
    else recipient_id = auth.uid() or public.is_community_administrator(community_id) end);
drop policy notice_recipient on public.notifications;
create policy notice_recipient on public.notifications for select to authenticated using (
  recipient_id = auth.uid() and (kind not like 'item_dispute\_%' or exists(select 1 from public.notification_outbox o where o.id = outbox_id)));

-- The delivery worker also drops pending case notices after the recipient loses case access.
create or replace function private.reminder_current(p_notice public.notification_outbox)
returns boolean language plpgsql set search_path = '' as $$
declare reminder public.notification_reminders;
begin
  if p_notice.kind like 'item_dispute\_%' and not exists(
    select 1 from public.disputes d join public.exchanges e on e.id = d.exchange_id
      join public.memberships m on m.community_id = d.community_id and m.user_id = p_notice.recipient_id
    where d.id = p_notice.dispute_id and ((m.status = 'active' and m.role = 'administrator')
      or (p_notice.recipient_id in (e.provider_id, e.receiver_id) and (m.status = 'active'
        or (m.status in ('suspended', 'removed') and (d.closed_at is null or private.dispute_reporting_window(e.state, e.completed_at, clock_timestamp()))))))) then
    return false;
  end if;
  if p_notice.reminder_id is null then return true; end if;
  select * into reminder from public.notification_reminders where id = p_notice.reminder_id for share;
  return found and reminder.event_id = p_notice.event_id and reminder.due_at = p_notice.reminder_due_at;
end;
$$;

create function public.read_exchange_disputes(p_exchange_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e public.exchanges;
begin
  select * into e from public.exchanges where id = p_exchange_id;
  if not found or not (public.can_read_exchange(e.id) or (public.is_community_administrator(e.community_id)
    and exists(select 1 from public.disputes where exchange_id = e.id))) then
    raise exception using errcode = '42501', message = 'Case unavailable.';
  end if;
  return jsonb_build_object('exchange_id', e.id, 'state', e.state, 'completed_at', e.completed_at,
    'participant', auth.uid() in (e.provider_id, e.receiver_id),
    'can_report', public.can_read_exchange(e.id) and private.dispute_reporting_window(e.state, e.completed_at, statement_timestamp()),
    'cases', coalesce((select jsonb_agg(to_jsonb(d) || jsonb_build_object(
      'responses', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from public.dispute_responses r where r.dispute_id = d.id), '[]'::jsonb),
      'evidence', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at, v.id) from public.exchange_evidence v
        where v.dispute_id = d.id and (v.state = 'ready' or v.uploader_id = auth.uid())), '[]'::jsonb)) order by d.created_at, d.id)
      from public.disputes d where d.exchange_id = e.id), '[]'::jsonb));
end;
$$;

-- Keep the existing private bucket and evidence lifecycle. Only deliberately submitted case photos gain administrator access.
alter table public.exchange_evidence drop constraint exchange_evidence_purpose_check;
alter table public.exchange_evidence add column dispute_id uuid references public.disputes(id);
alter table public.exchange_evidence add constraint exchange_evidence_purpose_check
  check ((purpose = 'handoff' and dispute_id is null) or (purpose = 'dispute' and dispute_id is not null));
create function private.guard_dispute_evidence() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.dispute_id is distinct from old.dispute_id then
    raise exception using errcode = '42501', message = 'Evidence case identity is immutable.';
  end if;
  if new.dispute_id is not null and not exists(select 1 from public.disputes d
    where d.id = new.dispute_id and d.exchange_id = new.exchange_id and d.community_id = new.community_id
      and new.uploader_id in (d.reporter_id, d.respondent_id)) then
    raise exception using errcode = '23514', message = 'Evidence must belong to its case and participant.';
  end if;
  return new;
end;
$$;
create trigger dispute_evidence_integrity before insert or update on public.exchange_evidence
  for each row execute function private.guard_dispute_evidence();
drop policy evidence_read on public.exchange_evidence;
create policy evidence_read on public.exchange_evidence for select to authenticated using (
  (case when dispute_id is null then public.can_read_exchange(exchange_id) else public.can_read_dispute(dispute_id) end)
    and (state = 'ready' or uploader_id = auth.uid()));
create or replace function public.can_access_exchange_evidence(p_path text, p_upload boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.exchange_evidence v join public.exchanges e on e.id = v.exchange_id
    left join public.disputes d on d.id = v.dispute_id where v.object_path = p_path
    and case when p_upload then v.uploader_id = auth.uid() and v.state = 'pending' and public.can_read_exchange(e.id)
      and case when v.dispute_id is null then e.state in ('handoff_pending', 'checked_out') else d.closed_at is null end
    else (case when v.dispute_id is null then public.can_read_exchange(e.id) else public.can_read_dispute(d.id) end)
      and (v.state = 'ready' or v.uploader_id = auth.uid()) end);
$$;

create function public.report_exchange_issue(p_intent_id uuid, p_exchange_id uuid, p_issue_type text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; d public.disputes; outcome jsonb; recipients uuid[]; opened boolean := false;
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'type', p_issue_type, 'body', p_body);
begin
  if not public.can_read_exchange(p_exchange_id) then raise exception using errcode = '42501', message = 'Exchange unavailable.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'report_exchange_issue', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  if not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Exchange unavailable.'; end if;
  if not private.dispute_reporting_window(e.state, e.completed_at, clock_timestamp()) then
    raise exception using errcode = '22023', message = 'The original 30-day reporting window has ended.';
  end if;
  if p_issue_type is null or p_issue_type not in ('damage', 'missing_item', 'other') or p_body is null or length(btrim(p_body)) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'Choose an issue type and describe the problem in 1 to 4000 characters.';
  end if;
  select * into d from public.disputes where exchange_id = e.id and issue_type = p_issue_type and closed_at is null for update;
  if not found then
    insert into public.disputes(exchange_id, community_id, reporter_id, respondent_id, issue_type)
      values(e.id, e.community_id, actor, case when actor = e.provider_id then e.receiver_id else e.provider_id end) returning * into d;
    insert into public.trust_incidents(community_id, subject_id, type, status, source_kind, source_id)
      select e.community_id, subject, 'unresolved_dispute', 'open', 'dispute', d.id from unnest(array[e.provider_id, e.receiver_id]) subject;
    opened := true;
  end if;
  insert into public.dispute_responses(dispute_id, author_id, body) values(d.id, actor, p_body);
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id)
    values(e.id, e.community_id, case when opened then 'issue_reported' else 'issue_response_added' end, actor);
  select array_agg(distinct recipient) into recipients from (
    select case when actor = e.provider_id then e.receiver_id else e.provider_id end as recipient
    union select user_id from public.memberships where community_id = e.community_id and role = 'administrator' and status = 'active' and user_id <> actor
  ) r;
  perform private.record_dispute_activity(d.id, actor, p_intent_id,
    case when opened then 'item_dispute_opened' else 'item_dispute_response' end, recipients);
  insert into public.notification_hints(recipient_id) values(actor);
  outcome := to_jsonb(d);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'report_exchange_issue', payload, outcome);
  return outcome;
end;
$$;
create function public.respond_to_dispute(p_intent_id uuid, p_dispute_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; d public.disputes; response public.dispute_responses; outcome jsonb; recipients uuid[];
  payload jsonb := jsonb_build_object('dispute', p_dispute_id, 'body', p_body);
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found or actor is null or actor not in (d.reporter_id, d.respondent_id) or not public.can_read_exchange(d.exchange_id) then
    raise exception using errcode = '42501', message = 'Case unavailable.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'respond_to_dispute', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = d.exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  select * into d from public.disputes where id = p_dispute_id for update;
  if not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Case unavailable.'; end if;
  if d.closed_at is not null then raise exception using errcode = '55000', message = 'This case is closed.'; end if;
  if p_body is null or length(btrim(p_body)) not between 1 and 4000 then raise exception using errcode = '22023', message = 'Enter a response in 1 to 4000 characters.'; end if;
  insert into public.dispute_responses(dispute_id, author_id, body) values(d.id, actor, p_body) returning * into response;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'issue_response_added', actor);
  select array_agg(distinct recipient) into recipients from (
    select case when actor = e.provider_id then e.receiver_id else e.provider_id end as recipient
    union select user_id from public.memberships where community_id = e.community_id and role = 'administrator' and status = 'active' and user_id <> actor
  ) r;
  perform private.record_dispute_activity(d.id, actor, p_intent_id, 'item_dispute_response', recipients);
  insert into public.notification_hints(recipient_id) values(actor);
  outcome := to_jsonb(response);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'respond_to_dispute', payload, outcome);
  return outcome;
end;
$$;

create function public.prepare_dispute_evidence(p_intent_id uuid, p_dispute_id uuid, p_evidence_id uuid, p_mime_type text, p_byte_size integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); d public.disputes; e public.exchanges; v public.exchange_evidence; outcome jsonb;
  payload jsonb := jsonb_build_object('dispute', p_dispute_id, 'evidence', p_evidence_id, 'mime', p_mime_type, 'size', p_byte_size);
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found or actor is null or actor not in (d.reporter_id, d.respondent_id) or not public.can_read_exchange(d.exchange_id) then
    raise exception using errcode = '42501', message = 'Case unavailable.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'prepare_dispute_evidence', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = d.exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  select * into d from public.disputes where id = p_dispute_id for update;
  if not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Case unavailable.'; end if;
  if d.closed_at is not null then raise exception using errcode = '55000', message = 'This case is closed.'; end if;
  if (select count(*) from public.exchange_evidence where dispute_id = d.id and uploader_id = actor) >= 8 then
    raise exception using errcode = '22023', message = 'Up to eight case photos per participant are allowed.';
  end if;
  insert into public.exchange_evidence(id, exchange_id, community_id, uploader_id, purpose, dispute_id, object_path, mime_type, byte_size)
    values(p_evidence_id, e.id, e.community_id, actor, 'dispute', d.id, e.id::text || '/' || p_evidence_id::text, p_mime_type, p_byte_size) returning * into v;
  outcome := to_jsonb(v);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'prepare_dispute_evidence', payload, outcome);
  return outcome;
end;
$$;

-- Retain the upstream completion implementation for Handoff photos.
alter function public.complete_exchange_evidence(uuid, uuid) rename to complete_handoff_evidence;
revoke all on function public.complete_handoff_evidence(uuid, uuid) from public, anon, authenticated;
create function public.complete_exchange_evidence(p_intent_id uuid, p_evidence_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; v public.exchange_evidence; d public.disputes; outcome jsonb; recipients uuid[];
  payload jsonb := jsonb_build_object('evidence', p_evidence_id);
begin
  select * into v from public.exchange_evidence where id = p_evidence_id;
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

drop policy event_read on public.community_events;
create policy event_read on public.community_events for select to authenticated using (
  public.is_active_member(community_id) and kind not like 'item\_%' and kind not like 'issue\_%'
  and kind not in ('conversation_started', 'message_sent', 'help_commitment_offered', 'help_commitment_accepted',
    'help_scheduled', 'help_cancelled', 'test_billing_requested', 'borrow_requested', 'borrow_approved', 'borrow_rejected', 'borrow_expired'));
drop policy trust_incident_read on public.trust_incidents;
create policy trust_incident_read on public.trust_incidents for select to authenticated using (
  case when source_kind = 'dispute' then public.can_read_dispute(source_id)
  else subject_id = auth.uid() or (public.is_active_member(community_id) and exists(select 1 from public.memberships m
    where m.community_id = trust_incidents.community_id and m.user_id = subject_id and m.status = 'active')) end);
create trigger dispute_audit_append_only before update or delete on public.community_events
  for each row when (old.kind like 'issue\_%') execute function private.reject_history_rewrite();
revoke all on function private.guard_disputed_completion(), private.dispute_reporting_window(text, timestamptz, timestamptz),
  private.guard_dispute_evidence(), private.guard_dispute_record(), private.guard_dispute_response(),
  private.record_dispute_activity(uuid, uuid, uuid, text, uuid[]) from public, anon, authenticated;
revoke all on function public.report_exchange_issue(uuid, uuid, text, text), public.respond_to_dispute(uuid, uuid, text),
  public.prepare_dispute_evidence(uuid, uuid, uuid, text, integer), public.complete_exchange_evidence(uuid, uuid) from public, anon;
grant execute on function public.report_exchange_issue(uuid, uuid, text, text), public.respond_to_dispute(uuid, uuid, text),
  public.prepare_dispute_evidence(uuid, uuid, uuid, text, integer), public.complete_exchange_evidence(uuid, uuid) to authenticated;
revoke all on function public.read_exchange_disputes(uuid) from public, anon;
grant execute on function public.read_exchange_disputes(uuid) to authenticated;
notify pgrst, 'reload schema';
