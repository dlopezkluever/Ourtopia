create table public.disciplinary_votes (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  accused_id uuid not null references auth.users(id),
  opened_by uuid not null references auth.users(id),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  opened_at timestamptz not null default clock_timestamp(),
  closes_at timestamptz not null,
  eligible_count integer not null check (eligible_count > 0),
  state text not null default 'open' check (state in ('open', 'passed', 'failed')),
  turnout integer,
  remove_votes integer,
  retain_votes integer,
  closed_at timestamptz,
  event_id uuid not null unique references public.community_events(id),
  check (closes_at = opened_at + interval '168 hours'),
  check ((state = 'open') = (closed_at is null)),
  check ((state = 'open') = (turnout is null and remove_votes is null and retain_votes is null)),
  check (turnout is null or (turnout = remove_votes + retain_votes and turnout <= eligible_count and remove_votes >= 0 and retain_votes >= 0)),
  check (state = 'open' or state = case when eligible_count > 0 and turnout >= ceil(eligible_count * 0.30)::integer
    and 3 * remove_votes >= 2 * turnout then 'passed' else 'failed' end)
);
create unique index disciplinary_one_open_vote_per_accused
  on public.disciplinary_votes(community_id, accused_id) where state = 'open';
create index disciplinary_votes_community on public.disciplinary_votes(community_id, opened_at desc);

create table public.disciplinary_vote_electorate (
  vote_id uuid not null references public.disciplinary_votes(id),
  voter_id uuid not null references auth.users(id),
  primary key (vote_id, voter_id)
);

create table public.disciplinary_vote_ballots (
  vote_id uuid not null,
  voter_id uuid not null,
  choice text not null check (choice in ('remove', 'retain')),
  intent_id uuid not null,
  event_id uuid not null unique references public.community_events(id),
  cast_at timestamptz not null default clock_timestamp(),
  primary key (vote_id, voter_id),
  foreign key (vote_id, voter_id) references public.disciplinary_vote_electorate(vote_id, voter_id)
);

create table public.disciplinary_vote_evidence (
  id uuid primary key default gen_random_uuid(),
  vote_id uuid not null references public.disciplinary_votes(id),
  author_id uuid not null references auth.users(id),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp()
);

create table public.disciplinary_vote_responses (
  id uuid primary key default gen_random_uuid(),
  vote_id uuid not null references public.disciplinary_votes(id),
  author_id uuid not null references auth.users(id),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.moderation_actions add column disciplinary_vote_id uuid references public.disciplinary_votes(id);
create index moderation_action_vote on public.moderation_actions(disciplinary_vote_id) where disciplinary_vote_id is not null;

create function private.guard_disciplinary_vote() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception using errcode = '42501', message = 'Vote history is retained.'; end if;
  if tg_op = 'UPDATE' then
    if (new.id, new.community_id, new.accused_id, new.opened_by, new.reason, new.opened_at, new.closes_at,
      new.eligible_count, new.event_id) is distinct from (old.id, old.community_id, old.accused_id, old.opened_by,
      old.reason, old.opened_at, old.closes_at, old.eligible_count, old.event_id) then
      raise exception using errcode = '42501', message = 'Vote identity is immutable.';
    end if;
    if old.state <> 'open' or new.state not in ('passed', 'failed') or new.closed_at is null or new.closed_at < old.closes_at
      or new.turnout is null or new.remove_votes is null or new.retain_votes is null then
      raise exception using errcode = '55000', message = 'A vote result can only be recorded once.';
    end if;
  end if;
  return new;
end;
$$;
create trigger disciplinary_vote_integrity before update or delete on public.disciplinary_votes
  for each row execute function private.guard_disciplinary_vote();
create trigger disciplinary_vote_electorate_append_only before update or delete on public.disciplinary_vote_electorate
  for each row execute function private.reject_history_rewrite();
create trigger disciplinary_vote_ballot_append_only before update or delete on public.disciplinary_vote_ballots
  for each row execute function private.reject_history_rewrite();
create trigger disciplinary_vote_evidence_append_only before update or delete on public.disciplinary_vote_evidence
  for each row execute function private.reject_history_rewrite();
create trigger disciplinary_vote_response_append_only before update or delete on public.disciplinary_vote_responses
  for each row execute function private.reject_history_rewrite();

create function public.can_read_disciplinary_vote(p_vote_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.disciplinary_votes v
    where v.id = p_vote_id and (public.is_active_member(v.community_id) or v.accused_id = auth.uid()))
$$;
revoke all on function public.can_read_disciplinary_vote(uuid) from public, anon;
grant execute on function public.can_read_disciplinary_vote(uuid) to authenticated;

alter table public.disciplinary_votes enable row level security;
alter table public.disciplinary_vote_electorate enable row level security;
alter table public.disciplinary_vote_ballots enable row level security;
alter table public.disciplinary_vote_evidence enable row level security;
alter table public.disciplinary_vote_responses enable row level security;
revoke all on public.disciplinary_votes, public.disciplinary_vote_electorate, public.disciplinary_vote_ballots,
  public.disciplinary_vote_evidence, public.disciplinary_vote_responses from anon, authenticated;
grant select on public.disciplinary_votes, public.disciplinary_vote_evidence, public.disciplinary_vote_responses to authenticated;
create policy disciplinary_vote_read on public.disciplinary_votes for select to authenticated
  using (public.can_read_disciplinary_vote(id));
create policy disciplinary_vote_evidence_read on public.disciplinary_vote_evidence for select to authenticated
  using (public.can_read_disciplinary_vote(vote_id));
create policy disciplinary_vote_response_read on public.disciplinary_vote_responses for select to authenticated
  using (public.can_read_disciplinary_vote(vote_id));
create policy disciplinary_vote_electorate_read on public.disciplinary_vote_electorate for select to authenticated
  using (voter_id = auth.uid() and public.can_read_disciplinary_vote(vote_id));
create policy disciplinary_vote_ballot_read on public.disciplinary_vote_ballots for select to authenticated
  using (voter_id = auth.uid() and public.can_read_disciplinary_vote(vote_id));

create function private.enqueue_vote_notice(p_vote uuid, p_event uuid, p_recipient uuid, p_kind text, p_due_at timestamptz default null)
returns void language plpgsql security definer set search_path = '' as $$
declare item public.disciplinary_votes;
begin
  select * into item from public.disciplinary_votes where id = p_vote;
  if p_due_at is null then
    insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select p_event, item.community_id, p_recipient, channel, p_kind from unnest(array['in_app', 'email']) channel
    on conflict (event_id, recipient_id, channel, kind) do nothing;
  else
    perform public.schedule_notification_reminder(item.community_id, item.id, p_event, p_recipient, 'in_app', p_kind, p_due_at);
    perform public.schedule_notification_reminder(item.community_id, item.id, p_event, p_recipient, 'email', p_kind, p_due_at);
  end if;
end;
$$;

create function public.open_disciplinary_vote(p_intent_id uuid, p_community_id uuid, p_accused_id uuid, p_reason text, p_evidence text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); payload jsonb; prior public.command_intents; member public.memberships; vote public.disciplinary_votes; event uuid; outcome jsonb; eligible_voters uuid[]; vote_opened_at timestamptz;
begin
  perform public.require_current_membership(p_community_id, true);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  payload := jsonb_build_object('community_id', p_community_id, 'accused_id', p_accused_id, 'reason', p_reason, 'evidence', p_evidence);
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'open_disciplinary_vote' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 or p_evidence is null or char_length(btrim(p_evidence)) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'Provide a reason and submitted evidence within the length limits.';
  end if;
  select * into member from public.memberships where community_id = p_community_id and user_id = p_accused_id and status in ('active', 'suspended') for share;
  if not found or p_accused_id = actor then raise exception using errcode = '42501', message = 'The accused member is unavailable.'; end if;
  select array_agg(user_id order by user_id) into eligible_voters from public.memberships
    where community_id = p_community_id and status = 'active' and user_id <> p_accused_id;
  if coalesce(cardinality(eligible_voters), 0) = 0 then raise exception using errcode = '55000', message = 'A removal vote needs at least one eligible voter.'; end if;
  if exists(select 1 from public.disciplinary_votes where community_id = p_community_id and accused_id = p_accused_id and state = 'open') then
    raise exception using errcode = '55000', message = 'An open removal vote already exists for this member.';
  end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community_id, actor, 'disciplinary_vote_opened', p_intent_id) returning id into event;
  vote_opened_at := clock_timestamp();
  insert into public.disciplinary_votes(community_id, accused_id, opened_by, reason, opened_at, closes_at, eligible_count, event_id)
    values(p_community_id, p_accused_id, actor, btrim(p_reason), vote_opened_at, vote_opened_at + interval '168 hours', cardinality(eligible_voters), event)
    returning * into vote;
  insert into public.disciplinary_vote_electorate(vote_id, voter_id)
    select vote.id, voter_id from unnest(eligible_voters) voter_id;
  insert into public.disciplinary_vote_evidence(vote_id, author_id, body) values(vote.id, actor, btrim(p_evidence));
  perform private.enqueue_vote_notice(vote.id, event, p_accused_id, 'disciplinary_vote_opened');
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, p_community_id, voter_id, channel, 'disciplinary_vote_opened'
    from public.disciplinary_vote_electorate cross join unnest(array['in_app', 'email']) channel where vote_id = vote.id
    on conflict (event_id, recipient_id, channel, kind) do nothing;
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(p_community_id, actor, 'disciplinary_vote_reminder_scheduled', md5(p_intent_id::text || ':ending-soon')::uuid) returning id into event;
  for member in select m.* from public.memberships m
    where m.community_id = p_community_id and (m.user_id = vote.accused_id or exists(
      select 1 from public.disciplinary_vote_electorate e where e.vote_id = vote.id and e.voter_id = m.user_id))
  loop
    perform private.enqueue_vote_notice(vote.id, event, member.user_id, 'disciplinary_vote_ending_soon', vote.closes_at - interval '24 hours');
  end loop;
  insert into public.notification_hints(recipient_id) values(p_accused_id);
  outcome := jsonb_build_object('vote_id', vote.id, 'community_id', p_community_id, 'accused_id', p_accused_id,
    'opened_at', vote.opened_at, 'closes_at', vote.closes_at, 'eligible_count', vote.eligible_count, 'state', vote.state);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'open_disciplinary_vote', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.open_disciplinary_vote(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.open_disciplinary_vote(uuid, uuid, uuid, text, text) to authenticated;

create function public.submit_disciplinary_response(p_intent_id uuid, p_vote_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); vote public.disciplinary_votes; payload jsonb := jsonb_build_object('vote_id', p_vote_id, 'body', p_body); prior public.command_intents; event uuid; response_id uuid; outcome jsonb;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Sign in to respond.'; end if;
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'submit_disciplinary_response' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then raise exception using errcode = '22023', message = 'Write a response up to 4000 characters.'; end if;
  select * into vote from public.disciplinary_votes where id = p_vote_id for update;
  if not found or vote.accused_id <> actor or vote.state <> 'open' or clock_timestamp() >= vote.closes_at then
    raise exception using errcode = '42501', message = 'The response window is closed or unavailable.';
  end if;
  perform 1 from public.memberships where community_id = vote.community_id and user_id = actor and status in ('active', 'suspended') for share;
  if not found then raise exception using errcode = '42501', message = 'The response window is closed or unavailable.'; end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(vote.community_id, actor, 'disciplinary_vote_response', p_intent_id) returning id into event;
  insert into public.disciplinary_vote_responses(vote_id, author_id, body) values(vote.id, actor, btrim(p_body)) returning id into response_id;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, vote.community_id, vote.opened_by, channel, 'disciplinary_vote_response' from unnest(array['in_app', 'email']) channel
    on conflict (event_id, recipient_id, channel, kind) do nothing;
  outcome := jsonb_build_object('vote_id', vote.id, 'response_id', response_id, 'created_at', clock_timestamp());
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'submit_disciplinary_response', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.submit_disciplinary_response(uuid, uuid, text) from public, anon;
grant execute on function public.submit_disciplinary_response(uuid, uuid, text) to authenticated;

create function public.cast_disciplinary_ballot(p_intent_id uuid, p_vote_id uuid, p_choice text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); vote public.disciplinary_votes; payload jsonb := jsonb_build_object('vote_id', p_vote_id, 'choice', p_choice); prior public.command_intents; event uuid; outcome jsonb;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Sign in to vote.'; end if;
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'cast_disciplinary_ballot' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  select * into vote from public.disciplinary_votes where id = p_vote_id for update;
  if not found or vote.state <> 'open' or clock_timestamp() >= vote.closes_at or p_choice is null or p_choice not in ('remove', 'retain')
    or not exists(select 1 from public.disciplinary_vote_electorate where vote_id = p_vote_id and voter_id = actor) then
    raise exception using errcode = '42501', message = 'You are not currently authorized to cast this ballot.';
  end if;
  perform 1 from public.memberships where community_id = vote.community_id and user_id = actor and status = 'active' for share;
  if not found then raise exception using errcode = '42501', message = 'You are not currently authorized to cast this ballot.'; end if;
  if exists(select 1 from public.disciplinary_vote_ballots where vote_id = p_vote_id and voter_id = actor) then
    raise exception using errcode = '23505', message = 'You have already cast an immutable ballot.';
  end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(vote.community_id, actor, 'disciplinary_vote_ballot_cast', p_intent_id) returning id into event;
  insert into public.disciplinary_vote_ballots(vote_id, voter_id, choice, intent_id, event_id) values(vote.id, actor, p_choice, p_intent_id, event);
  outcome := jsonb_build_object('vote_id', vote.id, 'choice', p_choice, 'cast_at', clock_timestamp());
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'cast_disciplinary_ballot', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.cast_disciplinary_ballot(uuid, uuid, text) from public, anon;
grant execute on function public.cast_disciplinary_ballot(uuid, uuid, text) to authenticated;

create function public.disciplinary_vote_result(p_eligible integer, p_remove integer, p_retain integer)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare turnout integer; required integer; passed boolean;
begin
  if p_eligible is null or p_remove is null or p_retain is null or p_eligible < 0 or p_remove < 0 or p_retain < 0 then
    raise exception using errcode = '22023', message = 'Provide nonnegative vote counts.';
  end if;
  turnout := p_remove + p_retain;
  if turnout > p_eligible then raise exception using errcode = '22023', message = 'Turnout cannot exceed the frozen electorate.'; end if;
  required := ceil(p_eligible * 0.30)::integer;
  passed := p_eligible > 0 and turnout >= required and 3 * p_remove >= 2 * turnout;
  return jsonb_build_object('eligible_count', p_eligible, 'required_turnout', required, 'turnout', turnout,
    'remove_votes', p_remove, 'retain_votes', p_retain, 'state', case when passed then 'passed' else 'failed' end);
end;
$$;
revoke all on function public.disciplinary_vote_result(integer, integer, integer) from public, anon;
grant execute on function public.disciplinary_vote_result(integer, integer, integer) to authenticated;

create function private.close_disciplinary_vote(p_vote_id uuid, p_actor uuid, p_worker boolean, p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare vote public.disciplinary_votes; intent uuid; v_payload jsonb; prior public.command_intents; remove_count integer; retain_count integer; turnout_count integer; v_result jsonb; event uuid; outcome jsonb;
begin
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  intent := p_intent_id;
  v_payload := jsonb_build_object('vote_id', p_vote_id);
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || intent::text, 0));
  select * into prior from public.command_intents where actor_id = p_actor and intent_id = intent;
  if found then
    if prior.command <> 'close_disciplinary_vote' or prior.payload <> v_payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  select * into vote from public.disciplinary_votes where id = p_vote_id for update;
  if not found then raise exception using errcode = '22023', message = 'Vote unavailable.'; end if;
  if not p_worker and p_actor = vote.accused_id then
    raise exception using errcode = '42501', message = 'The accused member cannot close their own removal vote.';
  end if;
  if vote.state <> 'open' then
    select ci.result into outcome from public.command_intents ci
      where ci.command = 'close_disciplinary_vote' and ci.payload = v_payload and ci.result->>'vote_id' = vote.id::text
      order by ci.created_at desc limit 1;
    if not found then
      outcome := jsonb_build_object('vote_id', vote.id, 'state', vote.state, 'eligible_count', vote.eligible_count,
        'required_turnout', ceil(vote.eligible_count * 0.30)::integer, 'turnout', vote.turnout,
        'remove_votes', vote.remove_votes, 'retain_votes', vote.retain_votes, 'closed_at', vote.closed_at, 'event_id', null);
    end if;
    insert into public.command_intents(actor_id, intent_id, command, payload, result)
      values(p_actor, intent, 'close_disciplinary_vote', v_payload, outcome);
    return outcome;
  end if;
  if clock_timestamp() < vote.closes_at then raise exception using errcode = '55000', message = 'This vote cannot close before its deadline.'; end if;
  if not p_worker and (p_actor <> auth.uid() or not public.is_community_administrator(vote.community_id)) then
    raise exception using errcode = '42501', message = 'Only an active Community administrator can close this vote.';
  end if;
  select count(*) filter(where choice = 'remove')::integer, count(*) filter(where choice = 'retain')::integer
    into remove_count, retain_count from public.disciplinary_vote_ballots where vote_id = vote.id;
  turnout_count := remove_count + retain_count;
  v_result := public.disciplinary_vote_result(vote.eligible_count, remove_count, retain_count);
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(vote.community_id, p_actor, 'disciplinary_vote_closed', intent) returning id into event;
  update public.disciplinary_votes set state = v_result->>'state', turnout = turnout_count,
    remove_votes = remove_count, retain_votes = retain_count, closed_at = clock_timestamp() where id = vote.id returning * into vote;
  insert into public.command_intents(actor_id, intent_id, command, payload, result)
    values(p_actor, intent, 'close_disciplinary_vote', v_payload, jsonb_build_object('vote_id', vote.id, 'state', vote.state,
      'eligible_count', vote.eligible_count, 'turnout', turnout_count, 'remove_votes', remove_count, 'retain_votes', retain_count,
      'required_turnout', v_result->'required_turnout', 'closed_at', vote.closed_at, 'event_id', event));
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select event, vote.community_id, recipient, channel, 'disciplinary_vote_closed'
    from (select vote.accused_id as recipient union select voter_id from public.disciplinary_vote_electorate where vote_id = vote.id) people
    cross join unnest(array['in_app', 'email']) channel on conflict (event_id, recipient_id, channel, kind) do nothing;
  return (select ci.result from public.command_intents ci where ci.actor_id = p_actor and ci.intent_id = intent);
end;
$$;
revoke all on function private.close_disciplinary_vote(uuid, uuid, boolean, uuid) from public, anon, authenticated;

create function public.close_disciplinary_vote(p_intent_id uuid, p_vote_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare vote public.disciplinary_votes;
begin
  select * into vote from public.disciplinary_votes where id = p_vote_id;
  if not found then raise exception using errcode = '42501', message = 'Vote unavailable.'; end if;
  perform public.require_current_membership(vote.community_id, true);
  if auth.uid() = vote.accused_id then raise exception using errcode = '42501', message = 'The accused member cannot close their own removal vote.'; end if;
  return private.close_disciplinary_vote(p_vote_id, auth.uid(), false, p_intent_id);
end;
$$;
revoke all on function public.close_disciplinary_vote(uuid, uuid) from public, anon;
grant execute on function public.close_disciplinary_vote(uuid, uuid) to authenticated;

create function public.process_due_disciplinary_votes() returns jsonb language plpgsql security definer set search_path = '' as $$
declare item record; count_closed integer := 0;
begin
  for item in select id, opened_by from public.disciplinary_votes where state = 'open' and closes_at <= clock_timestamp() order by closes_at limit 100
  loop
    perform private.close_disciplinary_vote(item.id, item.opened_by, true, md5(item.id::text || ':close')::uuid);
    count_closed := count_closed + 1;
  end loop;
  return jsonb_build_object('closed', count_closed);
end;
$$;
revoke all on function public.process_due_disciplinary_votes() from public, anon, authenticated;
grant execute on function public.process_due_disciplinary_votes() to service_role;

create function public.enact_disciplinary_removal(p_intent_id uuid, p_vote_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); vote public.disciplinary_votes; member public.memberships; payload jsonb := jsonb_build_object('vote_id', p_vote_id, 'reason', p_reason); prior public.command_intents; event uuid; action_id uuid; outcome jsonb;
begin
  select * into vote from public.disciplinary_votes where id = p_vote_id;
  if not found then raise exception using errcode = '42501', message = 'Vote unavailable.'; end if;
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform public.require_current_membership(vote.community_id, true);
  if auth.uid() = vote.accused_id then raise exception using errcode = '42501', message = 'The accused member cannot enact their own removal.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'enact_disciplinary_removal' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then raise exception using errcode = '22023', message = 'Give a reason of up to 1000 characters.'; end if;
  select * into vote from public.disciplinary_votes where id = p_vote_id for update;
  if vote.state <> 'passed' then raise exception using errcode = '55000', message = 'Only a passed vote authorizes removal.'; end if;
  select * into member from public.memberships where community_id = vote.community_id and user_id = vote.accused_id for update;
  if not found or member.status not in ('active', 'suspended') then raise exception using errcode = '55000', message = 'The accused membership is no longer removable.'; end if;
  if member.role = 'administrator' and not exists(select 1 from public.memberships where community_id = vote.community_id and role = 'administrator' and status = 'active' and user_id <> vote.accused_id) then
    raise exception using errcode = '55000', message = 'A Community needs at least one active administrator.';
  end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(vote.community_id, actor, 'member_removed_by_disciplinary_vote', p_intent_id) returning id into event;
  update public.memberships set status = 'removed' where community_id = vote.community_id and user_id = vote.accused_id;
  insert into public.moderation_actions(community_id, actor_id, subject_kind, subject_id, subject_user_id, action, reason, intent_id, event_id, disciplinary_vote_id)
    values(vote.community_id, actor, 'membership', vote.accused_id, vote.accused_id, 'remove', btrim(p_reason), p_intent_id, event, vote.id) returning id into action_id;
  perform private.enqueue_moderation_notice(event, vote.community_id, vote.accused_id, 'membership_removed');
  insert into public.notification_hints(recipient_id) values(vote.accused_id);
  outcome := jsonb_build_object('vote_id', vote.id, 'community_id', vote.community_id, 'user_id', vote.accused_id, 'status', 'removed', 'action_id', action_id, 'event_id', event);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'enact_disciplinary_removal', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.enact_disciplinary_removal(uuid, uuid, text) from public, anon;
grant execute on function public.enact_disciplinary_removal(uuid, uuid, text) to authenticated;

create function public.read_disciplinary_vote(p_vote_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare vote public.disciplinary_votes;
begin
  select * into vote from public.disciplinary_votes where id = p_vote_id;
  if not found or not public.can_read_disciplinary_vote(p_vote_id) then raise exception using errcode = '42501', message = 'Vote unavailable.'; end if;
  return jsonb_build_object('id', vote.id, 'community_id', vote.community_id, 'accused_id', vote.accused_id, 'opened_by', vote.opened_by,
    'reason', vote.reason, 'opened_at', vote.opened_at, 'closes_at', vote.closes_at, 'eligible_count', vote.eligible_count,
    'state', vote.state, 'turnout', vote.turnout, 'remove_votes', vote.remove_votes, 'retain_votes', vote.retain_votes,
    'closed_at', vote.closed_at, 'can_respond', auth.uid() = vote.accused_id and vote.state = 'open' and clock_timestamp() < vote.closes_at
      and exists(select 1 from public.memberships where community_id = vote.community_id and user_id = auth.uid() and status in ('active', 'suspended')),
    'can_close', vote.state = 'open' and clock_timestamp() >= vote.closes_at and public.is_community_administrator(vote.community_id),
    'my_ballot', (select choice from public.disciplinary_vote_ballots where vote_id = vote.id and voter_id = auth.uid()),
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'author_id', e.author_id, 'body', e.body, 'created_at', e.created_at) order by e.created_at, e.id) from public.disciplinary_vote_evidence e where e.vote_id = vote.id), '[]'::jsonb),
    'responses', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'author_id', r.author_id, 'body', r.body, 'created_at', r.created_at) order by r.created_at, r.id) from public.disciplinary_vote_responses r where r.vote_id = vote.id), '[]'::jsonb),
    'can_vote', vote.state = 'open' and clock_timestamp() < vote.closes_at and exists(select 1 from public.disciplinary_vote_electorate e join public.memberships m on m.community_id = vote.community_id and m.user_id = e.voter_id where e.vote_id = vote.id and e.voter_id = auth.uid() and m.status = 'active'));
end;
$$;
revoke all on function public.read_disciplinary_vote(uuid) from public, anon;
grant execute on function public.read_disciplinary_vote(uuid) to authenticated;

create function public.list_disciplinary_votes(p_community_id uuid) returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_member(p_community_id) then raise exception using errcode = '42501', message = 'Current active Community membership is required.'; end if;
  return query select public.read_disciplinary_vote(id) from public.disciplinary_votes where community_id = p_community_id order by opened_at desc;
end;
$$;
revoke all on function public.list_disciplinary_votes(uuid) from public, anon;
grant execute on function public.list_disciplinary_votes(uuid) to authenticated;

create function public.list_my_defense_votes() returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'Sign in to view your defense records.'; end if;
  return query select public.read_disciplinary_vote(v.id) from public.disciplinary_votes v
    join public.memberships m on m.community_id = v.community_id and m.user_id = v.accused_id and m.status in ('active', 'suspended', 'removed')
    where v.accused_id = auth.uid() order by v.opened_at desc;
end;
$$;
revoke all on function public.list_my_defense_votes() from public, anon;
grant execute on function public.list_my_defense_votes() to authenticated;

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
  if p_notice.reminder_id is not null and p_notice.kind like 'disciplinary_vote\_%' and not exists(
    select 1 from public.disciplinary_votes v join public.memberships m on m.community_id = v.community_id and m.user_id = p_notice.recipient_id
    where v.id = (select source_key from public.notification_reminders where id = p_notice.reminder_id)
      and v.state = 'open' and clock_timestamp() < v.closes_at
      and ((p_notice.recipient_id = v.accused_id and m.status in ('active', 'suspended'))
        or (m.status = 'active' and exists(select 1 from public.disciplinary_vote_electorate e where e.vote_id = v.id and e.voter_id = m.user_id)))) then
    return false;
  end if;
  if p_notice.reminder_id is null then return true; end if;
  select * into reminder from public.notification_reminders where id = p_notice.reminder_id for share;
  return found and reminder.event_id = p_notice.event_id and reminder.due_at = p_notice.reminder_due_at;
end;
$$;

select cron.schedule('ourtopia-disciplinary-vote-deadlines', '* * * * *', 'select public.process_due_disciplinary_votes()');
revoke all on function private.guard_disciplinary_vote(), private.enqueue_vote_notice(uuid, uuid, uuid, text, timestamptz),
  private.close_disciplinary_vote(uuid, uuid, boolean, uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';
