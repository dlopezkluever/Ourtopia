create function public.claim_notification(p_outbox_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare item public.notification_outbox; token uuid := gen_random_uuid(); address text;
begin
  select * into item from public.notification_outbox
    where (p_outbox_id is null or id = p_outbox_id) and (
      (state in ('pending', 'failed') and next_attempt_at <= clock_timestamp())
      or (state = 'processing' and lease_until <= clock_timestamp())
    ) order by next_attempt_at, id for update skip locked limit 1;
  if not found then return null; end if;
  update public.notification_attempts set finished_at = clock_timestamp(), error = 'Delivery lease expired.'
    where id = item.claim_token and finished_at is null;
  update public.notification_outbox set state = 'processing', attempts = attempts + 1,
    claim_token = token, lease_until = clock_timestamp() + interval '2 minutes'
    where id = item.id returning * into item;
  insert into public.notification_attempts(id, outbox_id, number) values(token, item.id, item.attempts);
  select email into address from auth.users where id = item.recipient_id;
  return to_jsonb(item) || jsonb_build_object('recipient_email', address);
end;
$$;
revoke all on function public.claim_notification(uuid) from public, anon, authenticated;
grant execute on function public.claim_notification(uuid) to service_role;

create function public.finish_notification(p_outbox_id uuid, p_claim_token uuid, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare item public.notification_outbox;
begin
  select * into item from public.notification_outbox where id = p_outbox_id for update;
  if not found then raise exception using errcode = '22023', message = 'Notice unavailable.'; end if;
  if item.state = 'delivered' then return to_jsonb(item); end if;
  if item.state <> 'processing' or item.claim_token <> p_claim_token or item.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'Delivery lease is no longer current.';
  end if;
  update public.notification_attempts set finished_at = clock_timestamp(), error = left(p_error, 500) where id = p_claim_token;
  if p_error is not null then
    update public.notification_outbox set state = 'failed', last_error = left(p_error, 500),
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
revoke all on function public.finish_notification(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.finish_notification(uuid, uuid, text) to service_role;

create function public.retry_notification(p_intent_id uuid, p_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item public.notification_outbox; actor uuid := auth.uid(); prior public.command_intents;
  payload jsonb := jsonb_build_object('outbox_id', p_outbox_id);
begin
  select * into item from public.notification_outbox where id = p_outbox_id;
  if not found then raise exception using errcode = '42501', message = 'Notice unavailable.'; end if;
  perform public.require_current_membership(item.community_id, true);
  if p_intent_id is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'retry_notification' or prior.payload <> payload then raise exception using errcode = '23505', message = 'This intent was already used with different details.'; end if;
    return prior.result;
  end if;
  select * into item from public.notification_outbox where id = p_outbox_id for update;
  if item.state <> 'failed' then raise exception using errcode = '55000', message = 'Only failed deliveries can be retried.'; end if;
  update public.notification_outbox set next_attempt_at = clock_timestamp() where id = item.id returning * into item;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(item.community_id, actor, 'notification_retry_requested', p_intent_id);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(actor, p_intent_id, 'retry_notification', payload, to_jsonb(item));
  return to_jsonb(item);
end;
$$;
revoke all on function public.retry_notification(uuid, uuid) from public, anon;
grant execute on function public.retry_notification(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
