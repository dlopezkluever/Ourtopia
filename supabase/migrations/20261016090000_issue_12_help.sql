-- Help Listings, Help Need Posts, commitments, Need Post places, and help Exchange detail (ADRs 0003, 0004, 0008).
create table public.help_listings (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  owner_id uuid not null references auth.users(id),
  title text not null check (char_length(title) between 3 and 120 and title = btrim(title)),
  description text not null default '' check (char_length(description) <= 2000),
  category text not null check (category in ('moving', 'repairs', 'yard_garden', 'tech', 'tutoring', 'cooking', 'care', 'errands', 'other')),
  skill text not null check (char_length(skill) between 2 and 120),
  skill_level text not null check (skill_level in ('beginner', 'intermediate', 'experienced', 'professional')),
  availability text not null check (char_length(availability) between 2 and 500),
  geographic_constraints text not null check (char_length(geographic_constraints) between 2 and 500),
  scheduling_preferences text not null default '' check (char_length(scheduling_preferences) <= 500),
  status text not null default 'open' check (status in ('open', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, community_id)
);
create index help_listings_community on public.help_listings(community_id, status, created_at desc);

create table public.help_need_posts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  owner_id uuid not null references auth.users(id),
  title text not null check (char_length(title) between 3 and 120 and title = btrim(title)),
  description text not null default '' check (char_length(description) <= 2000),
  category text not null check (category in ('moving', 'repairs', 'yard_garden', 'tech', 'tutoring', 'cooking', 'care', 'errands', 'other')),
  starts_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes between 15 and 1440),
  location text not null check (char_length(location) between 2 and 300),
  helpers_needed integer not null check (helpers_needed between 1 and 20),
  status text not null default 'open' check (status in ('open', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, community_id)
);
create index help_need_posts_community on public.help_need_posts(community_id, status, starts_at);

-- A member's offer on a post. Listing: committer is the requester. Need Post: committer is the helper.
create table public.help_commitments (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  listing_id uuid,
  need_post_id uuid,
  member_id uuid not null references auth.users(id),
  note text not null default '' check (char_length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'withdrawn')),
  exchange_id uuid unique references public.exchanges(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (num_nonnulls(listing_id, need_post_id) = 1),
  check ((status = 'accepted') = (exchange_id is not null)),
  check ((status = 'pending') = (decided_at is null)),
  foreign key (listing_id, community_id) references public.help_listings(id, community_id),
  foreign key (need_post_id, community_id) references public.help_need_posts(id, community_id)
);
create unique index help_commitment_one_pending on public.help_commitments(coalesce(listing_id, need_post_id), member_id) where status = 'pending';
create index help_commitments_member on public.help_commitments(member_id);

-- One row per accepted helper place on a Need Post. Places are numbered 1..helpers_needed while active.
create table public.help_slots (
  id uuid primary key default gen_random_uuid(),
  need_post_id uuid not null,
  community_id uuid not null,
  place integer not null check (place >= 1),
  helper_id uuid not null references auth.users(id),
  exchange_id uuid not null unique references public.exchanges(id),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'closed') = (closed_at is not null)),
  foreign key (need_post_id, community_id) references public.help_need_posts(id, community_id)
);
create unique index help_slot_active_place on public.help_slots(need_post_id, place) where status = 'active';
create unique index help_slot_active_helper on public.help_slots(need_post_id, helper_id) where status = 'active';

-- Help-only schedule and cancellation detail. There are no item condition, replacement value, Handoff, Return, or photo columns.
create table public.help_exchange_details (
  exchange_id uuid primary key references public.exchanges(id),
  community_id uuid not null references public.communities(id),
  commitment_id uuid not null unique references public.help_commitments(id),
  slot_id uuid unique references public.help_slots(id),
  starts_at timestamptz,
  duration_minutes integer check (duration_minutes between 15 and 1440),
  meeting_point text check (char_length(meeting_point) between 2 and 300),
  scheduled_by uuid references auth.users(id),
  scheduled_at timestamptz,
  cancel_reason text check (char_length(cancel_reason) between 1 and 500),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (num_nulls(starts_at, duration_minutes, meeting_point, scheduled_by, scheduled_at) in (0, 5)),
  check (num_nulls(cancel_reason, cancelled_by, cancelled_at) in (0, 3))
);

create function private.guard_help_identity()
returns trigger language plpgsql set search_path = '' as $$
declare col text;
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '42501', message = TG_TABLE_NAME || ' history cannot be deleted.';
  end if;
  foreach col in array TG_ARGV loop
    if to_jsonb(NEW)->col is distinct from to_jsonb(OLD)->col then
      raise exception using errcode = '42501', message = TG_TABLE_NAME || '.' || col || ' is immutable.';
    end if;
  end loop;
  return NEW;
end;
$$;
create trigger help_listings_identity before update or delete on public.help_listings
  for each row execute function private.guard_help_identity('id', 'community_id', 'owner_id', 'created_at');
create trigger help_need_posts_identity before update or delete on public.help_need_posts
  for each row execute function private.guard_help_identity('id', 'community_id', 'owner_id', 'created_at');
create trigger help_commitments_identity before update or delete on public.help_commitments
  for each row execute function private.guard_help_identity('id', 'community_id', 'listing_id', 'need_post_id', 'member_id', 'note', 'created_at');
create trigger help_slots_identity before update or delete on public.help_slots
  for each row execute function private.guard_help_identity('id', 'need_post_id', 'community_id', 'place', 'helper_id', 'exchange_id', 'created_at');
create trigger help_exchange_details_identity before update or delete on public.help_exchange_details
  for each row execute function private.guard_help_identity('exchange_id', 'community_id', 'commitment_id', 'slot_id', 'created_at');

create function private.guard_help_slot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' and OLD.status = 'closed' and NEW.status <> 'closed' then
    raise exception using errcode = '23514', message = 'A closed help place cannot reopen; accept a new commitment instead.';
  end if;
  if NEW.status = 'active' and NEW.place > (select p.helpers_needed from public.help_need_posts p where p.id = NEW.need_post_id) then
    raise exception using errcode = '23514', message = 'Help place exceeds the requested helper count.';
  end if;
  if not exists (select 1 from public.exchanges e where e.id = NEW.exchange_id and e.kind = 'help' and e.community_id = NEW.community_id
    and e.provider_id = NEW.helper_id and e.source_kind = 'need_post' and e.source_id = NEW.need_post_id) then
    raise exception using errcode = '23514', message = 'A help place requires its helper''s help Exchange from the same Need Post.';
  end if;
  return NEW;
end;
$$;
create trigger help_slot_integrity before insert or update on public.help_slots
  for each row execute function private.guard_help_slot();

create function private.guard_help_detail()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.exchanges e where e.id = NEW.exchange_id and e.kind = 'help' and e.community_id = NEW.community_id) then
    raise exception using errcode = '23514', message = 'Help detail requires a help Exchange in the same Community.';
  end if;
  return NEW;
end;
$$;
create trigger help_detail_kind before insert on public.help_exchange_details
  for each row execute function private.guard_help_detail();

create function private.guard_help_exchange_event()
returns trigger language plpgsql set search_path = '' as $$
begin
  if NEW.kind ~ '^(handoff|return|condition|reservation|photo|replacement)' and exists (
    select 1 from public.exchanges e where e.id = NEW.exchange_id and e.kind = 'help') then
    raise exception using errcode = '23514', message = 'Help Exchanges have no Handoff, Return, condition, reservation, photo, or replacement value records.';
  end if;
  return NEW;
end;
$$;
create trigger exchange_event_kind_scope before insert on public.exchange_events
  for each row execute function private.guard_help_exchange_event();

create trigger help_audit_append_only before update or delete on public.community_events
  for each row when (old.kind like 'help\_%') execute function private.reject_history_rewrite();

revoke all on function private.guard_help_identity(), private.guard_help_slot(), private.guard_help_detail(),
  private.guard_help_exchange_event() from public, anon, authenticated;

-- Exchange rows are participant-only. A suspended or removed participant keeps an open obligation (ADR 0003).
create function public.can_read_exchange(p_exchange_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.exchanges e
    where e.id = p_exchange_id and auth.uid() in (e.provider_id, e.receiver_id)
      and (public.is_active_member(e.community_id) or (
        e.state in ('committed', 'scheduled', 'completion_pending', 'approved', 'handoff_pending', 'checked_out', 'return_pending')
        and exists (select 1 from public.memberships m where m.community_id = e.community_id and m.user_id = auth.uid()
          and m.status in ('suspended', 'removed'))))
  );
$$;
revoke all on function public.can_read_exchange(uuid) from public, anon;
grant execute on function public.can_read_exchange(uuid) to authenticated;

drop policy exchange_read on public.exchanges;
create policy exchange_read on public.exchanges for select to authenticated using (public.can_read_exchange(id));

create function private.help_post_owner(p_listing_id uuid, p_need_post_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select owner_id from public.help_listings where id = p_listing_id),
    (select owner_id from public.help_need_posts where id = p_need_post_id));
$$;
revoke all on function private.help_post_owner(uuid, uuid) from public, anon, authenticated;
create function public.can_read_help_commitment(p_commitment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.help_commitments c where c.id = p_commitment_id
    and auth.uid() in (c.member_id, private.help_post_owner(c.listing_id, c.need_post_id))
    and (public.is_active_member(c.community_id) or (c.exchange_id is not null and public.can_read_exchange(c.exchange_id))));
$$;
revoke all on function public.can_read_help_commitment(uuid) from public, anon;
grant execute on function public.can_read_help_commitment(uuid) to authenticated;

alter table public.help_listings enable row level security;
alter table public.help_need_posts enable row level security;
alter table public.help_commitments enable row level security;
alter table public.help_slots enable row level security;
alter table public.help_exchange_details enable row level security;
revoke all on public.help_listings, public.help_need_posts, public.help_commitments, public.help_slots, public.help_exchange_details from anon, authenticated;
grant select on public.help_listings, public.help_need_posts, public.help_commitments, public.help_slots, public.help_exchange_details to authenticated;
create policy help_listing_read on public.help_listings for select to authenticated using (public.is_active_member(community_id));
create policy help_need_post_read on public.help_need_posts for select to authenticated using (public.is_active_member(community_id));
create policy help_commitment_read on public.help_commitments for select to authenticated using (public.can_read_help_commitment(id));
create policy help_slot_read on public.help_slots for select to authenticated using (public.can_read_exchange(exchange_id));
create policy help_detail_read on public.help_exchange_details for select to authenticated using (public.can_read_exchange(exchange_id));

-- Help commitment, schedule, and cancellation audit is participant business; ordinary members do not read it.
drop policy event_read on public.community_events;
create policy event_read on public.community_events for select to authenticated
  using (public.is_active_member(community_id) and kind not in ('conversation_started', 'message_sent',
    'help_commitment_offered', 'help_commitment_accepted', 'help_scheduled', 'help_cancelled'));

create function private.help_intent(p_actor uuid, p_intent uuid, p_command text, p_payload jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare prior public.command_intents;
begin
  if p_intent is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || p_intent::text, 0));
  select * into prior from public.command_intents where actor_id = p_actor and intent_id = p_intent;
  if found then
    if prior.command <> p_command or prior.payload <> p_payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    return prior.result;
  end if;
  return null;
end;
$$;

create function private.help_text(p_fields jsonb, p_key text, p_min integer, p_max integer, p_label text)
returns text language plpgsql immutable set search_path = '' as $$
declare value text := btrim(coalesce(p_fields->>p_key, ''));
begin
  if jsonb_typeof(coalesce(p_fields->p_key, '""'::jsonb)) <> 'string' or char_length(value) not between p_min and p_max then
    raise exception using errcode = '22023', message = case when p_min = 0 then p_label || ' can be up to ' || p_max || ' characters.'
      else p_label || ' needs ' || p_min || '–' || p_max || ' characters.' end;
  end if;
  return value;
end;
$$;

create function private.help_integer(p_fields jsonb, p_key text, p_min integer, p_max integer, p_label text)
returns integer language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_fields->p_key) is not distinct from 'number' and (p_fields->>p_key) ~ '^\d{1,6}$' then
    if (p_fields->>p_key)::integer between p_min and p_max then return (p_fields->>p_key)::integer; end if;
  end if;
  raise exception using errcode = '22023', message = p_label || ' must be a whole number from ' || p_min || ' to ' || p_max || '.';
end;
$$;

create function private.help_time(p_fields jsonb, p_key text, p_label text)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare value timestamptz;
begin
  begin
    value := (p_fields->>p_key)::timestamptz;
  exception when others then value := null;
  end;
  if value is null or jsonb_typeof(p_fields->p_key) <> 'string' then
    raise exception using errcode = '22023', message = p_label || ' needs a valid date and time.';
  end if;
  return value;
end;
$$;

-- Validates a field object against an allowlist. Item-only fields are named so the kind mismatch is explicit.
create function private.help_fields(p_fields jsonb, p_allowed text[])
returns void language plpgsql immutable set search_path = '' as $$
declare key text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception using errcode = '22023', message = 'Send the help details as an object.';
  end if;
  for key in select jsonb_object_keys(p_fields) loop
    if key = any(array['condition', 'condition_notes', 'replacement_value', 'handoff', 'handoff_at', 'return', 'return_at', 'returned_at',
      'photos', 'photo_paths', 'accessories', 'reservation', 'borrow_dates']) then
      raise exception using errcode = '22023', message = 'Help has no item condition, replacement value, Handoff, Return, or photos (' || key || ').';
    end if;
    if not key = any(p_allowed) then
      raise exception using errcode = '22023', message = 'Unknown help field ' || key || '.';
    end if;
  end loop;
end;
$$;

create function private.help_category(p_fields jsonb)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p_fields->>'category', '') not in ('moving', 'repairs', 'yard_garden', 'tech', 'tutoring', 'cooking', 'care', 'errands', 'other') then
    raise exception using errcode = '22023', message = 'Choose a help category.';
  end if;
  return p_fields->>'category';
end;
$$;

create function private.help_post_view(p_post_kind text, p_post_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case p_post_kind when 'listing' then (
    select jsonb_build_object('postKind', 'listing', 'id', l.id, 'communityId', l.community_id, 'ownerId', l.owner_id, 'ownerEmail', u.email,
      'title', l.title, 'description', l.description, 'category', l.category, 'skill', l.skill, 'skillLevel', l.skill_level,
      'availability', l.availability, 'geographicConstraints', l.geographic_constraints, 'schedulingPreferences', l.scheduling_preferences,
      'status', l.status, 'createdAt', l.created_at, 'updatedAt', l.updated_at)
    from public.help_listings l join auth.users u on u.id = l.owner_id where l.id = p_post_id)
  else (
    select jsonb_build_object('postKind', 'need_post', 'id', p.id, 'communityId', p.community_id, 'ownerId', p.owner_id, 'ownerEmail', u.email,
      'title', p.title, 'description', p.description, 'category', p.category, 'startsAt', p.starts_at, 'durationMinutes', p.duration_minutes,
      'location', p.location, 'helpersNeeded', p.helpers_needed,
      'openPlaces', p.helpers_needed - (select count(*) from public.help_slots s where s.need_post_id = p.id and s.status = 'active')::integer,
      'status', p.status, 'createdAt', p.created_at, 'updatedAt', p.updated_at)
    from public.help_need_posts p join auth.users u on u.id = p.owner_id where p.id = p_post_id) end;
$$;

create function private.help_exchange_view(p_exchange_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'communityId', e.community_id, 'communityName', c.name, 'state', e.state,
    'sourceKind', e.source_kind, 'sourceId', e.source_id,
    'sourceTitle', coalesce((select l.title from public.help_listings l where l.id = e.source_id), (select p.title from public.help_need_posts p where p.id = e.source_id)),
    'helperId', e.provider_id, 'helperEmail', helper.email, 'requesterId', e.receiver_id, 'requesterEmail', requester.email,
    'commitmentId', d.commitment_id, 'place', s.place, 'placeStatus', s.status,
    'startsAt', d.starts_at, 'durationMinutes', d.duration_minutes, 'meetingPoint', d.meeting_point,
    'cancelReason', d.cancel_reason, 'cancelledBy', d.cancelled_by, 'cancelledAt', d.cancelled_at, 'createdAt', e.created_at)
  from public.exchanges e
  join public.help_exchange_details d on d.exchange_id = e.id
  join public.communities c on c.id = e.community_id
  join auth.users helper on helper.id = e.provider_id
  join auth.users requester on requester.id = e.receiver_id
  left join public.help_slots s on s.id = d.slot_id
  where e.id = p_exchange_id;
$$;

create function private.record_help_activity(p_community uuid, p_actor uuid, p_intent uuid, p_kind text, p_recipient uuid)
returns void language plpgsql set search_path = '' as $$
declare audit_event uuid;
begin
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community, p_actor, p_kind, p_intent) returning id into audit_event;
  if p_recipient is not null then
    insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind)
      select audit_event, p_community, p_recipient, ch, p_kind from unnest(array['in_app', 'email']) ch
      where exists (select 1 from public.memberships m where m.community_id = p_community and m.user_id = p_recipient and m.status = 'active')
      on conflict (event_id, recipient_id, channel, kind) do nothing;
    insert into public.notification_hints(recipient_id) values(p_recipient);
  end if;
end;
$$;

revoke all on function private.help_intent(uuid, uuid, text, jsonb), private.help_text(jsonb, text, integer, integer, text),
  private.help_integer(jsonb, text, integer, integer, text), private.help_time(jsonb, text, text), private.help_fields(jsonb, text[]),
  private.help_category(jsonb), private.help_post_view(text, uuid), private.help_exchange_view(uuid),
  private.record_help_activity(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;

create function private.help_post_community(p_post_kind text, p_post_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select case p_post_kind when 'listing' then (select community_id from public.help_listings where id = p_post_id)
    when 'need_post' then (select community_id from public.help_need_posts where id = p_post_id) end;
$$;
revoke all on function private.help_post_community(text, uuid) from public, anon, authenticated;

create function public.create_help_post(p_intent_id uuid, p_community_id uuid, p_post_kind text, p_fields jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('community_id', p_community_id, 'post_kind', p_post_kind, 'fields', p_fields);
  outcome jsonb;
  post_id uuid;
begin
  perform public.require_current_membership(p_community_id);
  outcome := private.help_intent(actor, p_intent_id, 'create_help_post', payload);
  if outcome is not null then return outcome; end if;
  if p_post_kind = 'listing' then
    perform private.help_fields(p_fields, array['title', 'description', 'category', 'skill', 'skill_level', 'availability', 'geographic_constraints', 'scheduling_preferences']);
    if coalesce(p_fields->>'skill_level', '') not in ('beginner', 'intermediate', 'experienced', 'professional') then
      raise exception using errcode = '22023', message = 'Choose a skill level.';
    end if;
    insert into public.help_listings(community_id, owner_id, title, description, category, skill, skill_level, availability, geographic_constraints, scheduling_preferences)
      values(p_community_id, actor, private.help_text(p_fields, 'title', 3, 120, 'Title'), private.help_text(p_fields, 'description', 0, 2000, 'Description'),
        private.help_category(p_fields), private.help_text(p_fields, 'skill', 2, 120, 'Skill'), p_fields->>'skill_level',
        private.help_text(p_fields, 'availability', 2, 500, 'Availability'), private.help_text(p_fields, 'geographic_constraints', 2, 500, 'Area'),
        private.help_text(p_fields, 'scheduling_preferences', 0, 500, 'Scheduling preferences'))
      returning id into post_id;
  elsif p_post_kind = 'need_post' then
    perform private.help_fields(p_fields, array['title', 'description', 'category', 'starts_at', 'duration_minutes', 'location', 'helpers_needed']);
    if private.help_time(p_fields, 'starts_at', 'Requested time') <= clock_timestamp() then
      raise exception using errcode = '22023', message = 'Choose a requested time in the future.';
    end if;
    insert into public.help_need_posts(community_id, owner_id, title, description, category, starts_at, duration_minutes, location, helpers_needed)
      values(p_community_id, actor, private.help_text(p_fields, 'title', 3, 120, 'Title'), private.help_text(p_fields, 'description', 0, 2000, 'Description'),
        private.help_category(p_fields), private.help_time(p_fields, 'starts_at', 'Requested time'),
        private.help_integer(p_fields, 'duration_minutes', 15, 1440, 'Duration in minutes'), private.help_text(p_fields, 'location', 2, 300, 'Location'),
        private.help_integer(p_fields, 'helpers_needed', 1, 20, 'Helpers needed'))
      returning id into post_id;
  else
    raise exception using errcode = '22023', message = 'Choose a Help Listing or Help Need Post.';
  end if;
  perform private.record_help_activity(p_community_id, actor, p_intent_id, 'help_post_created', null);
  outcome := private.help_post_view(p_post_kind, post_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'create_help_post', payload, outcome);
  return outcome;
end;
$$;

create function public.edit_help_post(p_intent_id uuid, p_post_kind text, p_post_id uuid, p_fields jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('post_kind', p_post_kind, 'post_id', p_post_id, 'fields', p_fields);
  community uuid := private.help_post_community(p_post_kind, p_post_id);
  outcome jsonb;
  listing public.help_listings;
  need public.help_need_posts;
  next_start timestamptz;
  next_count integer;
begin
  if community is null then raise exception using errcode = '42501', message = 'Help post unavailable.'; end if;
  perform public.require_current_membership(community);
  outcome := private.help_intent(actor, p_intent_id, 'edit_help_post', payload);
  if outcome is not null then return outcome; end if;
  if p_post_kind = 'listing' then
    select * into listing from public.help_listings where id = p_post_id for update;
    if listing.owner_id <> actor then raise exception using errcode = '42501', message = 'Only the author can change this post.'; end if;
    if listing.status <> 'open' then raise exception using errcode = '55000', message = 'A withdrawn post cannot be edited.'; end if;
    perform private.help_fields(p_fields, array['title', 'description', 'category', 'skill', 'skill_level', 'availability', 'geographic_constraints', 'scheduling_preferences']);
    if coalesce(p_fields->>'skill_level', '') not in ('beginner', 'intermediate', 'experienced', 'professional') then
      raise exception using errcode = '22023', message = 'Choose a skill level.';
    end if;
    update public.help_listings set title = private.help_text(p_fields, 'title', 3, 120, 'Title'), description = private.help_text(p_fields, 'description', 0, 2000, 'Description'),
      category = private.help_category(p_fields), skill = private.help_text(p_fields, 'skill', 2, 120, 'Skill'), skill_level = p_fields->>'skill_level',
      availability = private.help_text(p_fields, 'availability', 2, 500, 'Availability'), geographic_constraints = private.help_text(p_fields, 'geographic_constraints', 2, 500, 'Area'),
      scheduling_preferences = private.help_text(p_fields, 'scheduling_preferences', 0, 500, 'Scheduling preferences'), updated_at = clock_timestamp()
      where id = listing.id;
  else
    select * into need from public.help_need_posts where id = p_post_id for update;
    if need.owner_id <> actor then raise exception using errcode = '42501', message = 'Only the author can change this post.'; end if;
    if need.status <> 'open' then raise exception using errcode = '55000', message = 'A withdrawn post cannot be edited.'; end if;
    perform private.help_fields(p_fields, array['title', 'description', 'category', 'starts_at', 'duration_minutes', 'location', 'helpers_needed']);
    next_start := private.help_time(p_fields, 'starts_at', 'Requested time');
    if next_start <> need.starts_at and next_start <= clock_timestamp() then
      raise exception using errcode = '22023', message = 'Choose a requested time in the future.';
    end if;
    next_count := private.help_integer(p_fields, 'helpers_needed', 1, 20, 'Helpers needed');
    if next_count < coalesce((select max(place) from public.help_slots where need_post_id = need.id and status = 'active'), 0) then
      raise exception using errcode = '55000', message = 'Accepted helpers already hold more places than that.';
    end if;
    update public.help_need_posts set title = private.help_text(p_fields, 'title', 3, 120, 'Title'), description = private.help_text(p_fields, 'description', 0, 2000, 'Description'),
      category = private.help_category(p_fields), starts_at = next_start, duration_minutes = private.help_integer(p_fields, 'duration_minutes', 15, 1440, 'Duration in minutes'),
      location = private.help_text(p_fields, 'location', 2, 300, 'Location'), helpers_needed = next_count, updated_at = clock_timestamp()
      where id = need.id;
  end if;
  perform private.record_help_activity(community, actor, p_intent_id, 'help_post_edited', null);
  outcome := private.help_post_view(p_post_kind, p_post_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'edit_help_post', payload, outcome);
  return outcome;
end;
$$;

create function public.withdraw_help_post(p_intent_id uuid, p_post_kind text, p_post_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('post_kind', p_post_kind, 'post_id', p_post_id);
  community uuid := private.help_post_community(p_post_kind, p_post_id);
  outcome jsonb;
  owner uuid;
  state text;
begin
  if community is null then raise exception using errcode = '42501', message = 'Help post unavailable.'; end if;
  perform public.require_current_membership(community);
  outcome := private.help_intent(actor, p_intent_id, 'withdraw_help_post', payload);
  if outcome is not null then return outcome; end if;
  if p_post_kind = 'listing' then
    select owner_id, status into owner, state from public.help_listings where id = p_post_id for update;
  else
    select owner_id, status into owner, state from public.help_need_posts where id = p_post_id for update;
  end if;
  if owner <> actor then raise exception using errcode = '42501', message = 'Only the author can withdraw this post.'; end if;
  if state <> 'open' then raise exception using errcode = '55000', message = 'This post is already withdrawn.'; end if;
  if p_post_kind = 'listing' then
    update public.help_listings set status = 'withdrawn', updated_at = clock_timestamp() where id = p_post_id;
  else
    update public.help_need_posts set status = 'withdrawn', updated_at = clock_timestamp() where id = p_post_id;
  end if;
  update public.help_commitments set status = 'withdrawn', decided_at = clock_timestamp()
    where status = 'pending' and coalesce(listing_id, need_post_id) = p_post_id;
  perform private.record_help_activity(community, actor, p_intent_id, 'help_post_withdrawn', null);
  outcome := private.help_post_view(p_post_kind, p_post_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'withdraw_help_post', payload, outcome);
  return outcome;
end;
$$;

create function public.commit_help(p_intent_id uuid, p_post_kind text, p_post_id uuid, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('post_kind', p_post_kind, 'post_id', p_post_id, 'note', p_note);
  community uuid := private.help_post_community(p_post_kind, p_post_id);
  outcome jsonb;
  owner uuid;
  state text;
  commitment public.help_commitments;
begin
  if community is null then raise exception using errcode = '42501', message = 'Help post unavailable.'; end if;
  perform public.require_current_membership(community);
  outcome := private.help_intent(actor, p_intent_id, 'commit_help', payload);
  if outcome is not null then return outcome; end if;
  if p_post_kind = 'listing' then
    select owner_id, status into owner, state from public.help_listings where id = p_post_id for share;
  else
    select owner_id, status into owner, state from public.help_need_posts where id = p_post_id for share;
  end if;
  if owner = actor then raise exception using errcode = '22023', message = 'You cannot commit to your own post.'; end if;
  if state <> 'open' then raise exception using errcode = '55000', message = 'This post is no longer open.'; end if;
  if p_note is null or char_length(btrim(p_note)) > 500 then raise exception using errcode = '22023', message = 'Keep your note to 500 characters.'; end if;
  if exists (select 1 from public.help_commitments where coalesce(listing_id, need_post_id) = p_post_id and member_id = actor and status = 'pending') then
    raise exception using errcode = '55000', message = 'Your offer here is already waiting for a decision.';
  end if;
  if p_post_kind = 'need_post' then
    if exists (select 1 from public.help_slots where need_post_id = p_post_id and helper_id = actor and status = 'active') then
      raise exception using errcode = '55000', message = 'You already hold a place on this Need Post.';
    end if;
    if (select p.helpers_needed - (select count(*) from public.help_slots s where s.need_post_id = p.id and s.status = 'active') from public.help_need_posts p where p.id = p_post_id) <= 0 then
      raise exception using errcode = '55000', message = 'Every place on this Need Post is filled.';
    end if;
  end if;
  insert into public.help_commitments(community_id, listing_id, need_post_id, member_id, note)
    values(community, case when p_post_kind = 'listing' then p_post_id end, case when p_post_kind = 'need_post' then p_post_id end, actor, btrim(p_note))
    returning * into commitment;
  perform private.record_help_activity(community, actor, p_intent_id, 'help_commitment_offered', owner);
  outcome := to_jsonb(commitment) || jsonb_build_object('post_kind', p_post_kind);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'commit_help', payload, outcome);
  return outcome;
end;
$$;

create function public.accept_help_commitment(p_intent_id uuid, p_commitment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('commitment_id', p_commitment_id);
  outcome jsonb;
  commitment public.help_commitments;
  listing public.help_listings;
  need public.help_need_posts;
  member_status text;
  exchange public.exchanges;
  new_slot uuid;
  free_place integer;
begin
  select * into commitment from public.help_commitments where id = p_commitment_id;
  if not found then raise exception using errcode = '42501', message = 'Help offer unavailable.'; end if;
  perform public.require_current_membership(commitment.community_id);
  outcome := private.help_intent(actor, p_intent_id, 'accept_help_commitment', payload);
  if outcome is not null then return outcome; end if;
  if commitment.listing_id is not null then
    select * into listing from public.help_listings where id = commitment.listing_id for update;
    if listing.owner_id <> actor then raise exception using errcode = '42501', message = 'Only the post''s author can accept this offer.'; end if;
    if listing.status <> 'open' then raise exception using errcode = '55000', message = 'This post is no longer open.'; end if;
  else
    -- The Need Post row lock serializes every acceptance for its places.
    select * into need from public.help_need_posts where id = commitment.need_post_id for update;
    if need.owner_id <> actor then raise exception using errcode = '42501', message = 'Only the post''s author can accept this offer.'; end if;
    if need.status <> 'open' then raise exception using errcode = '55000', message = 'This post is no longer open.'; end if;
  end if;
  select * into commitment from public.help_commitments where id = p_commitment_id for update;
  if commitment.status <> 'pending' then raise exception using errcode = '55000', message = 'This offer is no longer waiting for a decision.'; end if;
  select status into member_status from public.memberships where community_id = commitment.community_id and user_id = commitment.member_id for share;
  if member_status is distinct from 'active' then
    raise exception using errcode = '42501', message = 'That person is not an active member of this Community.';
  end if;
  if need.id is not null then
    if exists (select 1 from public.help_slots where need_post_id = need.id and helper_id = commitment.member_id and status = 'active') then
      raise exception using errcode = '55000', message = 'This helper already holds a place on this Need Post.';
    end if;
    select min(n) into free_place from generate_series(1, need.helpers_needed) n
      where not exists (select 1 from public.help_slots s where s.need_post_id = need.id and s.place = n and s.status = 'active');
    if free_place is null then raise exception using errcode = '55000', message = 'Every place on this Need Post is filled.'; end if;
    insert into public.exchanges(community_id, kind, provider_id, receiver_id, source_kind, source_id, state)
      values(commitment.community_id, 'help', commitment.member_id, actor, 'need_post', need.id, 'committed') returning * into exchange;
    insert into public.help_slots(need_post_id, community_id, place, helper_id, exchange_id)
      values(need.id, commitment.community_id, free_place, commitment.member_id, exchange.id) returning id into new_slot;
  else
    insert into public.exchanges(community_id, kind, provider_id, receiver_id, source_kind, source_id, state)
      values(commitment.community_id, 'help', actor, commitment.member_id, 'listing', listing.id, 'committed') returning * into exchange;
  end if;
  insert into public.help_exchange_details(exchange_id, community_id, commitment_id, slot_id) values(exchange.id, exchange.community_id, commitment.id, new_slot);
  update public.help_commitments set status = 'accepted', exchange_id = exchange.id, decided_at = clock_timestamp() where id = commitment.id;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(exchange.id, exchange.community_id, 'help_committed', actor);
  perform private.record_help_activity(exchange.community_id, actor, p_intent_id, 'help_commitment_accepted', commitment.member_id);
  outcome := private.help_exchange_view(exchange.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'accept_help_commitment', payload, outcome);
  return outcome;
end;
$$;

create function public.schedule_help_exchange(p_intent_id uuid, p_exchange_id uuid, p_fields jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('exchange_id', p_exchange_id, 'fields', p_fields);
  outcome jsonb;
  exchange public.exchanges;
  next_start timestamptz;
begin
  select * into exchange from public.exchanges where id = p_exchange_id and kind = 'help';
  if not found or actor is null or actor not in (exchange.provider_id, exchange.receiver_id) then
    raise exception using errcode = '42501', message = 'Help Exchange unavailable.';
  end if;
  perform public.require_current_membership(exchange.community_id);
  outcome := private.help_intent(actor, p_intent_id, 'schedule_help_exchange', payload);
  if outcome is not null then return outcome; end if;
  select * into exchange from public.exchanges where id = p_exchange_id for update;
  if exchange.state not in ('committed', 'scheduled') then
    raise exception using errcode = '55000', message = 'Only committed or scheduled help can be scheduled.';
  end if;
  perform private.help_fields(p_fields, array['starts_at', 'duration_minutes', 'meeting_point']);
  next_start := private.help_time(p_fields, 'starts_at', 'Start time');
  if next_start <= clock_timestamp() then raise exception using errcode = '22023', message = 'Choose a start time in the future.'; end if;
  update public.help_exchange_details set starts_at = next_start,
    duration_minutes = private.help_integer(p_fields, 'duration_minutes', 15, 1440, 'Duration in minutes'),
    meeting_point = private.help_text(p_fields, 'meeting_point', 2, 300, 'Meeting point'), scheduled_by = actor, scheduled_at = clock_timestamp()
    where exchange_id = exchange.id;
  update public.exchanges set state = 'scheduled' where id = exchange.id;
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(exchange.id, exchange.community_id, 'help_scheduled', actor);
  perform private.record_help_activity(exchange.community_id, actor, p_intent_id, 'help_scheduled',
    case when actor = exchange.provider_id then exchange.receiver_id else exchange.provider_id end);
  outcome := private.help_exchange_view(exchange.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'schedule_help_exchange', payload, outcome);
  return outcome;
end;
$$;

create function public.cancel_help_exchange(p_intent_id uuid, p_exchange_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('exchange_id', p_exchange_id, 'reason', p_reason);
  outcome jsonb;
  exchange public.exchanges;
  member_status text;
begin
  select * into exchange from public.exchanges where id = p_exchange_id and kind = 'help';
  if not found or actor is null or actor not in (exchange.provider_id, exchange.receiver_id) then
    raise exception using errcode = '42501', message = 'Help Exchange unavailable.';
  end if;
  -- Cancelling resolves an existing obligation, so a suspended or removed participant keeps it (ADR 0003).
  select status into member_status from public.memberships where community_id = exchange.community_id and user_id = actor for share;
  if member_status is null or member_status not in ('active', 'suspended', 'removed') then
    raise exception using errcode = '42501', message = 'Help Exchange unavailable.';
  end if;
  outcome := private.help_intent(actor, p_intent_id, 'cancel_help_exchange', payload);
  if outcome is not null then return outcome; end if;
  select * into exchange from public.exchanges where id = p_exchange_id for update;
  if exchange.state not in ('committed', 'scheduled') then
    raise exception using errcode = '55000', message = 'Only committed or scheduled help can be cancelled.';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Give a reason of up to 500 characters.';
  end if;
  update public.exchanges set state = 'cancelled' where id = exchange.id;
  update public.help_exchange_details set cancel_reason = btrim(p_reason), cancelled_by = actor, cancelled_at = clock_timestamp() where exchange_id = exchange.id;
  update public.help_slots set status = 'closed', closed_at = clock_timestamp() where exchange_id = exchange.id and status = 'active';
  insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(exchange.id, exchange.community_id, 'help_cancelled', actor);
  perform private.record_help_activity(exchange.community_id, actor, p_intent_id, 'help_cancelled',
    case when actor = exchange.provider_id then exchange.receiver_id else exchange.provider_id end);
  outcome := private.help_exchange_view(exchange.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'cancel_help_exchange', payload, outcome);
  return outcome;
end;
$$;

create function public.help_board(p_community_id uuid, p_search text default '', p_post_kind text default '', p_category text default '')
returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
declare pattern text := '%' || replace(replace(replace(btrim(coalesce(p_search, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  if not public.is_active_member(p_community_id) then
    raise exception using errcode = '42501', message = 'Current active Community membership is required.';
  end if;
  return query
    select private.help_post_view(posts.kind, posts.id) from (
      select 'listing' as kind, l.id, l.created_at from public.help_listings l
      where l.community_id = p_community_id and l.status = 'open' and coalesce(p_post_kind, '') in ('', 'listing')
        and (coalesce(p_category, '') = '' or l.category = p_category)
        and (l.title ilike pattern or l.description ilike pattern or l.skill ilike pattern or l.geographic_constraints ilike pattern)
      union all
      select 'need_post', p.id, p.created_at from public.help_need_posts p
      where p.community_id = p_community_id and p.status = 'open' and coalesce(p_post_kind, '') in ('', 'need_post')
        and (coalesce(p_category, '') = '' or p.category = p_category)
        and (p.title ilike pattern or p.description ilike pattern or p.location ilike pattern)
    ) posts order by posts.created_at desc, posts.id;
end;
$$;

create function public.help_post(p_post_kind text, p_post_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  community uuid := private.help_post_community(p_post_kind, p_post_id);
  post jsonb;
  active boolean;
  owner boolean;
begin
  if community is null then raise exception using errcode = '42501', message = 'Help post unavailable.'; end if;
  active := public.is_active_member(community);
  if not active and not exists (select 1 from public.exchanges e where e.source_id = p_post_id and e.kind = 'help' and public.can_read_exchange(e.id)) then
    raise exception using errcode = '42501', message = 'Help post unavailable.';
  end if;
  post := private.help_post_view(p_post_kind, p_post_id);
  owner := active and (post->>'ownerId')::uuid = actor;
  return jsonb_build_object(
    'post', post,
    'viewerIsOwner', owner,
    'viewerActive', active,
    'commitments', case when not active then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'memberId', c.member_id, 'memberEmail', u.email, 'note', c.note, 'status', c.status,
        'exchangeId', c.exchange_id, 'createdAt', c.created_at) order by (c.status = 'pending') desc, c.created_at)
      from public.help_commitments c join auth.users u on u.id = c.member_id
      where coalesce(c.listing_id, c.need_post_id) = p_post_id and (owner or c.member_id = actor)), '[]'::jsonb) end,
    'exchanges', coalesce((select jsonb_agg(private.help_exchange_view(e.id) order by e.created_at)
      from public.exchanges e where e.source_id = p_post_id and e.kind = 'help' and public.can_read_exchange(e.id)), '[]'::jsonb)
  );
end;
$$;

create function public.my_help_exchanges()
returns setof jsonb language sql stable security definer set search_path = '' as $$
  select private.help_exchange_view(e.id) from public.exchanges e
  where e.kind = 'help' and auth.uid() in (e.provider_id, e.receiver_id) and public.can_read_exchange(e.id)
  order by e.created_at desc;
$$;

revoke all on function public.create_help_post(uuid, uuid, text, jsonb), public.edit_help_post(uuid, text, uuid, jsonb),
  public.withdraw_help_post(uuid, text, uuid), public.commit_help(uuid, text, uuid, text), public.accept_help_commitment(uuid, uuid),
  public.schedule_help_exchange(uuid, uuid, jsonb), public.cancel_help_exchange(uuid, uuid, text),
  public.help_board(uuid, text, text, text), public.help_post(text, uuid), public.my_help_exchanges() from public, anon;
grant execute on function public.create_help_post(uuid, uuid, text, jsonb), public.edit_help_post(uuid, text, uuid, jsonb),
  public.withdraw_help_post(uuid, text, uuid), public.commit_help(uuid, text, uuid, text), public.accept_help_commitment(uuid, uuid),
  public.schedule_help_exchange(uuid, uuid, jsonb), public.cancel_help_exchange(uuid, uuid, text),
  public.help_board(uuid, text, text, text), public.help_post(text, uuid), public.my_help_exchanges() to authenticated;

notify pgrst, 'reload schema';
