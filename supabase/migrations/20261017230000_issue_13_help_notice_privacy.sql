-- Help Exchange notices and reminders carry participant completion timing. Like item notices they are
-- recipient-only: nonparticipant administrators lose them from outbox status, reminders and the delivery console.
drop policy outbox_status_read on public.notification_outbox;
create policy outbox_status_read on public.notification_outbox for select to authenticated using (
  case when kind like 'item_dispute\_%' then recipient_id = auth.uid() and public.can_read_dispute(dispute_id)
    when kind in ('conversation_started', 'message_sent') then recipient_id = auth.uid() and public.is_active_member(community_id)
    when kind like 'item\_%' or kind like 'help\_%' then recipient_id = auth.uid()
    else recipient_id = auth.uid() or public.is_community_administrator(community_id) end);

drop policy reminder_admin_read on public.notification_reminders;
create policy reminder_admin_read on public.notification_reminders for select to authenticated
  using (public.is_community_administrator(community_id) and kind not in ('conversation_started', 'message_sent')
    and kind not like 'item\_%' and kind not like 'help\_%');

create or replace function public.inspect_notification_deliveries(p_community_id uuid, p_before uuid default null)
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
      and o.kind not like 'item\_%'
      and o.kind not like 'help\_%'
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
