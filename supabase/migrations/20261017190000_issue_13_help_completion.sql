create table public.help_completions (
  exchange_id uuid primary key references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  revision integer not null default 1,
  first_confirmed_by uuid not null references auth.users(id),
  first_confirmed_at timestamptz not null,
  helper_confirmed_at timestamptz,
  requester_confirmed_at timestamptz,
  disputed_by uuid references auth.users(id),
  disagreement text,
  reminder_due_at timestamptz not null,
  review_due_at timestamptz not null,
  check ((disputed_by is null) = (disagreement is null))
);
alter table public.exchange_review_items drop constraint exchange_review_items_reason_check;
alter table public.exchange_review_items add constraint exchange_review_items_reason_check
  check (reason in ('missing_return_confirmation', 'overdue_return', 'missing_help_confirmation'));
create index help_completions_review_due on public.help_completions(review_due_at)
  where helper_confirmed_at is null or requester_confirmed_at is null;
create trigger help_completion_append_guard before delete on public.help_completions
  for each row execute function private.reject_history_rewrite();
alter table public.help_completions enable row level security;
revoke all on public.help_completions from anon, authenticated;
grant select on public.help_completions to authenticated;
create policy help_completion_read on public.help_completions for select to authenticated
  using (public.can_read_exchange(exchange_id));

create table public.help_completion_feed (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  exchange_id uuid not null unique references public.exchanges(id),
  helper_id uuid not null references auth.users(id),
  requester_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create function private.guard_help_completion_feed() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.exchanges e where e.id=new.exchange_id and e.kind='help' and e.state='completed'
    and e.community_id=new.community_id and e.provider_id=new.helper_id and e.receiver_id=new.requester_id) then
    raise exception using errcode='23514', message='Completion feed entries must match the completed Help Exchange participants.';
  end if;
  return new;
end;
$$;
create trigger help_completion_feed_integrity before insert on public.help_completion_feed
  for each row execute function private.guard_help_completion_feed();
create trigger help_completion_feed_append_only before update or delete on public.help_completion_feed
  for each row execute function private.reject_history_rewrite();
alter table public.help_completion_feed enable row level security;
revoke all on public.help_completion_feed from anon, authenticated;
grant select on public.help_completion_feed to authenticated;
create policy help_completion_feed_read on public.help_completion_feed for select to authenticated
  using (public.is_active_member(community_id));

create unique index help_completed_once on public.exchange_events(exchange_id) where kind = 'help_completed';
create unique index help_confirmation_reminder_once on public.exchange_events(exchange_id) where kind = 'help_confirmation_due';
create unique index help_review_queued_once on public.exchange_events(exchange_id) where kind = 'help_completion_review_queued';

drop policy event_read on public.community_events;
create policy event_read on public.community_events for select to authenticated using (
  public.is_active_member(community_id) and kind not like 'item\_%' and kind not like 'issue\_%'
  and kind not in ('conversation_started', 'message_sent', 'help_commitment_offered', 'help_commitment_accepted',
    'help_scheduled', 'help_cancelled', 'help_completion_confirmed', 'help_completion_due', 'help_completed',
    'help_completion_review_queued', 'test_billing_requested', 'borrow_requested', 'borrow_approved', 'borrow_rejected', 'borrow_expired'));

create function private.help_completion_view(p_exchange uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('exchangeId', e.id, 'state', e.state, 'communityId', e.community_id,
    'helperId', e.provider_id, 'requesterId', e.receiver_id, 'revision', coalesce(c.revision, 0),
    'firstConfirmedBy', c.first_confirmed_by, 'firstConfirmedAt', c.first_confirmed_at,
    'helperConfirmedAt', c.helper_confirmed_at, 'requesterConfirmedAt', c.requester_confirmed_at,
    'disputedBy', c.disputed_by, 'disagreement', c.disagreement,
    'reminderDueAt', c.reminder_due_at, 'reviewDueAt', c.review_due_at,
    'completedAt', e.completed_at, 'openDispute', exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null),
    'standing', private.community_standing(auth.uid(), e.community_id),
    'history', coalesce((select jsonb_agg(jsonb_build_object('participantId', q.participant_id) order by q.participant_id)
      from public.qualifying_interactions q where q.exchange_id = e.id), '[]'::jsonb),
    'awards', coalesce((select jsonb_agg(jsonb_build_object('recipientId', r.recipient_id, 'rule', r.rule, 'points', r.points) order by r.rule)
      from public.reputation_events r where r.exchange_id = e.id), '[]'::jsonb))
  from public.exchanges e left join public.help_completions c on c.exchange_id = e.id
  where e.id = p_exchange and e.kind = 'help';
$$;

create function private.finalize_help_exchange(p_exchange uuid, p_actor uuid, p_intent uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; c public.help_completions; event uuid;
begin
  select * into e from public.exchanges where id = p_exchange and kind = 'help' for update;
  select * into c from public.help_completions where exchange_id = e.id;
  if e.state is distinct from 'completion_pending' or c.exchange_id is null
    or c.helper_confirmed_at is null or c.requester_confirmed_at is null
    or exists(select 1 from public.disputes d where d.exchange_id = e.id and d.closed_at is null) then return false; end if;
  update public.exchanges set state = 'completed' where id = e.id;
  perform private.settle_exchange_completion(e.id);
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'help_completed', null);
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(e.community_id, p_actor, 'help_completed', p_intent) returning id into event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, e.community_id, recipient, channel, 'help_completed'
      from unnest(array[e.provider_id, e.receiver_id]) recipient cross join unnest(array['in_app', 'email']) channel;
  insert into public.help_completion_feed(community_id, exchange_id, helper_id, requester_id)
    values(e.community_id, e.id, e.provider_id, e.receiver_id) on conflict(exchange_id) do nothing;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  return true;
end;
$$;

create function public.read_help_completion(p_exchange_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_read_exchange(p_exchange_id) or not exists(select 1 from public.exchanges where id = p_exchange_id and kind = 'help') then
    raise exception using errcode = '42501', message = 'Help completion unavailable.';
  end if;
  return private.help_completion_view(p_exchange_id);
end;
$$;

create function public.command_help_completion(p_intent_id uuid, p_exchange_id uuid, p_expected_revision integer, p_action text, p_disagreement text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); e public.exchanges; c public.help_completions; outcome jsonb; event uuid; counterpart uuid;
  payload jsonb := jsonb_build_object('exchange', p_exchange_id, 'revision', p_expected_revision, 'action', p_action, 'disagreement', p_disagreement);
begin
  if not public.can_read_exchange(p_exchange_id) then raise exception using errcode = '42501', message = 'Help completion unavailable.'; end if;
  outcome := private.help_intent(actor, p_intent_id, 'command_help_completion', payload);
  if outcome is not null then return outcome; end if;
  select * into e from public.exchanges where id = p_exchange_id and kind = 'help' for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor
    and status in ('active', 'suspended', 'removed') for share;
  if not found or not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Help completion unavailable.'; end if;
  if e.state not in ('scheduled', 'completion_pending') then raise exception using errcode = '55000', message = 'Only scheduled help can be confirmed.'; end if;
  select * into c from public.help_completions where exchange_id = e.id for update;
  if coalesce(c.revision, 0) is distinct from p_expected_revision then raise exception using errcode = '55000', message = 'This confirmation changed. Refresh first.'; end if;
  if exists(select 1 from public.disputes d where d.exchange_id=e.id and d.closed_at is null) then
    raise exception using errcode = '55000', message = 'An open Dispute blocks ordinary completion confirmation.';
  end if;
  if p_action = 'dispute' then
    if e.state <> 'completion_pending' or c.exchange_id is null or actor = c.first_confirmed_by
      or p_disagreement is null or length(btrim(p_disagreement)) not between 1 and 4000 then
      raise exception using errcode = '55000', message = 'Only the other participant can report a completion disagreement.';
    end if;
    update public.help_completions set revision=revision+1, disputed_by=actor, disagreement=btrim(p_disagreement) where exchange_id=e.id returning * into c;
    perform public.report_exchange_issue(md5(p_intent_id::text || ':help-completion-disagreement')::uuid, e.id, 'other', 'Help completion disagreement. ' || btrim(p_disagreement));
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id,e.community_id,'help_completion_disputed',actor);
    insert into public.notification_hints(recipient_id) values(e.provider_id),(e.receiver_id);
    outcome := private.help_completion_view(e.id);
    insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'command_help_completion', payload, outcome);
    return outcome;
  elsif p_action <> 'confirm' then
    raise exception using errcode = '22023', message = 'Unknown help completion action.';
  end if;
  if e.state = 'scheduled' then
    insert into public.help_completions(exchange_id, community_id, revision, first_confirmed_by, first_confirmed_at,
      helper_confirmed_at, requester_confirmed_at, reminder_due_at, review_due_at)
    values(e.id, e.community_id, 1, actor, clock_timestamp(),
      case when actor = e.provider_id then clock_timestamp() end,
      case when actor = e.receiver_id then clock_timestamp() end,
      clock_timestamp() + interval '24 hours', clock_timestamp() + interval '7 days') returning * into c;
    update public.exchanges set state = 'completion_pending' where id = e.id;
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'help_completion_confirmed', actor);
    insert into public.community_events(community_id, actor_id, kind, intent_id) values(e.community_id, actor, 'help_completion_confirmed', p_intent_id) returning id into event;
    counterpart := case when actor = e.provider_id then e.receiver_id else e.provider_id end;
    insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
      select event, e.community_id, counterpart, channel, 'help_completion_confirmed' from unnest(array['in_app','email']) channel;
  else
    if (actor = e.provider_id and c.helper_confirmed_at is not null) or (actor = e.receiver_id and c.requester_confirmed_at is not null) then
      raise exception using errcode = '55000', message = 'You already confirmed this Help Exchange.';
    end if;
    update public.help_completions set revision = revision + 1,
      helper_confirmed_at = coalesce(helper_confirmed_at, case when actor = e.provider_id then clock_timestamp() end),
      requester_confirmed_at = coalesce(requester_confirmed_at, case when actor = e.receiver_id then clock_timestamp() end)
      where exchange_id = e.id returning * into c;
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(e.id, e.community_id, 'help_completion_confirmed', actor);
    insert into public.community_events(community_id, actor_id, kind, intent_id) values(e.community_id, actor, 'help_completion_confirmed', p_intent_id) returning id into event;
    if not private.finalize_help_exchange(e.id, actor, p_intent_id) then
      counterpart := case when actor = e.provider_id then e.receiver_id else e.provider_id end;
      insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
        select event, e.community_id, counterpart, channel, 'help_completion_confirmed' from unnest(array['in_app','email']) channel;
    end if;
  end if;
  insert into public.notification_hints(recipient_id) values(e.provider_id), (e.receiver_id);
  outcome := private.help_completion_view(e.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'command_help_completion', payload, outcome);
  return outcome;
end;
$$;

create function public.process_due_help_completions()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare due record; reminded integer := 0; queued integer := 0; event uuid; item uuid; recipients uuid[];
begin
  for due in select e.id, e.community_id, e.provider_id, e.receiver_id, c.reminder_due_at, c.review_due_at
    from public.exchanges e join public.help_completions c on c.exchange_id = e.id
    where e.state = 'completion_pending' and (c.helper_confirmed_at is null or c.requester_confirmed_at is null)
      and not exists(select 1 from public.disputes d where d.exchange_id=e.id and d.closed_at is null)
      and ((c.reminder_due_at <= clock_timestamp() and not exists(select 1 from public.exchange_events x where x.exchange_id=e.id and x.kind='help_confirmation_due'))
        or (c.review_due_at <= clock_timestamp() and not exists(select 1 from public.exchange_review_items q where q.exchange_id=e.id and q.reason='missing_help_confirmation')))
    order by c.review_due_at limit 100 for update of e skip locked
  loop
    if due.reminder_due_at <= clock_timestamp() and not exists(select 1 from public.exchange_events x where x.exchange_id=due.id and x.kind='help_confirmation_due') then
      insert into public.exchange_events(exchange_id, community_id, kind) values(due.id, due.community_id, 'help_confirmation_due');
      insert into public.community_events(community_id, actor_id, kind, intent_id) values(due.community_id, due.provider_id, 'help_confirmation_due', md5(due.id::text || ':remind')::uuid) returning id into event;
      insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
        select event, due.community_id, recipient, channel, 'help_completion_due'
          from unnest(array[due.provider_id, due.receiver_id]) recipient cross join unnest(array['in_app','email']) channel;
      insert into public.notification_hints(recipient_id) values(due.provider_id),(due.receiver_id);
      reminded := reminded + 1;
    end if;
    if due.review_due_at <= clock_timestamp() and not exists(select 1 from public.exchange_review_items q where q.exchange_id=due.id and q.reason='missing_help_confirmation') then
      insert into public.exchange_review_items(exchange_id, community_id, reason) values(due.id, due.community_id, 'missing_help_confirmation') returning id into item;
      insert into public.exchange_events(exchange_id, community_id, kind) values(due.id, due.community_id, 'help_completion_review_queued');
      insert into public.community_events(community_id, actor_id, kind, intent_id) values(due.community_id, due.provider_id, 'help_completion_review_queued', md5(due.id::text || ':review')::uuid) returning id into event;
      select array_agg(distinct recipient) into recipients from (
        select due.provider_id as recipient union select due.receiver_id
        union select user_id from public.memberships where community_id=due.community_id and role='administrator' and status='active') people;
      insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
        select event, due.community_id, recipient, channel, 'help_completion_review_queued' from unnest(recipients) recipient cross join unnest(array['in_app','email']) channel;
      insert into public.notification_hints(recipient_id) select unnest(recipients);
      queued := queued + 1;
    end if;
  end loop;
  return jsonb_build_object('reminded', reminded, 'queued', queued);
end;
$$;

select cron.schedule('ourtopia-help-completion-deadlines', '* * * * *', 'select public.process_due_help_completions()');

create or replace function public.read_community_feed(p_community_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_member(p_community_id) then raise exception using errcode = '42501', message = 'Current active Community membership is required.'; end if;
  return coalesce((select jsonb_agg(item order by created_at desc) from (
    select jsonb_build_object('id', f.id, 'kind', f.kind, 'title', l.title, 'completed_at', f.created_at,
      'owner', (select u.email from auth.users u join public.memberships m on m.user_id=u.id where u.id=f.owner_id and m.community_id=f.community_id and m.status='active'),
      'borrower', (select u.email from auth.users u join public.memberships m on m.user_id=u.id where u.id=f.borrower_id and m.community_id=f.community_id and m.status='active')) item, f.created_at
      from public.community_feed f join public.listings l on l.id=f.listing_id where f.community_id=p_community_id
    union all
    select jsonb_build_object('id', f.id, 'kind', 'help_completed', 'title', coalesce(l.title,p.title), 'completed_at', f.created_at,
      'owner', (select u.email from auth.users u join public.memberships m on m.user_id=u.id where u.id=f.helper_id and m.community_id=f.community_id and m.status='active'),
      'borrower', (select u.email from auth.users u join public.memberships m on m.user_id=u.id where u.id=f.requester_id and m.community_id=f.community_id and m.status='active')) item, f.created_at
      from public.help_completion_feed f join public.exchanges e on e.id=f.exchange_id
      left join public.help_listings l on e.source_kind='listing' and l.id=e.source_id
      left join public.help_need_posts p on e.source_kind='need_post' and p.id=e.source_id where f.community_id=p_community_id
    order by created_at desc limit 20
  ) items), '[]'::jsonb);
end;
$$;

create or replace function private.help_exchange_view(p_exchange_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'communityId', e.community_id, 'communityName', c.name, 'state', e.state,
    'sourceKind', e.source_kind, 'sourceId', e.source_id,
    'sourceTitle', coalesce((select l.title from public.help_listings l where l.id=e.source_id),(select p.title from public.help_need_posts p where p.id=e.source_id)),
    'helperId', e.provider_id, 'helperEmail', helper.email, 'requesterId', e.receiver_id, 'requesterEmail', requester.email,
    'commitmentId', d.commitment_id, 'place', s.place, 'placeStatus', s.status,
    'startsAt', d.starts_at, 'durationMinutes', d.duration_minutes, 'meetingPoint', d.meeting_point,
    'cancelReason', d.cancel_reason, 'cancelledBy', d.cancelled_by, 'cancelledAt', d.cancelled_at, 'createdAt', e.created_at,
    'completion', case when hc.exchange_id is null then null else private.help_completion_view(e.id) end)
  from public.exchanges e join public.help_exchange_details d on d.exchange_id=e.id join public.communities c on c.id=e.community_id
  join auth.users helper on helper.id=e.provider_id join auth.users requester on requester.id=e.receiver_id
  left join public.help_slots s on s.id=d.slot_id left join public.help_completions hc on hc.exchange_id=e.id where e.id=p_exchange_id;
$$;

revoke all on function private.help_completion_view(uuid), private.finalize_help_exchange(uuid,uuid,uuid), private.guard_help_completion_feed() from public,anon,authenticated;
revoke all on function public.read_help_completion(uuid), public.command_help_completion(uuid,uuid,integer,text,text), public.process_due_help_completions() from public,anon;
grant execute on function public.read_help_completion(uuid), public.command_help_completion(uuid,uuid,integer,text,text) to authenticated;
revoke all on function public.process_due_help_completions() from authenticated;
grant execute on function public.process_due_help_completions() to service_role;
notify pgrst, 'reload schema';
