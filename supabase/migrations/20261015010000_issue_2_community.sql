create table public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80 and name = btrim(name)),
  description text not null default '' check (char_length(description) <= 500),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.memberships (
  community_id uuid not null references public.communities(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('administrator', 'member')),
  status text not null check (status in ('pending', 'active', 'rejected', 'suspended', 'removed')),
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

create table public.command_intents (
  actor_id uuid not null references auth.users(id),
  intent_id uuid not null,
  command text not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, intent_id)
);

create table public.community_events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  actor_id uuid not null references auth.users(id),
  kind text not null,
  intent_id uuid not null,
  created_at timestamptz not null default now(),
  unique (actor_id, intent_id, kind)
);

create schema if not exists private;
revoke all on schema private from public;

create function public.is_active_member(target_community uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships
    where community_id = target_community and user_id = auth.uid() and status = 'active'
  );
$$;
revoke all on function public.is_active_member(uuid) from public;
grant execute on function public.is_active_member(uuid) to authenticated;

alter table public.communities enable row level security;
alter table public.memberships enable row level security;
alter table public.command_intents enable row level security;
alter table public.community_events enable row level security;
revoke all on public.communities, public.memberships, public.command_intents, public.community_events from anon, authenticated;
grant select on public.communities, public.memberships, public.community_events to authenticated;
create policy community_read on public.communities for select to authenticated
using (public.is_active_member(id));
create policy membership_read on public.memberships for select to authenticated
using (public.is_active_member(community_id));
create policy event_read on public.community_events for select to authenticated
using (public.is_active_member(community_id));

create function public.create_community(p_intent_id uuid, p_name text, p_description text default '')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('name', p_name, 'description', p_description);
  prior public.command_intents;
  community public.communities;
  outcome jsonb;
begin
  if actor is null or not exists (
    select 1 from auth.users where id = actor and email_confirmed_at is not null
  ) then
    raise exception using errcode = '42501', message = 'A verified account is required.';
  end if;
  if p_intent_id is null then
    raise exception using errcode = '22023', message = 'An intent identity is required.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'create_community' or prior.payload <> payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    if not public.is_active_member((prior.result->>'id')::uuid) then
      raise exception using errcode = '42501', message = 'Community access is no longer active.';
    end if;
    return prior.result;
  end if;
  if p_name is null or p_name <> btrim(p_name) or char_length(p_name) not between 2 and 80
    or p_description is null or char_length(p_description) > 500 then
    raise exception using errcode = '22023', message = 'Use a name of 2–80 characters and description up to 500 characters.';
  end if;
  insert into public.communities(name, description, created_by) values(p_name, p_description, actor) returning * into community;
  insert into public.memberships(community_id, user_id, role, status) values(community.id, actor, 'administrator', 'active');
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(community.id, actor, 'community_created', p_intent_id);
  outcome := to_jsonb(community);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'create_community', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.create_community(uuid, text, text) from public;
grant execute on function public.create_community(uuid, text, text) to authenticated;

alter publication supabase_realtime add table public.community_events;
