create table public.dispute_message_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes(id),
  community_id uuid not null references public.communities(id),
  source_message_id uuid not null references public.messages(id),
  source_author_id uuid not null references auth.users(id),
  source_created_at timestamptz not null,
  body text not null,
  submitter_id uuid not null references auth.users(id),
  submitted_at timestamptz not null default now(),
  unique (dispute_id, source_message_id, submitter_id)
);
create trigger dispute_message_evidence_append_only before update or delete on public.dispute_message_evidence
  for each row execute function private.reject_rewrite();
create trigger dispute_message_evidence_no_truncate before truncate on public.dispute_message_evidence
  for each statement execute function private.reject_rewrite();
alter table public.dispute_message_evidence enable row level security;
revoke all on public.dispute_message_evidence from anon, authenticated;
grant select on public.dispute_message_evidence to authenticated;
create policy dispute_message_evidence_read on public.dispute_message_evidence for select to authenticated
  using (public.can_read_dispute(dispute_id));

create or replace function public.can_read_conversation(p_conversation_id uuid, p_message_at timestamptz default '-infinity')
returns boolean language sql stable security definer set search_path = '' as $$
  with requested_conversation as (
    select c.id, c.community_id, c.participant_low, c.participant_high
    from public.conversations c
    where c.id = p_conversation_id and auth.uid() in (c.participant_low, c.participant_high)
  ), restricted_access as (
    select c.id
    from requested_conversation c
    join public.memberships m on m.community_id = c.community_id and m.user_id = auth.uid()
    where m.status in ('suspended', 'removed')
      and exists (
        select 1
        from public.message_selection_grants g
        left join public.disputes d on d.id = g.dispute_id
        where g.conversation_id = c.id and g.user_id = auth.uid()
          and p_message_at <= g.granted_at
          and (g.ends_at is null or g.ends_at > statement_timestamp())
          and (d.id is null or (
            d.community_id = c.community_id
            and least(d.reporter_id, d.respondent_id) = c.participant_low
            and greatest(d.reporter_id, d.respondent_id) = c.participant_high
            and public.can_read_exchange(d.exchange_id)
          ))
      )
  )
  select exists (
    select 1 from requested_conversation c
    where public.is_active_member(c.community_id)
       or exists (select 1 from restricted_access r where r.id = c.id)
  );
$$;

create function private.grant_dispute_message_selection() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.message_selection_grants(conversation_id, user_id, dispute_id)
    select c.id, m.user_id, new.id from public.memberships m
    join public.conversations c on c.community_id = new.community_id
      and c.participant_low = least(new.reporter_id, new.respondent_id) and c.participant_high = greatest(new.reporter_id, new.respondent_id)
    where m.community_id = new.community_id and m.user_id in (new.reporter_id, new.respondent_id) and m.status in ('suspended', 'removed')
    on conflict (conversation_id, user_id, dispute_id) do nothing;
  return null;
end;
$$;
create trigger dispute_message_selection_grant after insert on public.disputes
  for each row execute function private.grant_dispute_message_selection();

create function private.grant_membership_message_selection() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.message_selection_grants(conversation_id, user_id, dispute_id)
    select c.id, new.user_id, d.id from public.disputes d
    join public.conversations c on c.community_id = d.community_id
      and c.participant_low = least(d.reporter_id, d.respondent_id) and c.participant_high = greatest(d.reporter_id, d.respondent_id)
    where d.community_id = new.community_id and new.user_id in (d.reporter_id, d.respondent_id)
    on conflict (conversation_id, user_id, dispute_id) do update set granted_at = excluded.granted_at;
  return null;
end;
$$;
create trigger membership_message_selection_grant after update of status on public.memberships
  for each row when (old.status = 'active' and new.status in ('suspended', 'removed'))
  execute function private.grant_membership_message_selection();

create function public.submit_dispute_messages(p_intent_id uuid, p_dispute_id uuid, p_message_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); d public.disputes; e public.exchanges; outcome jsonb; recipients uuid[]; added integer;
  selection uuid[] := (select array_agg(distinct id order by id) from unnest(p_message_ids) id);
  payload jsonb := jsonb_build_object('dispute', p_dispute_id, 'messages', to_jsonb(selection));
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found or actor is null or actor not in (d.reporter_id, d.respondent_id) or not public.can_read_exchange(d.exchange_id) then
    raise exception using errcode = '42501', message = 'Case unavailable.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'submit_dispute_messages', payload);
  if outcome is not null then return outcome; end if;
  if selection is null or array_position(selection, null) is not null or cardinality(selection) > 20 then
    raise exception using errcode = '22023', message = 'Select between 1 and 20 messages.';
  end if;
  select * into e from public.exchanges where id = d.exchange_id for update;
  perform 1 from public.memberships where community_id = e.community_id and user_id = actor for share;
  select * into d from public.disputes where id = p_dispute_id for update;
  if not public.can_read_exchange(e.id) then raise exception using errcode = '42501', message = 'Case unavailable.'; end if;
  if d.closed_at is not null then raise exception using errcode = '55000', message = 'This case is closed.'; end if;
  if exists(select 1 from unnest(selection) s(id) where not exists(
    select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
    where m.id = s.id and c.community_id = d.community_id
      and c.participant_low = least(d.reporter_id, d.respondent_id) and c.participant_high = greatest(d.reporter_id, d.respondent_id)
      and public.can_read_conversation(c.id, m.created_at))) then
    raise exception using errcode = '42501', message = 'Select messages from your conversation with the other participant in this Community.';
  end if;
  insert into public.dispute_message_evidence(dispute_id, community_id, source_message_id, source_author_id, source_created_at, body, submitter_id)
    select d.id, d.community_id, m.id, m.author_id, m.created_at, m.body, actor from public.messages m where m.id = any(selection)
    order by m.created_at, m.id
    on conflict (dispute_id, source_message_id, submitter_id) do nothing;
  get diagnostics added = row_count;
  if added > 0 then
    select array_agg(distinct recipient) into recipients from (
      select case when actor = e.provider_id then e.receiver_id else e.provider_id end as recipient
      union select user_id from public.memberships where community_id = e.community_id and role = 'administrator' and status = 'active' and user_id <> actor
    ) r;
    perform private.record_dispute_activity(d.id, actor, p_intent_id, 'item_dispute_response', recipients);
    insert into public.notification_hints(recipient_id) values(actor);
  end if;
  outcome := jsonb_build_object('dispute_id', d.id, 'added', added, 'snapshots', (select jsonb_agg(to_jsonb(v) order by v.source_created_at, v.id)
    from public.dispute_message_evidence v where v.dispute_id = d.id and v.submitter_id = actor and v.source_message_id = any(selection)));
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'submit_dispute_messages', payload, outcome);
  return outcome;
end;
$$;

-- One read for the case screen: every snapshot under case access, plus selectable source text for a current participant only.
create function public.read_dispute_message_evidence(p_dispute_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d public.disputes; selecting boolean;
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found or not public.can_read_dispute(d.id) then raise exception using errcode = '42501', message = 'Case unavailable.'; end if;
  selecting := auth.uid() in (d.reporter_id, d.respondent_id) and d.closed_at is null and public.can_read_exchange(d.exchange_id);
  return jsonb_build_object('dispute_id', d.id, 'can_submit', selecting,
    'snapshots', coalesce((select jsonb_agg(to_jsonb(v) order by v.submitted_at, v.source_created_at, v.id)
      from public.dispute_message_evidence v where v.dispute_id = d.id), '[]'::jsonb),
    'sources', case when selecting then coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'author_id', m.author_id, 'body', m.body, 'created_at', m.created_at) order by m.created_at, m.id)
      from public.conversations c join public.messages m on m.conversation_id = c.id
      where c.community_id = d.community_id and c.participant_low = least(d.reporter_id, d.respondent_id)
        and c.participant_high = greatest(d.reporter_id, d.respondent_id) and public.can_read_conversation(c.id, m.created_at)), '[]'::jsonb)
      else '[]'::jsonb end);
end;
$$;

revoke all on function private.grant_dispute_message_selection(), private.grant_membership_message_selection() from public, anon, authenticated;
revoke all on function public.submit_dispute_messages(uuid, uuid, uuid[]), public.read_dispute_message_evidence(uuid) from public, anon;
grant execute on function public.submit_dispute_messages(uuid, uuid, uuid[]), public.read_dispute_message_evidence(uuid) to authenticated;
notify pgrst, 'reload schema';
