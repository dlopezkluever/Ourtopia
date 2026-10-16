create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  participant_low uuid not null references auth.users(id),
  participant_high uuid not null references auth.users(id),
  started_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (participant_low < participant_high),
  check (started_by in (participant_low, participant_high)),
  unique (community_id, participant_low, participant_high),
  unique (id, community_id)
);
create index conversations_participant_high on public.conversations(participant_high);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  community_id uuid not null,
  author_id uuid not null references auth.users(id),
  intent_id uuid not null,
  body text not null check (btrim(body) <> '' and char_length(body) <= 4000),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, community_id) references public.conversations(id, community_id),
  unique (author_id, intent_id)
);
create index messages_conversation_time on public.messages(conversation_id, created_at, id);

create table public.message_selection_grants (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id),
  user_id uuid not null references auth.users(id),
  dispute_id uuid not null,
  granted_at timestamptz not null default now(),
  ends_at timestamptz,
  unique (conversation_id, user_id, dispute_id)
);

create function private.reject_rewrite()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = TG_TABLE_NAME || ' rows are append-only.';
end;
$$;
revoke all on function private.reject_rewrite() from public, anon, authenticated;
create trigger messages_append_only before update or delete on public.messages
  for each row execute function private.reject_rewrite();
create trigger messages_no_truncate before truncate on public.messages
  for each statement execute function private.reject_rewrite();
create trigger conversations_immutable before update or delete on public.conversations
  for each row execute function private.reject_rewrite();
create trigger message_audit_append_only before update or delete on public.community_events
  for each row when (old.kind in ('conversation_started', 'message_sent')) execute function private.reject_rewrite();

create function public.can_read_conversation(p_conversation_id uuid, p_message_at timestamptz default '-infinity')
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id and auth.uid() in (c.participant_low, c.participant_high)
      and (public.is_active_member(c.community_id) or (exists (
        select 1 from public.memberships membership where membership.community_id = c.community_id
          and membership.user_id = auth.uid() and membership.status in ('suspended', 'removed')
      ) and exists (
        select 1 from public.message_selection_grants g
        where g.conversation_id = c.id and g.user_id = auth.uid() and p_message_at <= g.granted_at
          and (g.ends_at is null or g.ends_at > statement_timestamp())
      )))
  );
$$;
revoke all on function public.can_read_conversation(uuid, timestamptz) from public, anon;
grant execute on function public.can_read_conversation(uuid, timestamptz) to authenticated;

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_selection_grants enable row level security;
revoke all on public.conversations, public.messages, public.message_selection_grants from anon, authenticated;
grant select on public.conversations, public.messages, public.message_selection_grants to authenticated;
create policy conversation_participant_read on public.conversations for select to authenticated
  using (public.can_read_conversation(id));
create policy message_participant_read on public.messages for select to authenticated
  using (public.can_read_conversation(conversation_id, created_at));
create policy selection_grant_holder_read on public.message_selection_grants for select to authenticated
  using (user_id = auth.uid());

create function public.conversation_candidates(p_community_id uuid)
returns table (user_id uuid, email text) language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email::text from public.memberships m join auth.users u on u.id = m.user_id
  where public.is_active_member(p_community_id) and m.community_id = p_community_id
    and m.status = 'active' and m.user_id <> auth.uid()
  order by u.email;
$$;
revoke all on function public.conversation_candidates(uuid) from public, anon;
grant execute on function public.conversation_candidates(uuid) to authenticated;

create function public.conversation_inbox()
returns table (id uuid, community_id uuid, community_name text, counterpart_id uuid, counterpart_email text,
  created_at timestamptz, last_message_at timestamptz, can_send boolean)
language sql stable security definer set search_path = '' as $$
  select c.id, c.community_id, community.name, other.id, other.email::text, c.created_at,
    (select max(m.created_at) from public.messages m where m.conversation_id = c.id and public.can_read_conversation(c.id, m.created_at)),
    public.is_active_member(c.community_id)
  from public.conversations c
  join public.communities community on community.id = c.community_id
  join auth.users other on other.id = case when c.participant_low = auth.uid() then c.participant_high else c.participant_low end
  where public.can_read_conversation(c.id)
  order by 7 desc nulls last, c.created_at desc;
$$;
revoke all on function public.conversation_inbox() from public, anon;
grant execute on function public.conversation_inbox() to authenticated;

drop policy event_read on public.community_events;
create policy event_read on public.community_events for select to authenticated
  using (public.is_active_member(community_id) and kind not in ('conversation_started', 'message_sent'));
drop policy outbox_status_read on public.notification_outbox;
create policy outbox_status_read on public.notification_outbox for select to authenticated
  using (case when kind in ('conversation_started', 'message_sent') then
    recipient_id = auth.uid() and public.is_active_member(community_id)
    else recipient_id = auth.uid() or public.is_community_administrator(community_id) end);

create function private.record_conversation_activity(p_community uuid, p_actor uuid, p_intent uuid, p_kind text, p_recipient uuid)
returns void language plpgsql set search_path = '' as $$
declare event_id uuid;
begin
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(p_community, p_actor, p_kind, p_intent) returning id into event_id;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event_id, p_community, p_recipient, 'in_app', p_kind
    where exists (select 1 from public.memberships where community_id = p_community and user_id = p_recipient and status = 'active');
end;
$$;
revoke all on function private.record_conversation_activity(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;

create or replace function public.retry_notification(p_intent_id uuid, p_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item public.notification_outbox; actor uuid := auth.uid(); prior public.command_intents;
  payload jsonb := jsonb_build_object('outbox_id', p_outbox_id);
begin
  select * into item from public.notification_outbox where id = p_outbox_id;
  if not found or item.kind in ('conversation_started', 'message_sent') then
    raise exception using errcode = '42501', message = 'Notice unavailable.';
  end if;
  perform public.require_current_membership(item.community_id, true);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'retry_notification' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  select * into item from public.notification_outbox where id = p_outbox_id for update;
  if item.state <> 'failed' then raise exception using errcode = '55000', message = 'Only failed deliveries can be retried.'; end if;
  update public.notification_outbox set next_attempt_at = clock_timestamp() where id = item.id returning * into item;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(item.community_id, actor, 'notification_retry_requested', p_intent_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'retry_notification', payload, to_jsonb(item));
  return to_jsonb(item);
end;
$$;

create function public.start_conversation(p_intent_id uuid, p_community_id uuid, p_participant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('community_id', p_community_id, 'participant_id', p_participant_id);
  prior public.command_intents;
  conversation public.conversations;
  counterpart_status text;
begin
  perform public.require_current_membership(p_community_id);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'start_conversation' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  if p_participant_id is null or p_participant_id = actor then raise exception using errcode = '22023', message = 'Choose another active member.'; end if;
  select status into counterpart_status from public.memberships
    where community_id = p_community_id and user_id = p_participant_id for share;
  if counterpart_status is distinct from 'active' then
    raise exception using errcode = '42501', message = 'That person is not an active member of this Community.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_community_id::text || least(actor, p_participant_id)::text || greatest(actor, p_participant_id)::text, 2));
  select * into conversation from public.conversations where community_id = p_community_id
    and participant_low = least(actor, p_participant_id) and participant_high = greatest(actor, p_participant_id);
  if not found then
    insert into public.conversations(community_id, participant_low, participant_high, started_by)
      values(p_community_id, least(actor, p_participant_id), greatest(actor, p_participant_id), actor) returning * into conversation;
    insert into public.notification_hints(recipient_id) values(p_participant_id);
    perform private.record_conversation_activity(p_community_id, actor, p_intent_id, 'conversation_started', p_participant_id);
  end if;
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'start_conversation', payload, to_jsonb(conversation));
  return to_jsonb(conversation);
end;
$$;
revoke all on function public.start_conversation(uuid, uuid, uuid) from public, anon;
grant execute on function public.start_conversation(uuid, uuid, uuid) to authenticated;

create function public.send_message(p_intent_id uuid, p_conversation_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('conversation_id', p_conversation_id, 'body', p_body);
  prior public.command_intents;
  conversation public.conversations;
  message public.messages;
begin
  select * into conversation from public.conversations where id = p_conversation_id;
  if not found or actor is null or actor not in (conversation.participant_low, conversation.participant_high) then
    raise exception using errcode = '42501', message = 'Conversation unavailable.';
  end if;
  perform public.require_current_membership(conversation.community_id);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'send_message' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  if p_body is null or btrim(p_body) = '' or char_length(p_body) > 4000 then
    raise exception using errcode = '22023', message = 'Write a message of up to 4000 characters.';
  end if;
  insert into public.messages(conversation_id, community_id, author_id, intent_id, body)
    values(conversation.id, conversation.community_id, actor, p_intent_id, p_body) returning * into message;
  insert into public.notification_hints(recipient_id) values(conversation.participant_low), (conversation.participant_high);
  perform private.record_conversation_activity(conversation.community_id, actor, p_intent_id, 'message_sent',
    case when actor = conversation.participant_low then conversation.participant_high else conversation.participant_low end);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'send_message', payload, to_jsonb(message));
  return to_jsonb(message);
end;
$$;
revoke all on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.send_message(uuid, uuid, text) to authenticated;
notify pgrst, 'reload schema';
