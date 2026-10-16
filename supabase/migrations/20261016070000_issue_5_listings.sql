create table public.listings (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  owner_id uuid not null references auth.users(id),
  type text not null default 'item' check (type = 'item'),
  status text not null default 'published' check (status in ('published', 'withdrawn')),
  version integer not null default 1,
  title text not null check (char_length(btrim(title)) between 2 and 120),
  description text not null check (char_length(description) between 1 and 5000),
  category text not null check (category in ('tools','outdoors','recreation','electronics','kitchen','transportation equipment','sports','creative','household','miscellaneous')),
  condition text not null check (char_length(condition) between 1 and 1000),
  replacement_value numeric(12,2) not null check (replacement_value between 0 and 1000000),
  pickup_notes text not null check (char_length(pickup_notes) <= 2000),
  lending_conditions text not null check (char_length(lending_conditions) <= 2000),
  minimum_score integer not null check (minimum_score between 0 and 100),
  gratitude text not null default '' check (char_length(gratitude) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id, community_id)
);
create index listing_feed on public.listings(community_id, status, created_at desc);
create table public.listing_availability (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id),
  starts_on date not null,
  ends_on date not null,
  dates daterange generated always as (daterange(starts_on, ends_on + 1, '[)')) stored,
  check (starts_on <= ends_on and starts_on >= date '2000-01-01' and ends_on <= date '2100-12-31'),
  unique(listing_id, starts_on, ends_on)
);
create table public.listing_images (
  id uuid primary key,
  listing_id uuid not null references public.listings(id),
  object_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  state text not null default 'pending' check (state in ('pending','ready','removed')),
  created_at timestamptz not null default now()
);
alter table public.listings enable row level security;
alter table public.listing_availability enable row level security;
alter table public.listing_images enable row level security;
revoke all on public.listings, public.listing_availability, public.listing_images from anon, authenticated;
grant select on public.listings, public.listing_availability, public.listing_images to authenticated;
create policy listing_read on public.listings for select to authenticated using (public.is_active_member(community_id));
create policy availability_read on public.listing_availability for select to authenticated using (exists(select 1 from public.listings l where l.id = listing_id));
create policy image_read on public.listing_images for select to authenticated using (exists(select 1 from public.listings l where l.id = listing_id));

create function private.guard_listing_identity() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (new.id, new.community_id, new.owner_id, new.type, new.created_at) is distinct from (old.id, old.community_id, old.owner_id, old.type, old.created_at) then
    raise exception using errcode = '42501', message = 'Listing identity and history are immutable.';
  end if;
  return new;
end;
$$;
create trigger listing_identity before update or delete on public.listings for each row execute function private.guard_listing_identity();
revoke all on function private.guard_listing_identity() from public, anon, authenticated;

create function public.save_listing(p_intent_id uuid, p_community_id uuid, p_listing_id uuid default null, p_expected_version integer default 0, p_details jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  prior public.command_intents;
  listing public.listings;
  payload jsonb := jsonb_build_object('community', p_community_id, 'listing', p_listing_id, 'version', p_expected_version, 'details', p_details);
  period jsonb;
begin
  perform public.require_current_membership(p_community_id);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent is required.'; end if;
  if p_listing_id is not null then
    select * into listing from public.listings where id = p_listing_id and community_id = p_community_id for update;
    if not found then raise exception using errcode = '42501', message = 'Listing unavailable.'; end if;
    if listing.owner_id <> actor then perform public.require_current_membership(p_community_id, true); end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'save_listing' or prior.payload <> payload then raise exception using errcode = '23505', message = 'Intent details changed.'; end if;
    return prior.result;
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' or
    p_details - array['title','description','category','condition','replacement_value','pickup_notes','lending_conditions','minimum_score','gratitude','availability'] <> '{}'::jsonb or
    not (p_details ?& array['title','description','category','condition','replacement_value','pickup_notes','lending_conditions','minimum_score','gratitude','availability']) or
    jsonb_typeof(p_details->'availability') <> 'array' or jsonb_array_length(p_details->'availability') not between 1 and 24 then
    raise exception using errcode = '22023', message = 'Supply Listing fields and 1 to 24 explicit availability ranges.';
  end if;
  if exists(select 1 from jsonb_each(p_details) field where
    (field.key in ('title','description','category','condition','pickup_notes','lending_conditions','gratitude') and jsonb_typeof(field.value) <> 'string') or
    (field.key in ('replacement_value','minimum_score') and jsonb_typeof(field.value) <> 'number')) then
    raise exception using errcode = '22023', message = 'Listing fields have invalid types.';
  end if;
  if p_listing_id is null then
    if p_expected_version <> 0 or p_expected_version is null then raise exception using errcode = '55000', message = 'New Listings require version zero.'; end if;
    insert into public.listings(community_id, owner_id, title, description, category, condition, replacement_value, pickup_notes, lending_conditions, minimum_score, gratitude)
      values(p_community_id, actor, p_details->>'title', p_details->>'description', p_details->>'category', p_details->>'condition',
        (p_details->>'replacement_value')::numeric, p_details->>'pickup_notes', p_details->>'lending_conditions', (p_details->>'minimum_score')::integer, p_details->>'gratitude') returning * into listing;
  else
    if listing.status <> 'published' or listing.version is distinct from p_expected_version then raise exception using errcode = '55000', message = 'Listing changed. Reload before editing.'; end if;
    update public.listings set title = p_details->>'title', description = p_details->>'description', category = p_details->>'category', condition = p_details->>'condition',
      replacement_value = (p_details->>'replacement_value')::numeric, pickup_notes = p_details->>'pickup_notes', lending_conditions = p_details->>'lending_conditions',
      minimum_score = (p_details->>'minimum_score')::integer, gratitude = p_details->>'gratitude', version = version + 1, updated_at = clock_timestamp()
      where id = listing.id returning * into listing;
  end if;
  delete from public.listing_availability where listing_id = listing.id;
  for period in select value from jsonb_array_elements(p_details->'availability') loop
    if period - array['starts_on','ends_on'] <> '{}'::jsonb or not(period ?& array['starts_on','ends_on']) then raise exception using errcode = '22023', message = 'Invalid availability.'; end if;
    insert into public.listing_availability(listing_id, starts_on, ends_on) values(listing.id, (period->>'starts_on')::date, (period->>'ends_on')::date);
  end loop;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community_id, actor, case when p_listing_id is null then 'listing_published' else 'listing_edited' end, p_intent_id);
  insert into public.command_intents(actor_id,intent_id,command,payload,result) values(actor,p_intent_id,'save_listing',payload,to_jsonb(listing));
  return to_jsonb(listing);
end;
$$;
revoke all on function public.save_listing(uuid,uuid,uuid,integer,jsonb) from public, anon;
grant execute on function public.save_listing(uuid,uuid,uuid,integer,jsonb) to authenticated;

create function public.withdraw_listing(p_intent_id uuid, p_listing_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  listing public.listings;
  prior public.command_intents;
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('listing',p_listing_id,'version',p_expected_version);
begin
  select * into listing from public.listings where id = p_listing_id for update;
  if not found then raise exception using errcode = '42501', message = 'Listing unavailable.'; end if;
  perform public.require_current_membership(listing.community_id, listing.owner_id <> actor);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text,0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'withdraw_listing' or prior.payload <> payload then raise exception using errcode = '23505', message = 'Intent details changed.'; end if;
    return prior.result;
  end if;
  if listing.status <> 'published' or listing.version is distinct from p_expected_version then raise exception using errcode = '55000', message = 'Listing changed. Reload before withdrawing.'; end if;
  update public.listings set status = 'withdrawn', version = version + 1, updated_at = clock_timestamp() where id = listing.id returning * into listing;
  insert into public.community_events(community_id,actor_id,kind,intent_id) values(listing.community_id,actor,'listing_withdrawn',p_intent_id);
  insert into public.command_intents(actor_id,intent_id,command,payload,result) values(actor,p_intent_id,'withdraw_listing',payload,to_jsonb(listing));
  return to_jsonb(listing);
end;
$$;
revoke all on function public.withdraw_listing(uuid,uuid,integer) from public, anon;
grant execute on function public.withdraw_listing(uuid,uuid,integer) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('listing-images','listing-images',false,5242880,array['image/jpeg','image/png','image/webp']);
create function public.prepare_listing_image(p_intent_id uuid,p_listing_id uuid,p_image_id uuid,p_mime_type text,p_byte_size integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  listing public.listings;
  image public.listing_images;
  prior public.command_intents;
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('listing',p_listing_id,'image',p_image_id,'mime',p_mime_type,'size',p_byte_size);
begin
  select * into listing from public.listings where id = p_listing_id for update;
  if not found then raise exception using errcode = '42501', message = 'Listing unavailable.'; end if;
  perform public.require_current_membership(listing.community_id,listing.owner_id <> actor);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text,0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'prepare_listing_image' or prior.payload <> payload then raise exception using errcode = '23505', message = 'Intent details changed.'; end if;
    return prior.result;
  end if;
  if listing.status <> 'published' then raise exception using errcode = '55000', message = 'Listing withdrawn.'; end if;
  if (select count(*) from public.listing_images where listing_id = listing.id and state <> 'removed') >= 8 then raise exception using errcode = '22023', message = 'At most eight images per Listing.'; end if;
  insert into public.listing_images(id,listing_id,object_path,mime_type,byte_size) values(p_image_id,listing.id,listing.community_id::text || '/' || listing.id::text || '/' || p_image_id::text,p_mime_type,p_byte_size) returning * into image;
  insert into public.community_events(community_id,actor_id,kind,intent_id) values(listing.community_id,actor,'listing_image_prepared',p_intent_id);
  insert into public.command_intents(actor_id,intent_id,command,payload,result) values(actor,p_intent_id,'prepare_listing_image',payload,to_jsonb(image));
  return to_jsonb(image);
end;
$$;
revoke all on function public.prepare_listing_image(uuid,uuid,uuid,text,integer) from public, anon;
grant execute on function public.prepare_listing_image(uuid,uuid,uuid,text,integer) to authenticated;

create function public.complete_listing_image(p_intent_id uuid,p_image_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  listing public.listings;
  image public.listing_images;
  prior public.command_intents;
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('image',p_image_id);
begin
  select l.* into listing from public.listings l join public.listing_images i on i.listing_id = l.id where i.id = p_image_id for update of l;
  if not found then raise exception using errcode = '42501', message = 'Image unavailable.'; end if;
  perform public.require_current_membership(listing.community_id,listing.owner_id <> actor);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text,0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'complete_listing_image' or prior.payload <> payload then raise exception using errcode = '23505', message = 'Intent details changed.'; end if;
    return prior.result;
  end if;
  select * into image from public.listing_images where id = p_image_id for update;
  if listing.status <> 'published' then raise exception using errcode = '55000', message = 'Listing withdrawn.'; end if;
  if image.state <> 'pending' then raise exception using errcode = '55000', message = 'Image is no longer awaiting completion.'; end if;
  if not exists(select 1 from storage.objects o where o.bucket_id = 'listing-images' and o.name = image.object_path and (o.metadata->>'size')::bigint = image.byte_size and o.metadata->>'mimetype' = image.mime_type) then
    raise exception using errcode = '55000', message = 'Upload incomplete. Retry the same image.';
  end if;
  update public.listing_images set state = 'ready' where id = image.id returning * into image;
  insert into public.community_events(community_id,actor_id,kind,intent_id) values(listing.community_id,actor,'listing_image_completed',p_intent_id);
  insert into public.command_intents(actor_id,intent_id,command,payload,result) values(actor,p_intent_id,'complete_listing_image',payload,to_jsonb(image));
  return to_jsonb(image);
end;
$$;
revoke all on function public.complete_listing_image(uuid,uuid) from public, anon;
grant execute on function public.complete_listing_image(uuid,uuid) to authenticated;

create function public.remove_listing_image(p_intent_id uuid,p_image_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  listing public.listings;
  image public.listing_images;
  prior public.command_intents;
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('image',p_image_id);
begin
  select l.* into listing from public.listings l join public.listing_images i on i.listing_id = l.id where i.id = p_image_id for update of l;
  if not found then raise exception using errcode = '42501', message = 'Image unavailable.'; end if;
  perform public.require_current_membership(listing.community_id,listing.owner_id <> actor);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text,0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'remove_listing_image' or prior.payload <> payload then raise exception using errcode = '23505', message = 'Intent details changed.'; end if;
    return prior.result;
  end if;
  select * into image from public.listing_images where id = p_image_id for update;
  if listing.status <> 'published' or image.state = 'removed' then raise exception using errcode = '55000', message = 'Listing or image changed.'; end if;
  update public.listing_images set state = 'removed' where id = image.id returning * into image;
  insert into public.community_events(community_id,actor_id,kind,intent_id) values(listing.community_id,actor,'listing_image_removed',p_intent_id);
  insert into public.command_intents(actor_id,intent_id,command,payload,result) values(actor,p_intent_id,'remove_listing_image',payload,to_jsonb(image));
  return to_jsonb(image);
end;
$$;
revoke all on function public.remove_listing_image(uuid,uuid) from public, anon;
grant execute on function public.remove_listing_image(uuid,uuid) to authenticated;

create policy listing_object_read on storage.objects for select to authenticated using (
  bucket_id = 'listing-images' and exists(select 1 from public.listing_images i join public.listings l on l.id = i.listing_id
    where i.object_path = name and i.state <> 'removed' and (i.state = 'ready' or l.owner_id = auth.uid() or exists(select 1 from public.memberships m where m.community_id = l.community_id and m.user_id = auth.uid() and m.role = 'administrator' and m.status = 'active')))
);
create policy listing_object_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'listing-images' and exists(select 1 from public.listing_images i join public.listings l on l.id = i.listing_id
    where i.object_path = name and i.state = 'pending' and l.status = 'published' and
      (l.owner_id = auth.uid() or exists(select 1 from public.memberships m where m.community_id = l.community_id and m.user_id = auth.uid() and m.role = 'administrator' and m.status = 'active')))
);
notify pgrst, 'reload schema';
