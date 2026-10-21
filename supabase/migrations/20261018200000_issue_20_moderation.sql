-- Administrator suspension, reinstatement, and removal; content moderation. Prior-obligation access stays with
-- the existing participant rules (ADR 0003), which already honor suspended and removed memberships.

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  actor_id uuid not null references auth.users(id),
  subject_kind text not null check (subject_kind in ('membership', 'listing', 'help_listing', 'help_need_post', 'item_need_post')),
  subject_id uuid not null,
  subject_user_id uuid not null references auth.users(id),
  action text not null check (action in ('suspend', 'reinstate', 'remove', 'withdraw')),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  intent_id uuid not null,
  event_id uuid not null unique references public.community_events(id),
  created_at timestamptz not null default now(),
  check ((subject_kind = 'membership') = (action <> 'withdraw'))
);
create index moderation_actions_community on public.moderation_actions(community_id, created_at desc);
create trigger moderation_actions_append_only before update or delete on public.moderation_actions
  for each row execute function private.reject_history_rewrite();

alter table public.moderation_actions enable row level security;
revoke all on public.moderation_actions from anon, authenticated;
grant select on public.moderation_actions to authenticated;
create policy moderation_action_read on public.moderation_actions for select to authenticated
  using (public.is_community_administrator(community_id) or subject_user_id = auth.uid());

-- A removed row is terminal: only a fresh Invite (redeem_invite) may move it back into the application flow.
create function private.guard_membership_transition() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'removed' and new.status not in ('removed', 'pending') then
    raise exception using errcode = '55000', message = 'This membership cannot change to that status.';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_membership_transition() from public, anon, authenticated;
create trigger membership_status_transition before update on public.memberships
  for each row execute function private.guard_membership_transition();

-- Exchange thank-yous are new activity; a suspended or removed author cannot add one.
create function private.guard_thank_you_author_active() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.memberships m where m.community_id = new.community_id and m.user_id = new.author_id and m.status = 'active') then
    raise exception using errcode = '42501', message = 'Current active Community membership is required.';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_thank_you_author_active() from public, anon, authenticated;
create trigger exchange_thank_you_author_active before insert on public.exchange_thank_yous
  for each row execute function private.guard_thank_you_author_active();

create function private.enqueue_moderation_notice(p_event uuid, p_community uuid, p_recipient uuid, p_kind text)
returns void language sql security definer set search_path = '' as $$
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
  select p_event, p_community, p_recipient, ch, p_kind from unnest(array['in_app', 'email']) ch
  on conflict (event_id, recipient_id, channel, kind) do nothing;
$$;
revoke all on function private.enqueue_moderation_notice(uuid, uuid, uuid, text) from public, anon, authenticated;

create function public.moderate_membership(p_intent_id uuid, p_community_id uuid, p_user_id uuid, p_action text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('community_id', p_community_id, 'user_id', p_user_id, 'action', p_action, 'reason', p_reason);
  prior public.command_intents;
  member public.memberships;
  event_kind text;
  notice_kind text;
  event_id uuid;
  outcome jsonb;
begin
  perform public.require_current_membership(p_community_id, true);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'moderate_membership' or prior.payload <> payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    return prior.result;
  end if;
  if p_user_id = actor then raise exception using errcode = '22023', message = 'Administrators cannot moderate their own membership.'; end if;
  if p_action is null or p_action not in ('suspend', 'reinstate', 'remove') or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Choose suspend, reinstate, or remove, and give a reason of up to 1000 characters.';
  end if;
  select * into member from public.memberships where community_id = p_community_id and user_id = p_user_id for update;
  if not found then raise exception using errcode = '42501', message = 'Membership unavailable.'; end if;
  if not ((p_action = 'suspend' and member.status = 'active') or (p_action = 'reinstate' and member.status = 'suspended')
    or (p_action = 'remove' and member.status in ('active', 'suspended'))) then
    raise exception using errcode = '55000', message = 'This membership changed. Reload before moderating it.';
  end if;
  if member.role = 'administrator' and p_action in ('suspend', 'remove') and not exists (
    select 1 from public.memberships m where m.community_id = p_community_id and m.role = 'administrator' and m.status = 'active' and m.user_id <> p_user_id
  ) then
    raise exception using errcode = '55000', message = 'A Community needs at least one active administrator.';
  end if;
  event_kind := case p_action when 'suspend' then 'member_suspended' when 'reinstate' then 'member_reinstated' else 'member_removed' end;
  notice_kind := case p_action when 'suspend' then 'membership_suspended' when 'reinstate' then 'membership_reinstated' else 'membership_removed' end;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community_id, actor, event_kind, p_intent_id) returning id into event_id;
  update public.memberships set status = case p_action when 'suspend' then 'suspended' when 'reinstate' then 'active' else 'removed' end
    where community_id = p_community_id and user_id = p_user_id returning * into member;
  insert into public.moderation_actions(community_id, actor_id, subject_kind, subject_id, subject_user_id, action, reason, intent_id, event_id)
    values(p_community_id, actor, 'membership', p_user_id, p_user_id, p_action, btrim(p_reason), p_intent_id, event_id);
  perform private.enqueue_moderation_notice(event_id, p_community_id, p_user_id, notice_kind);
  insert into public.notification_hints(recipient_id) values(p_user_id);
  outcome := jsonb_build_object('community_id', member.community_id, 'user_id', member.user_id, 'role', member.role, 'status', member.status, 'event_id', event_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'moderate_membership', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.moderate_membership(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.moderate_membership(uuid, uuid, uuid, text, text) to authenticated;

create function public.moderate_content(p_intent_id uuid, p_community_id uuid, p_subject_kind text, p_subject_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('community_id', p_community_id, 'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'reason', p_reason);
  prior public.command_intents;
  content_owner uuid;
  event_id uuid;
  outcome jsonb;
begin
  perform public.require_current_membership(p_community_id, true);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'moderate_content' or prior.payload <> payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    return prior.result;
  end if;
  if p_subject_kind is null or p_subject_kind not in ('listing', 'help_listing', 'help_need_post', 'item_need_post')
    or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Choose the post kind and give a reason of up to 1000 characters.';
  end if;
  -- The owner comes from the stored row, never from the payload.
  if p_subject_kind = 'listing' then
    update public.listings set status = 'withdrawn', version = version + 1, updated_at = clock_timestamp()
      where id = p_subject_id and community_id = p_community_id and status = 'published' returning owner_id into content_owner;
  elsif p_subject_kind = 'help_listing' then
    update public.help_listings set status = 'withdrawn' where id = p_subject_id and community_id = p_community_id and status = 'open'
      returning owner_id into content_owner;
  elsif p_subject_kind = 'help_need_post' then
    update public.help_need_posts set status = 'withdrawn' where id = p_subject_id and community_id = p_community_id and status = 'open'
      returning owner_id into content_owner;
  else
    update public.item_need_posts set status = 'withdrawn', version = version + 1 where id = p_subject_id and community_id = p_community_id and status = 'open'
      returning author_id into content_owner;
  end if;
  if content_owner is null then raise exception using errcode = '55000', message = 'This post is unavailable or already withdrawn.'; end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community_id, actor, 'content_moderated', p_intent_id) returning id into event_id;
  insert into public.moderation_actions(community_id, actor_id, subject_kind, subject_id, subject_user_id, action, reason, intent_id, event_id)
    values(p_community_id, actor, p_subject_kind, p_subject_id, content_owner, 'withdraw', btrim(p_reason), p_intent_id, event_id);
  perform private.enqueue_moderation_notice(event_id, p_community_id, content_owner, 'content_moderated');
  insert into public.notification_hints(recipient_id) values(content_owner);
  outcome := jsonb_build_object('subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'owner_id', content_owner, 'status', 'withdrawn', 'event_id', event_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'moderate_content', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.moderate_content(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function public.moderate_content(uuid, uuid, text, uuid, text) to authenticated;

-- Roster for administrators: every membership that is not a rejected application, including suspended and removed rows.
create function public.moderation_roster(p_community_id uuid)
returns table(user_id uuid, email text, role text, status text, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_community_administrator(p_community_id) then
    raise exception using errcode = '42501', message = 'Community administration is required.';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.status, m.created_at
    from public.memberships m join auth.users u on u.id = m.user_id
    where m.community_id = p_community_id and m.status in ('active', 'suspended', 'removed', 'pending')
    order by m.status, lower(u.email);
end;
$$;
revoke all on function public.moderation_roster(uuid) from public, anon;
grant execute on function public.moderation_roster(uuid) to authenticated;

notify pgrst, 'reload schema';
