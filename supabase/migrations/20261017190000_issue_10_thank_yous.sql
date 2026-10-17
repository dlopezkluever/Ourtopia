create table public.exchange_thank_yous (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  exchange_id uuid not null references public.exchanges(id),
  author_id uuid not null references auth.users(id),
  recipient_id uuid not null references auth.users(id),
  event_id uuid not null unique references public.community_events(id),
  message text not null check (char_length(btrim(message)) between 1 and 500),
  created_at timestamptz not null default now(),
  check (author_id <> recipient_id)
);
create index exchange_thank_yous_recipient on public.exchange_thank_yous(community_id, recipient_id, created_at desc);
create index exchange_thank_yous_exchange on public.exchange_thank_yous(exchange_id, created_at);
create index exchange_thank_yous_feed on public.exchange_thank_yous(community_id, created_at desc);

create trigger exchange_thank_yous_append_only before update or delete on public.exchange_thank_yous
  for each row execute function private.reject_history_rewrite();
create function private.guard_exchange_thank_you() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.exchanges e where e.id = new.exchange_id and e.community_id = new.community_id
      and e.state = 'completed' and new.author_id in (e.provider_id, e.receiver_id)
      and new.recipient_id in (e.provider_id, e.receiver_id) and new.author_id <> new.recipient_id
      and exists (select 1 from public.community_events v where v.id = new.event_id and v.community_id = new.community_id
        and v.actor_id = new.author_id and v.kind = 'exchange_thank_you')
  ) then
    raise exception using errcode = '23514', message = 'A thank-you must name the other participant of a completed Exchange.';
  end if;
  return new;
end;
$$;
create trigger exchange_thank_you_integrity before insert on public.exchange_thank_yous
  for each row execute function private.guard_exchange_thank_you();

alter table public.exchange_thank_yous enable row level security;
revoke all on public.exchange_thank_yous from anon, authenticated;
grant select on public.exchange_thank_yous to authenticated;
create policy exchange_thank_you_read on public.exchange_thank_yous for select to authenticated
  using (public.is_active_member(community_id));

create unique index one_exchange_thank_you_reward on public.reputation_events(exchange_id)
  where rule = 'exchange_thank_you' and corrects_event_id is null;

create function public.thank_exchange(p_intent_id uuid, p_exchange_id uuid, p_message text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  exchange public.exchanges;
  prior public.command_intents;
  thank_you public.exchange_thank_yous;
  audit_event uuid;
  payload jsonb;
  result jsonb;
  award boolean;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Sign in first.'; end if;
  if p_intent_id is null or p_exchange_id is null or p_message is null or char_length(btrim(p_message)) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Write a thank-you of 1 to 500 characters.';
  end if;
  payload := jsonb_build_object('exchange_id', p_exchange_id, 'message', btrim(p_message));
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'thank_exchange' or prior.payload <> payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    return prior.result;
  end if;

  select * into exchange from public.exchanges where id = p_exchange_id for update;
  if not found then raise exception using errcode = '42501', message = 'Exchange unavailable.'; end if;
  if exchange.state <> 'completed' then raise exception using errcode = '55000', message = 'Only a completed Exchange can receive a thank-you.'; end if;
  if actor not in (exchange.provider_id, exchange.receiver_id) then raise exception using errcode = '42501', message = 'Only an Exchange participant can thank their partner.'; end if;
  perform 1 from public.memberships where community_id = exchange.community_id and user_id = actor and status = 'active' for share;
  if not found then raise exception using errcode = '42501', message = 'Current active Community membership is required.'; end if;
  perform 1 from public.memberships where community_id = exchange.community_id
    and user_id = case when actor = exchange.provider_id then exchange.receiver_id else exchange.provider_id end
    and status = 'active' for share;
  if not found then raise exception using errcode = '55000', message = 'Your Exchange partner is no longer an active Community member.'; end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(exchange.community_id, actor, 'exchange_thank_you', p_intent_id) returning id into audit_event;
  insert into public.exchange_thank_yous(community_id, exchange_id, author_id, recipient_id, event_id, message)
    values(exchange.community_id, exchange.id, actor,
      case when actor = exchange.provider_id then exchange.receiver_id else exchange.provider_id end,
      audit_event, btrim(p_message)) returning * into thank_you;
  award := not exists (select 1 from public.reputation_events r where r.exchange_id = exchange.id and r.rule = 'exchange_thank_you' and r.corrects_event_id is null);
  if award then
    insert into public.reputation_events(community_id, recipient_id, rule, points, source_kind, source_id, exchange_id, verified_by_command)
      values(exchange.community_id, thank_you.recipient_id, 'exchange_thank_you', 1, 'thank_you', thank_you.id, exchange.id, 'thank_exchange');
  end if;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
    select audit_event, exchange.community_id, thank_you.recipient_id, channel, 'exchange_thank_you'
    from unnest(array['in_app', 'email']) channel
    on conflict (event_id, recipient_id, channel, kind) do nothing;
  insert into public.notification_hints(recipient_id) values(thank_you.recipient_id);
  result := to_jsonb(thank_you) || jsonb_build_object('points_awarded', award);
  insert into public.command_intents(actor_id, intent_id, command, payload, result)
    values(actor, p_intent_id, 'thank_exchange', payload, result);
  return result;
end;
$$;

create or replace function public.read_community_feed(p_community_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_member(p_community_id) then
    raise exception using errcode = '42501', message = 'Current active Community membership is required.';
  end if;
  return coalesce((
    select jsonb_agg(item order by created_at desc, id)
    from (
      select entries.id, entries.created_at, entries.item
      from (
        select f.id, f.created_at, jsonb_build_object('id', f.id, 'kind', f.kind, 'title', l.title, 'completed_at', f.created_at,
          'owner', (select u.email from auth.users u join public.memberships m on m.user_id = u.id where u.id = f.owner_id and m.community_id = f.community_id and m.status = 'active'),
          'borrower', (select u.email from auth.users u join public.memberships m on m.user_id = u.id where u.id = f.borrower_id and m.community_id = f.community_id and m.status = 'active')) as item
        from public.community_feed f join public.listings l on l.id = f.listing_id where f.community_id = p_community_id
        union all
        select t.id, t.created_at, jsonb_build_object('id', t.id, 'kind', 'exchange_thank_you', 'message', t.message,
          'created_at', t.created_at,
          'author', (select u.email from auth.users u join public.memberships m on m.user_id = u.id where u.id = t.author_id and m.community_id = t.community_id and m.status = 'active'),
          'recipient', (select u.email from auth.users u join public.memberships m on m.user_id = u.id where u.id = t.recipient_id and m.community_id = t.community_id and m.status = 'active')) as item
        from public.exchange_thank_yous t where t.community_id = p_community_id
      ) entries
      order by entries.created_at desc, entries.id
      limit 20
    ) page
  ), '[]'::jsonb);
end;
$$;

revoke all on function private.guard_exchange_thank_you() from public, anon, authenticated;
revoke all on function public.thank_exchange(uuid, uuid, text), public.read_community_feed(uuid) from public, anon;
grant execute on function public.thank_exchange(uuid, uuid, text), public.read_community_feed(uuid) to authenticated;
notify pgrst, 'reload schema';
