create function private.delivery_error(p_error text)
returns text language sql immutable set search_path = '' as $$
  select case when p_error is null then null
    when p_error in ('Delivery lease expired.', 'Email delivery failed. Retry is scheduled.') then p_error
    else 'Delivery failed. Retry is scheduled.' end;
$$;
revoke all on function private.delivery_error(text) from public, anon, authenticated;

update public.notification_outbox set last_error = private.delivery_error(last_error) where last_error is not null;
update public.notification_attempts set error = private.delivery_error(error) where error is not null;

create function private.sanitize_delivery_error()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'notification_outbox' then new.last_error := private.delivery_error(new.last_error);
  else new.error := private.delivery_error(new.error); end if;
  return new;
end;
$$;
revoke all on function private.sanitize_delivery_error() from public, anon, authenticated;
create trigger safe_outbox_error before insert or update on public.notification_outbox
  for each row execute function private.sanitize_delivery_error();
create trigger safe_attempt_error before insert or update on public.notification_attempts
  for each row execute function private.sanitize_delivery_error();

create table public.notification_reminders (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  source_key uuid not null,
  recipient_id uuid not null references auth.users(id),
  channel text not null check (channel in ('in_app', 'email')),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,79}$'),
  event_id uuid not null references public.community_events(id),
  due_at timestamptz not null,
  unique (community_id, source_key, recipient_id, channel, kind)
);
alter table public.notification_reminders enable row level security;
revoke all on public.notification_reminders from anon, authenticated;
grant select on public.notification_reminders to authenticated;
create policy reminder_admin_read on public.notification_reminders for select to authenticated
  using (public.is_community_administrator(community_id) and kind not in ('conversation_started', 'message_sent'));
alter table public.notification_outbox add column reminder_id uuid references public.notification_reminders(id);
alter table public.notification_outbox add column reminder_due_at timestamptz;
alter table public.notification_outbox add constraint reminder_pair check ((reminder_id is null) = (reminder_due_at is null));
alter table public.notification_outbox drop constraint notification_outbox_state_check;
alter table public.notification_outbox add constraint notification_outbox_state_check
  check (state in ('pending', 'processing', 'failed', 'delivered', 'suppressed'));
create index delivery_console_page on public.notification_outbox(community_id, created_at desc, id desc);

-- Producers call this inside their guarded schedule transaction, after recording its event.
create function public.schedule_notification_reminder(p_community_id uuid, p_source_key uuid,
  p_event_id uuid, p_recipient_id uuid, p_channel text, p_kind text, p_due_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare reminder public.notification_reminders; notice_id uuid; previous_due timestamptz; previous_source uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_community_id::text || p_source_key::text || p_recipient_id::text || p_channel || p_kind, 0));
  if not exists (select 1 from public.community_events where id = p_event_id and community_id = p_community_id) then
    raise exception using errcode = '22023', message = 'Reminder event must belong to its Community.';
  end if;
  select o.id, o.reminder_due_at, r.source_key into notice_id, previous_due, previous_source
    from public.notification_outbox o left join public.notification_reminders r on r.id = o.reminder_id
    where o.event_id = p_event_id and o.recipient_id = p_recipient_id and o.channel = p_channel and o.kind = p_kind;
  if found then
    if previous_due is distinct from p_due_at or previous_source is distinct from p_source_key then
      raise exception using errcode = '23505', message = 'A changed schedule requires a new source event.';
    end if;
    return notice_id;
  end if;
  insert into public.notification_reminders(community_id, source_key, recipient_id, channel, kind, event_id, due_at)
    values(p_community_id, p_source_key, p_recipient_id, p_channel, p_kind, p_event_id, p_due_at)
    on conflict (community_id, source_key, recipient_id, channel, kind) do update
    set event_id = excluded.event_id, due_at = excluded.due_at returning * into reminder;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind, next_attempt_at, reminder_id, reminder_due_at)
    values(p_event_id, p_community_id, p_recipient_id, p_channel, p_kind, p_due_at, reminder.id, p_due_at)
    on conflict (event_id, recipient_id, channel, kind) do nothing;
  select id into notice_id from public.notification_outbox where event_id = p_event_id
    and recipient_id = p_recipient_id and channel = p_channel and kind = p_kind
    and reminder_id = reminder.id and reminder_due_at = p_due_at;
  if not found then raise exception using errcode = '23505', message = 'This event already identifies another reminder.'; end if;
  return notice_id;
end;
$$;
revoke all on function public.schedule_notification_reminder(uuid, uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.schedule_notification_reminder(uuid, uuid, uuid, uuid, text, text, timestamptz) to service_role;

create function private.reminder_current(p_notice public.notification_outbox)
returns boolean language plpgsql set search_path = '' as $$
declare reminder public.notification_reminders;
begin
  if p_notice.reminder_id is null then return true; end if;
  select * into reminder from public.notification_reminders where id = p_notice.reminder_id for share;
  return found and reminder.event_id = p_notice.event_id and reminder.due_at = p_notice.reminder_due_at;
end;
$$;
revoke all on function private.reminder_current(public.notification_outbox) from public, anon, authenticated;

create or replace function public.claim_notification(p_outbox_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare item public.notification_outbox; token uuid; address text;
begin
  loop
    select * into item from public.notification_outbox
      where (p_outbox_id is null or id = p_outbox_id) and (
        (state in ('pending', 'failed') and next_attempt_at <= clock_timestamp())
        or (state = 'processing' and lease_until <= clock_timestamp()))
      order by next_attempt_at, id for update skip locked limit 1;
    if not found then return null; end if;
    update public.notification_attempts set finished_at = clock_timestamp(), error = 'Delivery lease expired.'
      where id = item.claim_token and finished_at is null;
    if not private.reminder_current(item) then
      update public.notification_outbox set state = 'suppressed', lease_until = null, last_error = null where id = item.id;
      continue;
    end if;
    token := gen_random_uuid();
    update public.notification_outbox set state = 'processing', attempts = attempts + 1,
      claim_token = token, lease_until = clock_timestamp() + interval '2 minutes' where id = item.id returning * into item;
    insert into public.notification_attempts(id, outbox_id, number) values(token, item.id, item.attempts);
    select email into address from auth.users where id = item.recipient_id;
    return to_jsonb(item) || jsonb_build_object('recipient_email', address);
  end loop;
end;
$$;

create or replace function public.finish_notification(p_outbox_id uuid, p_claim_token uuid, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare item public.notification_outbox;
begin
  select * into item from public.notification_outbox where id = p_outbox_id for update;
  if not found then raise exception using errcode = '22023', message = 'Notice unavailable.'; end if;
  if item.state in ('delivered', 'suppressed') then return to_jsonb(item); end if;
  if item.state <> 'processing' or item.claim_token is distinct from p_claim_token or item.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'Delivery lease is no longer current.';
  end if;
  update public.notification_attempts set finished_at = clock_timestamp(), error = private.delivery_error(p_error) where id = p_claim_token;
  if not private.reminder_current(item) then
    update public.notification_outbox set state = 'suppressed', lease_until = null, last_error = null where id = item.id returning * into item;
  elsif p_error is not null then
    update public.notification_outbox set state = 'failed', last_error = private.delivery_error(p_error),
      next_attempt_at = clock_timestamp() + least(interval '1 hour', interval '30 seconds' * power(2, least(item.attempts - 1, 7))),
      lease_until = null where id = item.id returning * into item;
  else
    if item.channel = 'in_app' then
      insert into public.notifications(outbox_id, recipient_id, application_id, kind)
        values(item.id, item.recipient_id, item.application_id, item.kind) on conflict (outbox_id) do nothing;
      insert into public.notification_hints(recipient_id) values(item.recipient_id);
    end if;
    update public.notification_outbox set state = 'delivered', delivered_at = clock_timestamp(), last_error = null,
      lease_until = null where id = item.id returning * into item;
  end if;
  return to_jsonb(item);
end;
$$;

create function public.check_notification_claim(p_outbox_id uuid, p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare item public.notification_outbox;
begin
  select * into item from public.notification_outbox where id = p_outbox_id for update;
  if not found or item.state <> 'processing' or item.claim_token is distinct from p_claim_token
    or item.lease_until <= clock_timestamp() then return false; end if;
  if not private.reminder_current(item) then
    perform public.finish_notification(item.id, p_claim_token);
    return false;
  end if;
  return true;
end;
$$;
revoke all on function public.check_notification_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.check_notification_claim(uuid, uuid) to service_role;

create or replace function public.retry_notification(p_intent_id uuid, p_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item public.notification_outbox; actor uuid := auth.uid(); prior public.command_intents;
  payload jsonb := jsonb_build_object('outbox_id', p_outbox_id);
begin
  select * into item from public.notification_outbox where id = p_outbox_id;
  if not found or item.kind in ('conversation_started', 'message_sent') then
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

create function public.inspect_notification_deliveries(p_community_id uuid, p_before uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.require_current_membership(p_community_id, true);
  select coalesce(jsonb_agg(diagnostic order by diagnostic.created_at desc, diagnostic.id desc), '[]'::jsonb) into result from (
    select o.id, o.event_id, o.recipient_id, o.channel,
      case when o.kind ~ '^[a-z][a-z0-9_]{0,79}$' then o.kind else 'notification' end as kind,
      o.state, o.attempts, o.next_attempt_at, o.delivered_at, o.created_at,
      (o.state in ('pending', 'failed') and o.next_attempt_at <= clock_timestamp())
        or (o.state = 'processing' and o.lease_until <= clock_timestamp()) as due,
      private.delivery_error(o.last_error) as last_error, o.reminder_due_at,
      case when o.reminder_id is null then null else exists (
        select 1 from public.notification_reminders r where r.id = o.reminder_id
          and r.event_id = o.event_id and r.due_at = o.reminder_due_at
      ) end as current_schedule,
      coalesce((select jsonb_agg(jsonb_build_object('number', a.number, 'started_at', a.started_at,
        'finished_at', a.finished_at, 'error', private.delivery_error(a.error)) order by a.number)
        from public.notification_attempts a where a.outbox_id = o.id), '[]'::jsonb) as history
    from public.notification_outbox o where o.community_id = p_community_id
      and o.kind not in ('conversation_started', 'message_sent')
      and (p_before is null or (o.created_at, o.id) < (select cursor.created_at, cursor.id
        from public.notification_outbox cursor where cursor.id = p_before and cursor.community_id = p_community_id))
    order by o.created_at desc, o.id desc limit 50
  ) diagnostic;
  return result;
end;
$$;
revoke all on function public.inspect_notification_deliveries(uuid, uuid) from public, anon;
grant execute on function public.inspect_notification_deliveries(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
