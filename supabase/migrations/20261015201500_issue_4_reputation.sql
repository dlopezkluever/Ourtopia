-- Exchange identity (ADR 0008). Item: provider = owner, receiver = borrower. Help: provider = helper, receiver = requester.
create table public.exchanges (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  kind text not null check (kind in ('item', 'help')),
  provider_id uuid not null references auth.users(id),
  receiver_id uuid not null references auth.users(id),
  source_kind text not null check (source_kind in ('listing', 'need_post')),
  source_id uuid not null,
  state text not null,
  created_at timestamptz not null default now(),
  check (provider_id <> receiver_id),
  constraint exchange_state_by_kind check (
    (kind = 'item' and state in ('approved', 'handoff_pending', 'checked_out', 'return_pending', 'returned', 'completed', 'cancelled', 'expired', 'closed_without_completion'))
    or (kind = 'help' and state in ('committed', 'scheduled', 'completion_pending', 'completed', 'cancelled', 'closed_without_completion'))
  )
);
create index exchanges_community on public.exchanges(community_id);
create index exchanges_provider on public.exchanges(provider_id);
create index exchanges_receiver on public.exchanges(receiver_id);

create table public.exchange_events (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  kind text not null,
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index exchange_events_exchange on public.exchange_events(exchange_id);
create unique index exchange_completion_settled_once on public.exchange_events(exchange_id) where kind = 'completion_settled';

create table public.qualifying_interactions (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  participant_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (exchange_id, participant_id)
);
create index qualifying_interactions_participant on public.qualifying_interactions(participant_id, community_id);

create table public.reputation_rules (
  rule text primary key,
  exchange_kind text not null check (exchange_kind in ('item', 'help')),
  recipient_role text not null check (recipient_role in ('provider', 'receiver')),
  points integer not null
);
insert into public.reputation_rules values
  ('item_owner_share', 'item', 'provider', 2),
  ('item_borrower_return', 'item', 'receiver', 1),
  ('help_helper_completed', 'help', 'provider', 3);

create table public.reputation_titles (
  title text primary key,
  min_score integer not null check (min_score between 0 and 100),
  max_score integer not null check (max_score between 0 and 100),
  check (min_score <= max_score)
);
insert into public.reputation_titles values
  ('Lumpen', 0, 39), ('Petty Bourgeoisie', 40, 54), ('Comrade', 55, 69),
  ('Revolutionary', 70, 84), ('General', 85, 94), ('Dictator', 95, 100);

create table public.reputation_events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  recipient_id uuid not null references auth.users(id),
  rule text not null check (char_length(rule) between 1 and 80),
  points integer not null check (points between -100 and 100),
  source_kind text not null check (char_length(source_kind) between 1 and 40),
  source_id uuid not null,
  exchange_id uuid references public.exchanges(id),
  verified_by_command text not null,
  verified_by uuid references auth.users(id),
  corrects_event_id uuid references public.reputation_events(id),
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  unique (rule, source_kind, source_id, recipient_id),
  check (corrects_event_id is null or (reason is not null and verified_by is not null))
);
create index reputation_events_recipient on public.reputation_events(recipient_id, community_id);
create index reputation_events_community on public.reputation_events(community_id, created_at);

-- Projection maintained by later Dispute and moderation commands; the redacted trust result reads only type and status.
create table public.trust_incidents (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  subject_id uuid not null references auth.users(id),
  type text not null check (type in ('unresolved_dispute', 'serious_violation')),
  status text not null check (status in ('open', 'unresolved', 'confirmed', 'resolved', 'overturned')),
  source_kind text not null,
  source_id uuid not null,
  created_at timestamptz not null default now(),
  unique (source_kind, source_id, subject_id, type)
);
create index trust_incidents_subject on public.trust_incidents(subject_id);

create function private.reject_history_rewrite()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '42501', message = TG_TABLE_NAME || ' is append-only.';
end;
$$;
create trigger reputation_events_append_only before update or delete on public.reputation_events
  for each row execute function private.reject_history_rewrite();
create trigger qualifying_interactions_append_only before update or delete on public.qualifying_interactions
  for each row execute function private.reject_history_rewrite();
create trigger exchange_events_append_only before update or delete on public.exchange_events
  for each row execute function private.reject_history_rewrite();
create trigger exchanges_no_delete before delete on public.exchanges
  for each row execute function private.reject_history_rewrite();

create function private.guard_exchange_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (NEW.community_id, NEW.kind, NEW.provider_id, NEW.receiver_id, NEW.source_kind, NEW.source_id, NEW.created_at)
    is distinct from (OLD.community_id, OLD.kind, OLD.provider_id, OLD.receiver_id, OLD.source_kind, OLD.source_id, OLD.created_at) then
    raise exception using errcode = '42501', message = 'Exchange identity is immutable.';
  end if;
  return NEW;
end;
$$;
create trigger exchanges_identity_immutable before update on public.exchanges
  for each row execute function private.guard_exchange_identity();

create function private.guard_qualifying_interaction()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.exchanges e where e.id = NEW.exchange_id and e.state = 'completed'
    and e.community_id = NEW.community_id and NEW.participant_id in (e.provider_id, e.receiver_id)) then
    raise exception using errcode = '23514', message = 'A Qualifying Interaction needs a completed Exchange participant.';
  end if;
  return NEW;
end;
$$;
create trigger qualifying_interaction_integrity before insert on public.qualifying_interactions
  for each row execute function private.guard_qualifying_interaction();

alter table public.exchanges enable row level security;
alter table public.exchange_events enable row level security;
alter table public.qualifying_interactions enable row level security;
alter table public.reputation_rules enable row level security;
alter table public.reputation_titles enable row level security;
alter table public.reputation_events enable row level security;
alter table public.trust_incidents enable row level security;
revoke all on public.exchanges, public.exchange_events, public.qualifying_interactions, public.reputation_rules,
  public.reputation_titles, public.reputation_events, public.trust_incidents from anon, authenticated;
grant select on public.exchanges, public.exchange_events, public.qualifying_interactions, public.reputation_rules,
  public.reputation_titles, public.reputation_events, public.trust_incidents to authenticated;
create policy exchange_read on public.exchanges for select to authenticated
  using (public.is_active_member(community_id));
create policy exchange_event_read on public.exchange_events for select to authenticated
  using (exists (select 1 from public.exchanges e where e.id = exchange_id));
create policy qualifying_interaction_read on public.qualifying_interactions for select to authenticated
  using (participant_id = auth.uid() or (public.is_active_member(community_id) and exists (
    select 1 from public.memberships m where m.community_id = qualifying_interactions.community_id and m.user_id = participant_id and m.status = 'active')));
create policy reputation_event_read on public.reputation_events for select to authenticated
  using (recipient_id = auth.uid() or (public.is_active_member(community_id) and exists (
    select 1 from public.memberships m where m.community_id = reputation_events.community_id and m.user_id = recipient_id and m.status = 'active')));
create policy trust_incident_read on public.trust_incidents for select to authenticated
  using (subject_id = auth.uid() or (public.is_active_member(community_id) and exists (
    select 1 from public.memberships m where m.community_id = trust_incidents.community_id and m.user_id = subject_id and m.status = 'active')));
create policy reputation_rule_read on public.reputation_rules for select to authenticated using (true);
create policy reputation_title_read on public.reputation_titles for select to authenticated using (true);

create function private.reputation_title(p_score integer, p_completed integer)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_completed = 0 then 'Unproven'
    else (select t.title from public.reputation_titles t where p_score between t.min_score and t.max_score) end;
$$;

create function private.community_score(p_subject uuid, p_community uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0, least(100, 50 + coalesce(sum(r.points), 0)))::integer
  from public.reputation_events r where r.recipient_id = p_subject and r.community_id = p_community;
$$;

create function private.community_standing(p_subject uuid, p_community uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with s as (
    select private.community_score(p_subject, p_community) as score,
      (select count(*) from public.qualifying_interactions q where q.participant_id = p_subject and q.community_id = p_community)::integer as completed
  )
  select jsonb_build_object('score', s.score, 'completedInteractions', s.completed, 'title', private.reputation_title(s.score, s.completed)) from s;
$$;

create function private.global_standing(p_subject uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with weights as (
    select q.community_id, count(*)::bigint as weight from public.qualifying_interactions q
    where q.participant_id = p_subject group by q.community_id
  ), totals as (
    select coalesce(sum(w.weight), 0)::bigint as total,
      coalesce(sum(w.weight * private.community_score(p_subject, w.community_id)), 0)::numeric as weighted
    from weights w
  ), result as (
    select case when total = 0 then 50 else floor((2 * weighted + total) / (2 * total))::integer end as score, total::integer as completed from totals
  )
  select jsonb_build_object('score', score, 'completedInteractions', completed, 'title', private.reputation_title(score, completed)) from result;
$$;

create function private.shares_active_community(p_subject uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships viewer join public.memberships subject on subject.community_id = viewer.community_id
    where viewer.user_id = auth.uid() and viewer.status = 'active' and subject.user_id = p_subject and subject.status = 'active'
  );
$$;

create function private.reputation_history(p_subject uuid, p_community uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'rule', r.rule, 'points', r.points, 'sourceKind', r.source_kind, 'exchangeId', r.exchange_id,
    'exchangeKind', e.kind, 'correctsEventId', r.corrects_event_id, 'reason', r.reason, 'createdAt', r.created_at
  ) order by r.created_at desc, r.id), '[]'::jsonb)
  from public.reputation_events r left join public.exchanges e on e.id = r.exchange_id
  where r.recipient_id = p_subject and r.community_id = p_community;
$$;

revoke all on function private.reputation_title(integer, integer), private.community_score(uuid, uuid), private.community_standing(uuid, uuid),
  private.global_standing(uuid), private.shares_active_community(uuid), private.reputation_history(uuid, uuid),
  private.reject_history_rewrite(), private.guard_exchange_identity(), private.guard_qualifying_interaction() from public, anon, authenticated;

create function public.global_trust(p_subject uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare standing jsonb;
begin
  if auth.uid() is null or p_subject is null or (p_subject <> auth.uid() and not private.shares_active_community(p_subject)) then
    raise exception using errcode = '42501', message = 'Global trust is available only for members of a Community you actively share.';
  end if;
  standing := private.global_standing(p_subject);
  return jsonb_build_object(
    'globalScore', standing->'score',
    'completedInteractions', standing->'completedInteractions',
    'incidents', coalesce((select jsonb_agg(jsonb_build_object('type', i.type, 'status', i.status) order by i.created_at, i.id)
      from public.trust_incidents i where i.subject_id = p_subject and i.status in ('open', 'unresolved', 'confirmed')), '[]'::jsonb)
  );
end;
$$;

create function public.member_directory(p_community_id uuid)
returns table(user_id uuid, email text, role text, joined_at timestamptz, score integer, title text, completed_interactions integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_member(p_community_id) then
    raise exception using errcode = '42501', message = 'Current active Community membership is required.';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.created_at, (s->>'score')::integer, s->>'title', (s->>'completedInteractions')::integer
    from public.memberships m join auth.users u on u.id = m.user_id
    cross join lateral private.community_standing(m.user_id, m.community_id) s
    where m.community_id = p_community_id and m.status = 'active'
    order by lower(u.email);
end;
$$;

create function public.member_profile(p_community_id uuid, p_subject uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  member public.memberships;
  standing jsonb;
begin
  if not public.is_active_member(p_community_id) then
    raise exception using errcode = '42501', message = 'Current active Community membership is required.';
  end if;
  select * into member from public.memberships where community_id = p_community_id and user_id = p_subject and status = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'This person is not an active member of this Community.';
  end if;
  standing := private.global_standing(p_subject);
  return jsonb_build_object(
    'userId', p_subject,
    'email', (select u.email from auth.users u where u.id = p_subject),
    'role', member.role,
    'joinedAt', member.created_at,
    'communityId', p_community_id,
    'local', private.community_standing(p_subject, p_community_id),
    'globalTitle', standing->'title',
    'trust', public.global_trust(p_subject),
    'history', private.reputation_history(p_subject, p_community_id),
    'sharedCommunities', coalesce((select jsonb_agg(jsonb_build_object('communityId', c.id, 'name', c.name, 'role', s.role) order by c.name)
      from public.memberships s join public.communities c on c.id = s.community_id
      where s.user_id = p_subject and s.status = 'active' and public.is_active_member(s.community_id)), '[]'::jsonb)
  );
end;
$$;

create function public.my_reputation()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception using errcode = '42501', message = 'Sign in first.'; end if;
  return jsonb_build_object(
    'userId', actor,
    'global', private.global_standing(actor),
    'communities', coalesce((select jsonb_agg(jsonb_build_object(
        'communityId', c.id, 'name', c.name, 'membershipStatus', coalesce(m.status, 'none'),
        'local', private.community_standing(actor, c.id), 'history', private.reputation_history(actor, c.id)
      ) order by (m.status = 'active') desc nulls last, c.name)
      from public.communities c left join public.memberships m on m.community_id = c.id and m.user_id = actor
      where (m.status is not null and m.status in ('active', 'suspended', 'removed'))
        or exists (select 1 from public.reputation_events r where r.recipient_id = actor and r.community_id = c.id)
        or exists (select 1 from public.qualifying_interactions q where q.participant_id = actor and q.community_id = c.id)), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.global_trust(uuid), public.member_directory(uuid), public.member_profile(uuid, uuid), public.my_reputation() from public, anon;
grant execute on function public.global_trust(uuid), public.member_directory(uuid), public.member_profile(uuid, uuid), public.my_reputation() to authenticated;

-- Completion producer contract for later item and help finalize commands. Rule, source, and recipient identify each award.
create function private.settle_exchange_completion(p_exchange_id uuid)
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
      r.rule, r.points, 'exchange', exchange.id, exchange.id, 'settle_exchange_completion'
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
revoke all on function private.settle_exchange_completion(uuid) from public, anon, authenticated;

create function public.settle_exchange_completions(p_exchange_ids uuid[])
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(private.settle_exchange_completion(id) order by ordinality), '[]'::jsonb)
  from unnest(p_exchange_ids) with ordinality as ids(id, ordinality);
$$;
revoke all on function public.settle_exchange_completions(uuid[]) from public, anon, authenticated;
grant execute on function public.settle_exchange_completions(uuid[]) to service_role;

notify pgrst, 'reload schema';
