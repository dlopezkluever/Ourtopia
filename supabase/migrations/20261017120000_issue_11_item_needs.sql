create table public.item_need_posts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  author_id uuid not null references auth.users(id),
  status text not null default 'open' check (status in ('open', 'withdrawn')),
  version integer not null default 1,
  title text not null check (char_length(btrim(title)) between 2 and 120),
  description text not null check (char_length(description) between 1 and 2000),
  category text not null check (category in ('tools','outdoors','recreation','electronics','kitchen','transportation equipment','sports','creative','household','miscellaneous')),
  starts_on date not null,
  ends_on date not null,
  urgency text not null check (urgency in ('flexible', 'soon', 'urgent')),
  value_min numeric(12,2),
  value_max numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, community_id),
  check (starts_on <= ends_on and starts_on >= date '2000-01-01' and ends_on <= date '2100-12-31'),
  check ((value_min is null) = (value_max is null)),
  check (value_min is null or (value_min >= 0 and value_min <= value_max and value_max <= 1000000))
);
create index item_need_feed on public.item_need_posts(community_id, status, created_at desc);

create table public.item_need_images (
  id uuid primary key,
  need_id uuid not null references public.item_need_posts(id),
  object_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  state text not null default 'pending' check (state in ('pending','ready','removed')),
  created_at timestamptz not null default now()
);
create unique index item_need_one_image on public.item_need_images(need_id) where state <> 'removed';

create table public.item_need_responses (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null,
  need_id uuid not null,
  listing_id uuid not null,
  responder_id uuid not null references auth.users(id),
  status text not null default 'offered' check (status in ('offered', 'withdrawn')),
  note text not null default '' check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  foreign key (need_id, community_id) references public.item_need_posts(id, community_id),
  foreign key (listing_id, community_id) references public.listings(id, community_id),
  check ((status = 'withdrawn') = (withdrawn_at is not null))
);
create unique index item_need_response_once on public.item_need_responses(need_id, listing_id) where status = 'offered';
create index item_need_response_need on public.item_need_responses(need_id, created_at);

alter table public.item_need_posts enable row level security;
alter table public.item_need_images enable row level security;
alter table public.item_need_responses enable row level security;
revoke all on public.item_need_posts, public.item_need_images, public.item_need_responses from anon, authenticated;
grant select on public.item_need_posts, public.item_need_images, public.item_need_responses to authenticated;
create policy item_need_read on public.item_need_posts for select to authenticated using (public.is_active_member(community_id));
create policy item_need_image_read on public.item_need_images for select to authenticated
  using (exists (select 1 from public.item_need_posts p where p.id = need_id));
create policy item_need_response_read on public.item_need_responses for select to authenticated using (
  public.is_active_member(community_id) and (responder_id = auth.uid()
    or (status = 'offered' and exists (select 1 from public.listings l where l.id = listing_id and l.status = 'published'))));

create function private.guard_item_need_post() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (new.id, new.community_id, new.author_id, new.created_at) is distinct from (old.id, old.community_id, old.author_id, old.created_at)
    or old.status = 'withdrawn' then
    raise exception using errcode = '42501', message = 'Need Post identity and withdrawal are immutable.';
  end if;
  return new;
end;
$$;
create function private.guard_item_need_response() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (new.id, new.community_id, new.need_id, new.listing_id, new.responder_id, new.note, new.created_at)
    is distinct from (old.id, old.community_id, old.need_id, old.listing_id, old.responder_id, old.note, old.created_at) or old.status = 'withdrawn' then
    raise exception using errcode = '42501', message = 'A response changes only by withdrawal.';
  end if;
  return new;
end;
$$;
create trigger item_need_history before update or delete on public.item_need_posts for each row execute function private.guard_item_need_post();
create trigger item_need_response_history before update or delete on public.item_need_responses for each row execute function private.guard_item_need_response();
revoke all on function private.guard_item_need_post(), private.guard_item_need_response() from public, anon, authenticated;

create function private.item_need_fields(p_details jsonb)
returns public.item_need_posts language plpgsql set search_path = '' as $$
declare fields public.item_need_posts;
begin
  if p_details is null or jsonb_typeof(p_details) <> 'object'
    or p_details - array['title','description','category','starts_on','ends_on','urgency','value_min','value_max'] <> '{}'::jsonb
    or not (p_details ?& array['title','description','category','starts_on','ends_on','urgency','value_min','value_max'])
    or exists (select 1 from jsonb_each(p_details) f where
      (f.key in ('title','description','category','starts_on','ends_on','urgency') and jsonb_typeof(f.value) <> 'string')
      or (f.key in ('value_min','value_max') and jsonb_typeof(f.value) not in ('number','null'))) then
    raise exception using errcode = '22023', message = 'Supply the Need Post title, description, category, dates, urgency, and an optional value range.';
  end if;
  fields.title := btrim(p_details->>'title'); fields.description := p_details->>'description'; fields.category := p_details->>'category';
  fields.starts_on := (p_details->>'starts_on')::date; fields.ends_on := (p_details->>'ends_on')::date; fields.urgency := p_details->>'urgency';
  fields.value_min := (p_details->>'value_min')::numeric; fields.value_max := (p_details->>'value_max')::numeric;
  if fields.starts_on > fields.ends_on then raise exception using errcode = '22023', message = 'The last requested day must be on or after the first.'; end if;
  if fields.ends_on < current_date then raise exception using errcode = '22023', message = 'Choose requested dates that have not already passed.'; end if;
  return fields;
end;
$$;
revoke all on function private.item_need_fields(jsonb) from public, anon, authenticated;

create function public.save_item_need(p_intent_id uuid, p_community_id uuid, p_need_id uuid default null, p_expected_version integer default 0, p_details jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('community', p_community_id, 'need', p_need_id, 'version', p_expected_version, 'details', p_details);
  need public.item_need_posts;
  fields public.item_need_posts;
  outcome jsonb;
begin
  perform public.require_current_membership(p_community_id);
  if p_need_id is not null then
    select * into need from public.item_need_posts where id = p_need_id and community_id = p_community_id for update;
    if not found then raise exception using errcode = '42501', message = 'Need Post unavailable.'; end if;
    if need.author_id <> actor then perform public.require_current_membership(p_community_id, true); end if;
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'save_item_need', payload);
  if outcome is not null then return outcome; end if;
  fields := private.item_need_fields(p_details);
  if p_need_id is null then
    if p_expected_version is distinct from 0 then raise exception using errcode = '55000', message = 'New Need Posts require version zero.'; end if;
    insert into public.item_need_posts(community_id, author_id, title, description, category, starts_on, ends_on, urgency, value_min, value_max)
      values(p_community_id, actor, fields.title, fields.description, fields.category, fields.starts_on, fields.ends_on, fields.urgency, fields.value_min, fields.value_max)
      returning * into need;
  else
    if need.status <> 'open' or need.version is distinct from p_expected_version then
      raise exception using errcode = '55000', message = 'This Need Post changed. Reload before editing.';
    end if;
    update public.item_need_posts set title = fields.title, description = fields.description, category = fields.category, starts_on = fields.starts_on,
      ends_on = fields.ends_on, urgency = fields.urgency, value_min = fields.value_min, value_max = fields.value_max, version = version + 1, updated_at = clock_timestamp()
      where id = need.id returning * into need;
  end if;
  perform private.record_borrow_activity(p_community_id, actor, p_intent_id, case when p_need_id is null then 'item_need_published' else 'item_need_edited' end, array[]::uuid[]);
  outcome := to_jsonb(need);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'save_item_need', payload, outcome);
  return outcome;
end;
$$;

create function public.withdraw_item_need(p_intent_id uuid, p_need_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('need', p_need_id, 'version', p_expected_version);
  need public.item_need_posts;
  outcome jsonb;
begin
  select * into need from public.item_need_posts where id = p_need_id for update;
  if not found or actor is null then raise exception using errcode = '42501', message = 'Need Post unavailable.'; end if;
  perform public.require_current_membership(need.community_id, need.author_id <> actor);
  outcome := private.borrow_intent(actor, p_intent_id, 'withdraw_item_need', payload);
  if outcome is not null then return outcome; end if;
  if need.status <> 'open' or need.version is distinct from p_expected_version then
    raise exception using errcode = '55000', message = 'This Need Post changed. Reload before withdrawing.';
  end if;
  update public.item_need_posts set status = 'withdrawn', version = version + 1, updated_at = clock_timestamp() where id = need.id returning * into need;
  perform private.record_borrow_activity(need.community_id, actor, p_intent_id, 'item_need_withdrawn', array[]::uuid[]);
  outcome := to_jsonb(need);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'withdraw_item_need', payload, outcome);
  return outcome;
end;
$$;

create function public.respond_to_item_need(p_intent_id uuid, p_need_id uuid, p_listing_id uuid, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('need', p_need_id, 'listing', p_listing_id, 'note', p_note);
  need public.item_need_posts;
  listing public.listings;
  response public.item_need_responses;
  outcome jsonb;
begin
  select * into need from public.item_need_posts where id = p_need_id for share;
  if not found or actor is null then raise exception using errcode = '42501', message = 'Need Post unavailable.'; end if;
  perform public.require_current_membership(need.community_id);
  select * into listing from public.listings where id = p_listing_id and community_id = need.community_id and owner_id = actor for share;
  if not found then raise exception using errcode = '42501', message = 'Choose one of your own Listings in this Community.'; end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'respond_to_item_need', payload);
  if outcome is not null then return outcome; end if;
  if need.author_id = actor then raise exception using errcode = '22023', message = 'You cannot answer your own Need Post.'; end if;
  if need.status <> 'open' then raise exception using errcode = '55000', message = 'This Need Post was withdrawn.'; end if;
  if listing.status <> 'published' then raise exception using errcode = '55000', message = 'This Listing was withdrawn. Choose a published Listing.'; end if;
  if p_note is null or char_length(p_note) > 1000 then raise exception using errcode = '22023', message = 'Keep the note to 1000 characters.'; end if;
  begin
    insert into public.item_need_responses(community_id, need_id, listing_id, responder_id, note)
      values(need.community_id, need.id, listing.id, actor, p_note) returning * into response;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'This Listing already answers this Need Post.';
  end;
  perform private.record_borrow_activity(need.community_id, actor, p_intent_id, 'item_need_responded', array[need.author_id]);
  outcome := to_jsonb(response);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'respond_to_item_need', payload, outcome);
  return outcome;
end;
$$;

create function public.withdraw_item_need_response(p_intent_id uuid, p_response_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('response', p_response_id);
  response public.item_need_responses;
  outcome jsonb;
begin
  select * into response from public.item_need_responses where id = p_response_id for update;
  if not found or actor is null then raise exception using errcode = '42501', message = 'Response unavailable.'; end if;
  perform public.require_current_membership(response.community_id, response.responder_id <> actor);
  outcome := private.borrow_intent(actor, p_intent_id, 'withdraw_item_need_response', payload);
  if outcome is not null then return outcome; end if;
  if response.status <> 'offered' then raise exception using errcode = '55000', message = 'This response was already withdrawn.'; end if;
  update public.item_need_responses set status = 'withdrawn', withdrawn_at = clock_timestamp() where id = response.id returning * into response;
  perform private.record_borrow_activity(response.community_id, actor, p_intent_id, 'item_need_response_withdrawn', array[]::uuid[]);
  outcome := to_jsonb(response);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'withdraw_item_need_response', payload, outcome);
  return outcome;
end;
$$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values('item-need-images', 'item-need-images', false, 5242880, array['image/jpeg','image/png','image/webp']);

create function private.item_need_image_target(p_need public.item_need_posts, p_image public.item_need_images)
returns void language plpgsql set search_path = '' as $$
begin
  if p_need.status <> 'open' then raise exception using errcode = '55000', message = 'This Need Post was withdrawn.'; end if;
  if p_image.id is not null and p_image.state = 'removed' then raise exception using errcode = '55000', message = 'This image was removed.'; end if;
end;
$$;
revoke all on function private.item_need_image_target(public.item_need_posts, public.item_need_images) from public, anon, authenticated;

create function public.prepare_item_need_image(p_intent_id uuid, p_need_id uuid, p_image_id uuid, p_mime_type text, p_byte_size integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('need', p_need_id, 'image', p_image_id, 'mime', p_mime_type, 'size', p_byte_size);
  need public.item_need_posts;
  image public.item_need_images;
  outcome jsonb;
begin
  select * into need from public.item_need_posts where id = p_need_id for update;
  if not found or actor is null then raise exception using errcode = '42501', message = 'Need Post unavailable.'; end if;
  perform public.require_current_membership(need.community_id, need.author_id <> actor);
  outcome := private.borrow_intent(actor, p_intent_id, 'prepare_item_need_image', payload);
  if outcome is not null then return outcome; end if;
  perform private.item_need_image_target(need, image);
  if exists (select 1 from public.item_need_images where need_id = need.id and state <> 'removed') then
    raise exception using errcode = '22023', message = 'A Need Post has at most one image. Remove the current image first.';
  end if;
  insert into public.item_need_images(id, need_id, object_path, mime_type, byte_size)
    values(p_image_id, need.id, need.community_id::text || '/' || need.id::text || '/' || p_image_id::text, p_mime_type, p_byte_size) returning * into image;
  perform private.record_borrow_activity(need.community_id, actor, p_intent_id, 'item_need_image_prepared', array[]::uuid[]);
  outcome := to_jsonb(image);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'prepare_item_need_image', payload, outcome);
  return outcome;
end;
$$;

create function public.complete_item_need_image(p_intent_id uuid, p_image_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('image', p_image_id);
  need public.item_need_posts;
  image public.item_need_images;
  outcome jsonb;
begin
  select p.* into need from public.item_need_posts p join public.item_need_images i on i.need_id = p.id where i.id = p_image_id for update of p;
  if not found or actor is null then raise exception using errcode = '42501', message = 'Image unavailable.'; end if;
  perform public.require_current_membership(need.community_id, need.author_id <> actor);
  outcome := private.borrow_intent(actor, p_intent_id, 'complete_item_need_image', payload);
  if outcome is not null then return outcome; end if;
  select * into image from public.item_need_images where id = p_image_id for update;
  perform private.item_need_image_target(need, image);
  if image.state <> 'pending' then raise exception using errcode = '55000', message = 'This image is no longer awaiting completion.'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'item-need-images' and o.name = image.object_path
    and (o.metadata->>'size')::bigint = image.byte_size and o.metadata->>'mimetype' = image.mime_type) then
    raise exception using errcode = '55000', message = 'Upload incomplete. Retry the same image.';
  end if;
  update public.item_need_images set state = 'ready' where id = image.id returning * into image;
  perform private.record_borrow_activity(need.community_id, actor, p_intent_id, 'item_need_image_completed', array[]::uuid[]);
  outcome := to_jsonb(image);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'complete_item_need_image', payload, outcome);
  return outcome;
end;
$$;

create function public.remove_item_need_image(p_intent_id uuid, p_image_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('image', p_image_id);
  need public.item_need_posts;
  image public.item_need_images;
  outcome jsonb;
begin
  select p.* into need from public.item_need_posts p join public.item_need_images i on i.need_id = p.id where i.id = p_image_id for update of p;
  if not found or actor is null then raise exception using errcode = '42501', message = 'Image unavailable.'; end if;
  perform public.require_current_membership(need.community_id, need.author_id <> actor);
  outcome := private.borrow_intent(actor, p_intent_id, 'remove_item_need_image', payload);
  if outcome is not null then return outcome; end if;
  select * into image from public.item_need_images where id = p_image_id for update;
  perform private.item_need_image_target(need, image);
  update public.item_need_images set state = 'removed' where id = image.id returning * into image;
  perform private.record_borrow_activity(need.community_id, actor, p_intent_id, 'item_need_image_removed', array[]::uuid[]);
  outcome := to_jsonb(image);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'remove_item_need_image', payload, outcome);
  return outcome;
end;
$$;

revoke all on function public.save_item_need(uuid, uuid, uuid, integer, jsonb), public.withdraw_item_need(uuid, uuid, integer),
  public.respond_to_item_need(uuid, uuid, uuid, text), public.withdraw_item_need_response(uuid, uuid),
  public.prepare_item_need_image(uuid, uuid, uuid, text, integer), public.complete_item_need_image(uuid, uuid), public.remove_item_need_image(uuid, uuid) from public, anon;
grant execute on function public.save_item_need(uuid, uuid, uuid, integer, jsonb), public.withdraw_item_need(uuid, uuid, integer),
  public.respond_to_item_need(uuid, uuid, uuid, text), public.withdraw_item_need_response(uuid, uuid),
  public.prepare_item_need_image(uuid, uuid, uuid, text, integer), public.complete_item_need_image(uuid, uuid), public.remove_item_need_image(uuid, uuid) to authenticated;

create policy item_need_object_read on storage.objects for select to authenticated using (
  bucket_id = 'item-need-images' and exists (select 1 from public.item_need_images i join public.item_need_posts p on p.id = i.need_id
    where i.object_path = name and i.state <> 'removed' and (i.state = 'ready' or p.author_id = auth.uid() or public.is_community_administrator(p.community_id))));
create policy item_need_object_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'item-need-images' and exists (select 1 from public.item_need_images i join public.item_need_posts p on p.id = i.need_id
    where i.object_path = name and i.state = 'pending' and p.status = 'open' and (p.author_id = auth.uid() or public.is_community_administrator(p.community_id))));

notify pgrst, 'reload schema';

create policy item_need_event_privacy on public.community_events as restrictive for select to authenticated
  using (kind not in ('item_need_responded', 'item_need_response_withdrawn',
    'item_need_image_prepared', 'item_need_image_completed', 'item_need_image_removed'));
create policy item_need_outbox_privacy on public.notification_outbox as restrictive for select to authenticated
  using (kind <> 'item_need_responded' or (recipient_id = auth.uid() and public.is_active_member(community_id)));
create policy item_need_reminder_privacy on public.notification_reminders as restrictive for select to authenticated
  using (kind <> 'item_need_responded');
create or replace function public.retry_notification(p_intent_id uuid, p_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item public.notification_outbox; actor uuid := auth.uid(); prior public.command_intents;
  payload jsonb := jsonb_build_object('outbox_id', p_outbox_id);
begin
  select * into item from public.notification_outbox where id = p_outbox_id;
  if not found or item.kind in ('conversation_started', 'message_sent', 'item_need_responded') then
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
  if not private.reminder_current(item) then raise exception using errcode = '55000', message = 'This reminder schedule is obsolete.'; end if;
  if item.state <> 'failed' then raise exception using errcode = '55000', message = 'Only failed deliveries can be retried.'; end if;
  update public.notification_outbox set next_attempt_at = clock_timestamp() where id = item.id returning * into item;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(item.community_id, actor, 'notification_retry_requested', p_intent_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'retry_notification', payload, to_jsonb(item));
  return to_jsonb(item);
end;
$$;
notify pgrst, 'reload schema';

create policy item_need_public_events on public.community_events for select to authenticated
  using (public.is_active_member(community_id) and kind in ('item_need_published', 'item_need_edited', 'item_need_withdrawn'));
