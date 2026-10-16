create extension if not exists btree_gist with schema extensions;

create table public.borrow_requests (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  listing_id uuid not null,
  owner_id uuid not null references auth.users(id),
  borrower_id uuid not null references auth.users(id),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'requested' check (status in ('requested','approved','rejected','expired')),
  version integer not null default 1,
  exchange_id uuid unique references public.exchanges(id),
  created_at timestamptz not null default now(),
  foreign key (listing_id,community_id) references public.listings(id,community_id),
  check (owner_id <> borrower_id),
  check (starts_on <= ends_on and starts_on >= date '2000-01-01' and ends_on <= date '2100-12-31'),
  check ((status in ('approved','expired')) = (exchange_id is not null))
);
create index borrow_requests_listing on public.borrow_requests(listing_id,created_at);
create index borrow_requests_borrower on public.borrow_requests(borrower_id);

create table public.item_reservations (
  exchange_id uuid primary key references public.exchanges(id),
  request_id uuid not null unique references public.borrow_requests(id),
  listing_id uuid not null references public.listings(id),
  starts_on date not null,
  ends_on date not null,
  dates daterange generated always as (daterange(starts_on,ends_on + 1,'[)')) stored,
  acknowledgment_due_at timestamptz not null,
  acknowledged_at timestamptz,
  custody_unresolved boolean not null default false,
  blocking boolean not null default true,
  condition text not null,
  replacement_value numeric(12,2) not null,
  lending_conditions text not null,
  check (starts_on <= ends_on),
  constraint item_reservation_no_overlap exclude using gist (listing_id with =, dates with &&) where (blocking)
);
create index item_reservation_due on public.item_reservations(acknowledgment_due_at) where acknowledged_at is null and blocking;

create function public.can_read_item_obligation(p_exchange_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.exchanges e join public.item_reservations r on r.exchange_id=e.id
    where e.id=p_exchange_id and auth.uid() in (e.provider_id,e.receiver_id)
    and (public.is_active_member(e.community_id) or e.state in ('approved','handoff_pending','checked_out','return_pending') or r.custody_unresolved));
$$;
revoke all on function public.can_read_item_obligation(uuid) from public,anon;
grant execute on function public.can_read_item_obligation(uuid) to authenticated;

alter table public.borrow_requests enable row level security;
alter table public.item_reservations enable row level security;
revoke all on public.borrow_requests,public.item_reservations from anon,authenticated;
grant select on public.borrow_requests,public.item_reservations to authenticated;
create policy borrow_request_read on public.borrow_requests for select to authenticated using (
  auth.uid() in (owner_id,borrower_id) and (public.is_active_member(community_id) or public.can_read_item_obligation(exchange_id)));
create policy reservation_read on public.item_reservations for select to authenticated using (public.can_read_item_obligation(exchange_id));
create policy item_obligation_exchange_read on public.exchanges for select to authenticated using (public.can_read_item_obligation(id));
create policy item_obligation_event_read on public.exchange_events for select to authenticated using (public.can_read_item_obligation(exchange_id));

create function private.guard_borrow_identity() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' or (new.id,new.community_id,new.listing_id,new.owner_id,new.borrower_id,new.starts_on,new.ends_on,new.created_at)
    is distinct from (old.id,old.community_id,old.listing_id,old.owner_id,old.borrower_id,old.starts_on,old.ends_on,old.created_at) then
    raise exception using errcode='42501',message='Borrow Request identity and dates are immutable.';
  end if;
  return new;
end;
$$;
create trigger borrow_identity before update or delete on public.borrow_requests for each row execute function private.guard_borrow_identity();
revoke all on function private.guard_borrow_identity() from public,anon,authenticated;

create function private.guard_item_reservation() returns trigger language plpgsql set search_path = '' as $$
declare e public.exchanges; request public.borrow_requests;
begin
  if tg_op='DELETE' then raise exception using errcode='42501',message='Reservation history is retained.'; end if;
  if tg_op='UPDATE' and (new.exchange_id,new.request_id,new.listing_id,new.starts_on,new.ends_on,new.acknowledgment_due_at,new.condition,new.replacement_value,new.lending_conditions)
    is distinct from (old.exchange_id,old.request_id,old.listing_id,old.starts_on,old.ends_on,old.acknowledgment_due_at,old.condition,old.replacement_value,old.lending_conditions) then
    raise exception using errcode='42501',message='Reservation dates, deadline and terms are immutable.';
  end if;
  select * into e from public.exchanges where id=new.exchange_id;
  select * into request from public.borrow_requests where id=new.request_id;
  if e.kind is distinct from 'item' or e.source_kind is distinct from 'listing' or e.source_id is distinct from new.listing_id or request.exchange_id is distinct from e.id
    or request.listing_id <> new.listing_id or request.community_id <> e.community_id or request.owner_id <> e.provider_id or request.borrower_id <> e.receiver_id
    or (request.starts_on,request.ends_on) is distinct from (new.starts_on,new.ends_on) then
    raise exception using errcode='23514',message='Reservation must match its item Exchange and Borrow Request.';
  end if;
  new.blocking := e.state in ('approved','handoff_pending','checked_out','return_pending') or new.custody_unresolved;
  return new;
end;
$$;
create trigger item_reservation_integrity before insert or update or delete on public.item_reservations for each row execute function private.guard_item_reservation();
revoke all on function private.guard_item_reservation() from public,anon,authenticated;

create function private.sync_item_reservation() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind='item' then
    update public.item_reservations set custody_unresolved = custody_unresolved or new.state in ('checked_out','return_pending'),
      blocking = new.state in ('approved','handoff_pending','checked_out','return_pending') or custody_unresolved where exchange_id=new.id;
  end if;
  return new;
end;
$$;
create trigger item_reservation_state after update of state on public.exchanges for each row execute function private.sync_item_reservation();
revoke all on function private.sync_item_reservation() from public,anon,authenticated;

create function private.guard_item_acknowledgment_deadline() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.kind='item' and old.state='approved' and new.state='handoff_pending' and exists(
    select 1 from public.item_reservations r where r.exchange_id=old.id and
      (r.acknowledgment_due_at <= clock_timestamp() or r.acknowledged_at is null)) then
    raise exception using errcode='55000',message='Acknowledgment must be recorded before the approval deadline.';
  end if;
  return new;
end;
$$;
create trigger item_acknowledgment_deadline before update of state on public.exchanges for each row execute function private.guard_item_acknowledgment_deadline();
revoke all on function private.guard_item_acknowledgment_deadline() from public,anon,authenticated;

create function private.enqueue_borrow_notice(p_event uuid,p_kind text,p_recipient uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.notification_outbox(event_id,community_id,recipient_id,channel,kind)
  select e.id,e.community_id,p_recipient,ch,p_kind from public.community_events e cross join unnest(array['in_app','email']) ch where e.id=p_event
  on conflict(event_id,recipient_id,channel,kind) do nothing;
$$;
revoke all on function private.enqueue_borrow_notice(uuid,text,uuid) from public,anon,authenticated;

create function public.submit_borrow_request(p_intent_id uuid,p_listing_id uuid,p_starts_on date,p_ends_on date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.listings; prior public.command_intents; request public.borrow_requests; event uuid;
  actor uuid := auth.uid(); payload jsonb := jsonb_build_object('listing',p_listing_id,'starts_on',p_starts_on,'ends_on',p_ends_on);
begin
  select * into l from public.listings where id=p_listing_id for update;
  if not found then raise exception using errcode='42501',message='Listing unavailable.'; end if;
  perform public.require_current_membership(l.community_id);
  if actor=l.owner_id then raise exception using errcode='42501',message='Owners cannot borrow their own item.'; end if;
  if p_intent_id is null then raise exception using errcode='22023',message='An intent is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text,0));
  select * into prior from public.command_intents where actor_id=actor and intent_id=p_intent_id;
  if found then
    if prior.command <> 'submit_borrow_request' or prior.payload <> payload then raise exception using errcode='23505',message='Intent details changed.'; end if;
    return prior.result;
  end if;
  if p_starts_on is null or p_ends_on is null or not isfinite(p_starts_on) or not isfinite(p_ends_on) or p_starts_on > p_ends_on or p_starts_on < current_date or p_ends_on > date '2100-12-31' then
    raise exception using errcode='22023',message='Choose valid future inclusive dates.';
  end if;
  if l.status <> 'published' or not exists(select 1 from public.listing_availability a where a.listing_id=l.id and a.dates @> daterange(p_starts_on,p_ends_on+1,'[)')) then
    raise exception using errcode='55000',message='Dates are outside current Listing availability.';
  end if;
  insert into public.borrow_requests(community_id,listing_id,owner_id,borrower_id,starts_on,ends_on)
    values(l.community_id,l.id,l.owner_id,actor,p_starts_on,p_ends_on) returning * into request;
  insert into public.community_events(community_id,actor_id,kind,intent_id) values(l.community_id,actor,'borrow_requested',p_intent_id) returning id into event;
  perform private.enqueue_borrow_notice(event,'borrow_requested',l.owner_id);
  insert into public.command_intents(actor_id,intent_id,command,payload,result) values(actor,p_intent_id,'submit_borrow_request',payload,to_jsonb(request));
  return to_jsonb(request);
end;
$$;
revoke all on function public.submit_borrow_request(uuid,uuid,date,date) from public,anon;
grant execute on function public.submit_borrow_request(uuid,uuid,date,date) to authenticated;

create function private.allocate_item_owner_chooses(p_listing public.listings,p_candidates uuid[],p_decision_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare request public.borrow_requests;
begin
  if p_decision_actor is distinct from p_listing.owner_id or cardinality(p_candidates) <> 1 then
    raise exception using errcode='42501',message='Only this item owner chooses one applicant.';
  end if;
  select * into request from public.borrow_requests where id=p_candidates[1] and listing_id=p_listing.id;
  if not found or request.status <> 'requested' then raise exception using errcode='55000',message='Request is no longer awaiting a decision.'; end if;
  perform 1 from public.memberships where community_id=p_listing.community_id and user_id=request.borrower_id and status='active' for share;
  if not found then raise exception using errcode='42501',message='Borrower is no longer an active member.'; end if;
  if p_listing.status <> 'published' or not exists(select 1 from public.listing_availability a where a.listing_id=p_listing.id and a.dates @> daterange(request.starts_on,request.ends_on+1,'[)')) then
    raise exception using errcode='55000',message='Listing or requested dates are no longer available.';
  end if;
  if request.starts_on < current_date then raise exception using errcode='55000',message='Requested dates have passed.'; end if;
  if private.community_score(request.borrower_id,request.community_id) < p_listing.minimum_score then
    raise exception using errcode='23514',message='Borrower is below the current minimum Community Solidarity Score.';
  end if;
  if exists(select 1 from public.item_reservations r join public.exchanges e on e.id=r.exchange_id where r.listing_id=p_listing.id
    and (r.custody_unresolved or e.state in ('checked_out','return_pending'))) then
    raise exception using errcode='23P01',message='Item custody remains unresolved. Confirm physical recovery before another approval.';
  end if;
end;
$$;
revoke all on function private.allocate_item_owner_chooses(public.listings,uuid[],uuid) from public,anon,authenticated;

create function public.decide_borrow_request(p_intent_id uuid,p_request_id uuid,p_expected_version integer,p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.listings; request public.borrow_requests; prior public.command_intents; event uuid; exchange uuid; result jsonb;
  actor uuid := auth.uid(); payload jsonb := jsonb_build_object('request',p_request_id,'version',p_expected_version,'decision',p_decision);
begin
  select l0.* into l from public.listings l0 join public.borrow_requests b on b.listing_id=l0.id where b.id=p_request_id for update of l0;
  if not found or actor is distinct from l.owner_id then raise exception using errcode='42501',message='Only the active Listing owner can decide.'; end if;
  perform public.require_current_membership(l.community_id);
  if p_intent_id is null or p_decision is null or p_decision not in ('approved','rejected') then raise exception using errcode='22023',message='Supply an intent and approved or rejected decision.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text,0));
  select * into prior from public.command_intents where actor_id=actor and intent_id=p_intent_id;
  if found then
    if prior.command <> 'decide_borrow_request' or prior.payload <> payload then raise exception using errcode='23505',message='Intent details changed.'; end if;
    return prior.result;
  end if;
  select * into request from public.borrow_requests where id=p_request_id for update;
  if request.status <> 'requested' or p_expected_version is distinct from request.version then raise exception using errcode='55000',message='Request changed. Refresh before deciding.'; end if;
  if p_decision='approved' then
    perform private.allocate_item_owner_chooses(l,array[request.id],actor);
    insert into public.exchanges(community_id,kind,provider_id,receiver_id,source_kind,source_id,state)
      values(l.community_id,'item',actor,request.borrower_id,'listing',l.id,'approved') returning id into exchange;
  end if;
  update public.borrow_requests set status=p_decision,version=version+1,exchange_id=exchange where id=request.id returning * into request;
  if exchange is not null then
    insert into public.item_reservations(exchange_id,request_id,listing_id,starts_on,ends_on,acknowledgment_due_at,condition,replacement_value,lending_conditions)
      values(exchange,request.id,l.id,request.starts_on,request.ends_on,clock_timestamp()+interval '48 hours',l.condition,l.replacement_value,l.lending_conditions);
    insert into public.exchange_events(exchange_id,community_id,actor_id,kind) values(exchange,l.community_id,actor,'item_approved');
  end if;
  insert into public.community_events(community_id,actor_id,kind,intent_id) values(l.community_id,actor,'borrow_' || p_decision,p_intent_id) returning id into event;
  perform private.enqueue_borrow_notice(event,'borrow_' || p_decision,request.borrower_id);
  result := to_jsonb(request);
  insert into public.command_intents(actor_id,intent_id,command,payload,result) values(actor,p_intent_id,'decide_borrow_request',payload,result);
  return result;
end;
$$;
revoke all on function public.decide_borrow_request(uuid,uuid,integer,text) from public,anon;
grant execute on function public.decide_borrow_request(uuid,uuid,integer,text) to authenticated;

create function public.check_item_approval(p_exchange_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; r public.item_reservations;
begin
  select * into e from public.exchanges where id=p_exchange_id for update;
  if not public.can_read_item_obligation(p_exchange_id) then raise exception using errcode='42501',message='Item obligation unavailable.'; end if;
  select * into r from public.item_reservations where exchange_id=e.id for update;
  if e.state <> 'approved' or r.acknowledged_at is not null or clock_timestamp() >= r.acknowledgment_due_at then
    raise exception using errcode='55000',message='Approval is no longer awaiting acknowledgment or its deadline has passed.';
  end if;
  return to_jsonb(r);
end;
$$;
revoke all on function public.check_item_approval(uuid) from public,anon;
grant execute on function public.check_item_approval(uuid) to authenticated;

create function public.expire_item_approval(p_exchange_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.exchanges; r public.item_reservations; event uuid;
begin
  select * into e from public.exchanges where id=p_exchange_id for update;
  if not found or e.kind <> 'item' then raise exception using errcode='22023',message='Item Exchange unavailable.'; end if;
  select * into r from public.item_reservations where exchange_id=e.id for update;
  if not found then raise exception using errcode='22023',message='Reservation unavailable.'; end if;
  if e.state <> 'approved' or r.acknowledged_at is not null or clock_timestamp() < r.acknowledgment_due_at then return to_jsonb(e); end if;
  update public.exchanges set state='expired' where id=e.id returning * into e;
  update public.borrow_requests set status='expired',version=version+1 where exchange_id=e.id;
  insert into public.exchange_events(exchange_id,community_id,kind) values(e.id,e.community_id,'item_approval_expired');
  insert into public.community_events(community_id,kind,intent_id) values(e.community_id,'borrow_expired',gen_random_uuid()) returning id into event;
  perform private.enqueue_borrow_notice(event,'borrow_expired',e.provider_id);
  perform private.enqueue_borrow_notice(event,'borrow_expired',e.receiver_id);
  return to_jsonb(e);
end;
$$;
revoke all on function public.expire_item_approval(uuid) from public,anon,authenticated;
grant execute on function public.expire_item_approval(uuid) to service_role;

create function public.expire_due_item_approvals()
returns integer language plpgsql security definer set search_path = '' as $$
declare due record; processed integer := 0;
begin
  for due in select e.id from public.exchanges e join public.item_reservations r on r.exchange_id=e.id
    where e.state='approved' and r.acknowledged_at is null and r.acknowledgment_due_at <= clock_timestamp() order by r.acknowledgment_due_at limit 100
  loop
    perform public.expire_item_approval(due.id);
    processed := processed+1;
  end loop;
  return processed;
end;
$$;
revoke all on function public.expire_due_item_approvals() from public,anon,authenticated;
grant execute on function public.expire_due_item_approvals() to service_role;
select cron.schedule('ourtopia-item-approval-expiry','* * * * *','select public.expire_due_item_approvals()');
notify pgrst,'reload schema';
