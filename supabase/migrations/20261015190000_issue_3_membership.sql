create table public.membership_settings (
  singleton boolean primary key default true check (singleton),
  invite_lifetime interval not null default interval '7 days' check (invite_lifetime > interval '0')
);
insert into public.membership_settings default values;
alter table public.membership_settings enable row level security;
revoke all on public.membership_settings from anon, authenticated;

create function public.require_current_membership(p_community_id uuid, p_administrator boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare member public.memberships;
begin
  select * into member from public.memberships
    where community_id = p_community_id and user_id = auth.uid() for share;
  if not public.is_active_member(p_community_id) or (p_administrator and member.role <> 'administrator') then
    raise exception using errcode = '42501', message = 'Current active Community membership is required.';
  end if;
end;
$$;
revoke all on function public.require_current_membership(uuid, boolean) from public, anon;
grant execute on function public.require_current_membership(uuid, boolean) to authenticated;

create function public.is_community_administrator(p_community_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_active_member(p_community_id) and exists (
    select 1 from public.memberships where community_id = p_community_id
      and user_id = auth.uid() and role = 'administrator' and status = 'active'
  );
$$;
revoke all on function public.is_community_administrator(uuid) from public, anon;
grant execute on function public.is_community_administrator(uuid) to authenticated;

create function private.verified_email()
returns text language sql stable security definer set search_path = '' as $$
  select lower(email) from auth.users where id = auth.uid() and email_confirmed_at is not null;
$$;
revoke all on function private.verified_email() from public, anon, authenticated;

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  community_name text not null,
  recipient_email text not null,
  issued_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_by uuid references auth.users(id),
  redeemed_at timestamptz,
  check ((redeemed_by is null) = (redeemed_at is null)),
  unique (id, community_id)
);
create table public.membership_applications (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  community_name text not null,
  invite_id uuid not null unique,
  applicant_id uuid not null references auth.users(id),
  applicant_email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  reason text,
  application_event_id uuid not null references public.community_events(id),
  decision_event_id uuid unique references public.community_events(id),
  foreign key (invite_id, community_id) references public.invites(id, community_id),
  check ((status = 'pending' and decided_by is null and decided_at is null and decision_event_id is null and reason is null)
    or (status <> 'pending' and decided_by is not null and decided_at is not null and decision_event_id is not null)),
  check (status <> 'rejected' or char_length(btrim(reason)) between 1 and 1000)
);
create unique index one_pending_application on public.membership_applications(community_id, applicant_id) where status = 'pending';

create function public.can_read_invite(p_invite_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invites i where i.id = p_invite_id and (
    public.is_community_administrator(i.community_id) or i.redeemed_by = auth.uid()
    or (i.recipient_email = private.verified_email() and i.redeemed_by is null and i.expires_at > statement_timestamp())
  ));
$$;
revoke all on function public.can_read_invite(uuid) from public, anon;
grant execute on function public.can_read_invite(uuid) to authenticated;

alter table public.invites enable row level security;
alter table public.membership_applications enable row level security;
revoke all on public.invites, public.membership_applications from anon, authenticated;
grant select on public.invites, public.membership_applications to authenticated;
create policy invite_read on public.invites for select to authenticated using (public.can_read_invite(id));
create policy application_read on public.membership_applications for select to authenticated
  using (applicant_id = auth.uid() or public.is_community_administrator(community_id));

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.community_events(id),
  community_id uuid not null references public.communities(id),
  recipient_id uuid not null references auth.users(id),
  channel text not null check (channel in ('in_app', 'email')),
  kind text not null,
  application_id uuid references public.membership_applications(id),
  state text not null default 'pending' check (state in ('pending', 'processing', 'failed', 'delivered')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  lease_until timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, recipient_id, channel, kind)
);
create index notification_due on public.notification_outbox(next_attempt_at) where state <> 'delivered';
create table public.notification_attempts (
  id uuid primary key,
  outbox_id uuid not null references public.notification_outbox(id),
  number integer not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  unique (outbox_id, number)
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null unique references public.notification_outbox(id),
  recipient_id uuid not null references auth.users(id),
  application_id uuid references public.membership_applications(id),
  kind text not null,
  created_at timestamptz not null default now()
);
create table public.notification_hints (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id)
);
alter table public.notification_outbox enable row level security;
alter table public.notification_attempts enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_hints enable row level security;
revoke all on public.notification_outbox, public.notification_attempts, public.notifications, public.notification_hints from anon, authenticated;
grant select on public.notification_outbox, public.notification_attempts, public.notifications, public.notification_hints to authenticated;
create policy outbox_status_read on public.notification_outbox for select to authenticated
  using (recipient_id = auth.uid() or public.is_community_administrator(community_id));
create policy attempt_status_read on public.notification_attempts for select to authenticated
  using (exists (select 1 from public.notification_outbox o where o.id = outbox_id));
create policy notice_recipient on public.notifications for select to authenticated using (recipient_id = auth.uid());
create policy notification_hint_recipient on public.notification_hints for select to authenticated using (recipient_id = auth.uid());
alter publication supabase_realtime add table public.notification_hints;

create function private.enqueue_membership_notice(p_event uuid, p_application uuid, p_kind text, p_recipient uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind, application_id)
  select p_event, a.community_id, p_recipient, ch, p_kind, a.id
  from public.membership_applications a cross join unnest(array['in_app', 'email']) ch where a.id = p_application
  on conflict (event_id, recipient_id, channel, kind) do nothing;
$$;
revoke all on function private.enqueue_membership_notice(uuid, uuid, text, uuid) from public, anon, authenticated;

create function public.issue_invite(p_intent_id uuid, p_community_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('community_id', p_community_id, 'email', p_email);
  prior public.command_intents;
  invite public.invites;
begin
  perform public.require_current_membership(p_community_id, true);
  if private.verified_email() is null then raise exception using errcode = '42501', message = 'Verify your email first.'; end if;
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'issue_invite' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  if p_email is null or char_length(p_email) > 254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Enter a valid email address.';
  end if;
  insert into public.invites(community_id, community_name, recipient_email, issued_by, expires_at)
    select c.id, c.name, lower(btrim(p_email)), actor, clock_timestamp() + s.invite_lifetime
    from public.communities c cross join public.membership_settings s where c.id = p_community_id returning * into invite;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community_id, actor, 'invite_issued', p_intent_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'issue_invite', payload, to_jsonb(invite));
  return to_jsonb(invite);
end;
$$;
revoke all on function public.issue_invite(uuid, uuid, text) from public, anon;
grant execute on function public.issue_invite(uuid, uuid, text) to authenticated;

create function public.redeem_invite(p_intent_id uuid, p_invite_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  email text := private.verified_email();
  payload jsonb := jsonb_build_object('invite_id', p_invite_id);
  prior public.command_intents;
  invite public.invites;
  application public.membership_applications;
  member public.memberships;
  event_id uuid;
  recipient uuid;
begin
  if email is null then raise exception using errcode = '42501', message = 'A verified account is required.'; end if;
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'redeem_invite' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  select * into invite from public.invites where id = p_invite_id for update;
  if not found or invite.recipient_email <> email then raise exception using errcode = '42501', message = 'This Invite is unavailable for this account.'; end if;
  if invite.expires_at <= clock_timestamp() then raise exception using errcode = '22023', message = 'This Invite has expired. Ask for a fresh Invite.'; end if;
  if invite.redeemed_by is not null then raise exception using errcode = '55000', message = 'This Invite has already been consumed.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(invite.community_id::text || actor::text, 1));
  select * into member from public.memberships where community_id = invite.community_id and user_id = actor for update;
  if found and member.status not in ('rejected', 'removed') then raise exception using errcode = '55000', message = 'A current membership or application already exists.'; end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(invite.community_id, actor, 'membership_applied', p_intent_id) returning id into event_id;
  insert into public.membership_applications(community_id, community_name, invite_id, applicant_id, applicant_email, application_event_id)
    values(invite.community_id, invite.community_name, invite.id, actor, email, event_id) returning * into application;
  insert into public.memberships(community_id, user_id, role, status) values(invite.community_id, actor, 'member', 'pending')
    on conflict (community_id, user_id) do update set role = 'member', status = 'pending';
  update public.invites set redeemed_by = actor, redeemed_at = clock_timestamp() where id = invite.id;
  for recipient in select user_id from public.memberships where community_id = invite.community_id and status = 'active' and role = 'administrator' loop
    perform private.enqueue_membership_notice(event_id, application.id, 'membership_applied', recipient);
  end loop;
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'redeem_invite', payload, to_jsonb(application));
  return to_jsonb(application);
end;
$$;
revoke all on function public.redeem_invite(uuid, uuid) from public, anon;
grant execute on function public.redeem_invite(uuid, uuid) to authenticated;

create function public.decide_membership(p_intent_id uuid, p_application_id uuid, p_decision text, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('application_id', p_application_id, 'decision', p_decision, 'reason', p_reason);
  prior public.command_intents;
  application public.membership_applications;
  member public.memberships;
  event_id uuid;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Sign in first.'; end if;
  select * into application from public.membership_applications where id = p_application_id;
  if not found then raise exception using errcode = '42501', message = 'Application unavailable.'; end if;
  perform public.require_current_membership(application.community_id, true);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'decide_membership' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  select * into application from public.membership_applications where id = p_application_id for update;
  select * into member from public.memberships where community_id = application.community_id and user_id = application.applicant_id for update;
  if application.status <> 'pending' or member.status <> 'pending' then raise exception using errcode = '55000', message = 'This application is no longer pending.'; end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') or p_reason is null or char_length(p_reason) > 1000
    or (p_decision = 'rejected' and char_length(btrim(p_reason)) = 0) then
    raise exception using errcode = '22023', message = 'Choose approval or rejection. A rejection needs a reason of up to 1000 characters.';
  end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(application.community_id, actor, 'membership_' || p_decision, p_intent_id) returning id into event_id;
  update public.membership_applications set status = p_decision, reason = p_reason, decided_by = actor,
    decided_at = clock_timestamp(), decision_event_id = event_id where id = application.id returning * into application;
  update public.memberships set status = case when p_decision = 'approved' then 'active' else 'rejected' end
    where community_id = application.community_id and user_id = application.applicant_id;
  perform private.enqueue_membership_notice(event_id, application.id, 'membership_' || p_decision, application.applicant_id);
  insert into public.notification_hints(recipient_id) values(application.applicant_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'decide_membership', payload, to_jsonb(application));
  return to_jsonb(application);
end;
$$;
revoke all on function public.decide_membership(uuid, uuid, text, text) from public, anon;
grant execute on function public.decide_membership(uuid, uuid, text, text) to authenticated;
notify pgrst, 'reload schema';
