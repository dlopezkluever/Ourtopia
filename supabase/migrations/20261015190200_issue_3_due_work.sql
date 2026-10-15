create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create function private.dispatch_due_notifications()
returns void language plpgsql security definer set search_path = '' as $$
declare endpoint text; credential text;
begin
  if not exists (select 1 from public.notification_outbox where
    (state in ('pending', 'failed') and next_attempt_at <= clock_timestamp())
    or (state = 'processing' and lease_until <= clock_timestamp())) then return; end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets where name = 'notification_worker_url' limit 1;
  select decrypted_secret into credential from vault.decrypted_secrets where name = 'notification_worker_token' limit 1;
  if endpoint is null or credential is null then return; end if;
  perform net.http_post(url := endpoint, headers := jsonb_build_object('Authorization', 'Bearer ' || credential, 'Content-Type', 'application/json'), body := '{}'::jsonb);
end;
$$;
revoke all on function private.dispatch_due_notifications() from public, anon, authenticated;
select cron.schedule('ourtopia-notification-delivery', '* * * * *', 'select private.dispatch_due_notifications()');
