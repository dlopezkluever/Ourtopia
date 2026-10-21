-- Current-membership guards for object access and Borrow Request approval (ADR 0003). Listing and need images have no
-- prior-obligation path, so reads and uploads require an active membership in the record's Community.

drop policy if exists listing_object_read on storage.objects;
drop policy if exists listing_object_insert on storage.objects;
create policy listing_object_read on storage.objects for select to authenticated using (
  bucket_id = 'listing-images' and exists(select 1 from public.listing_images i join public.listings l on l.id = i.listing_id
    where i.object_path = name and i.state <> 'removed' and public.is_active_member(l.community_id)
      and (i.state = 'ready' or l.owner_id = auth.uid() or exists(select 1 from public.memberships m where m.community_id = l.community_id and m.user_id = auth.uid() and m.role = 'administrator' and m.status = 'active')))
);
create policy listing_object_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'listing-images' and exists(select 1 from public.listing_images i join public.listings l on l.id = i.listing_id
    where i.object_path = name and i.state = 'pending' and l.status = 'published' and public.is_active_member(l.community_id) and
      (l.owner_id = auth.uid() or exists(select 1 from public.memberships m where m.community_id = l.community_id and m.user_id = auth.uid() and m.role = 'administrator' and m.status = 'active')))
);

drop policy if exists item_need_object_read on storage.objects;
drop policy if exists item_need_object_insert on storage.objects;
create policy item_need_object_read on storage.objects for select to authenticated using (
  bucket_id = 'item-need-images' and exists (select 1 from public.item_need_images i join public.item_need_posts p on p.id = i.need_id
    where i.object_path = name and i.state <> 'removed' and public.is_active_member(p.community_id)
      and (i.state = 'ready' or p.author_id = auth.uid() or public.is_community_administrator(p.community_id))));
create policy item_need_object_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'item-need-images' and exists (select 1 from public.item_need_images i join public.item_need_posts p on p.id = i.need_id
    where i.object_path = name and i.state = 'pending' and p.status = 'open' and public.is_active_member(p.community_id)
      and (p.author_id = auth.uid() or public.is_community_administrator(p.community_id))));

-- Approval re-checks the borrower's current membership and the Listing's status. Rejection and expiry stay open to the owner.
create or replace function public.decide_borrow_request(p_intent_id uuid, p_request_id uuid, p_expected_version integer, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('request', p_request_id, 'version', p_expected_version, 'decision', p_decision);
  listing public.listings;
  request public.borrow_requests;
  exchange public.exchanges;
  window_length interval;
  outcome jsonb;
begin
  select * into request from public.borrow_requests where id = p_request_id;
  if not found or actor is null or actor <> request.owner_id then
    raise exception using errcode = '42501', message = 'Only the Listing owner can decide this Borrow Request.';
  end if;
  perform public.require_current_membership(request.community_id);
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'Choose approve or decline.';
  end if;
  outcome := private.borrow_intent(actor, p_intent_id, 'decide_borrow_request', payload);
  if outcome is not null then return outcome; end if;
  select * into listing from public.listings where id = request.listing_id for update;
  select * into request from public.borrow_requests where id = p_request_id for update;
  if request.status <> 'requested' or p_expected_version is distinct from request.version then
    raise exception using errcode = '55000', message = 'This Borrow Request changed. Refresh before deciding.';
  end if;
  if p_decision = 'rejected' then
    update public.borrow_requests set status = 'rejected', version = version + 1, decided_at = clock_timestamp() where id = request.id;
    perform private.record_borrow_activity(request.community_id, actor, p_intent_id, 'borrow_rejected', array[request.borrower_id]);
  else
    if not exists (select 1 from public.memberships m where m.community_id = request.community_id and m.user_id = request.borrower_id and m.status = 'active') then
      raise exception using errcode = '55000', message = 'The borrower is no longer an active member of this Community.';
    end if;
    if listing.status <> 'published' then
      raise exception using errcode = '55000', message = 'This Listing is no longer published.';
    end if;
    perform private.allocate_item(listing, array[request.id], actor);
    select acknowledgment_window into window_length from public.allocation_settings;
    insert into public.exchanges(community_id, kind, provider_id, receiver_id, source_kind, source_id, state)
      values(listing.community_id, 'item', actor, request.borrower_id, 'listing', listing.id, 'approved') returning * into exchange;
    update public.borrow_requests set status = 'approved', version = version + 1, exchange_id = exchange.id, decided_at = clock_timestamp() where id = request.id;
    begin
      insert into public.item_reservations(exchange_id, request_id, listing_id, starts_on, ends_on, acknowledgment_due_at, condition, replacement_value, lending_conditions)
        values(exchange.id, request.id, listing.id, request.starts_on, request.ends_on, clock_timestamp() + window_length,
          listing.condition, listing.replacement_value, listing.lending_conditions);
    exception when exclusion_violation then
      raise exception using errcode = '23P01', message = 'These dates overlap a reservation that is already approved.';
    end;
    insert into public.exchange_events(exchange_id, community_id, kind, actor_id) values(exchange.id, exchange.community_id, 'item_approved', actor);
    perform private.record_borrow_activity(request.community_id, actor, p_intent_id, 'borrow_approved', array[request.borrower_id]);
  end if;
  outcome := private.borrow_view(request.id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'decide_borrow_request', payload, outcome);
  return outcome;
end;
$$;

notify pgrst, 'reload schema';
