do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'stripe_worker') then
    create role stripe_worker nologin noinherit;
  end if;
end $$;
grant stripe_worker to authenticator;
grant usage on schema public to stripe_worker;

create table public.billing_accounts (
  account_id uuid primary key references auth.users(id),
  customer_id text unique check (customer_id like 'cus_%'),
  created_at timestamptz not null default now()
);
create table public.billing_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.billing_accounts(account_id),
  community_id uuid not null references public.communities(id),
  kind text not null check (kind in ('checkout', 'cancel')),
  state text not null default 'pending' check (state in ('pending', 'processing', 'ready', 'failed')),
  subscription_id text,
  session_id text unique,
  checkout_url text check (checkout_url ~ '^https://checkout\.stripe\.com/'),
  expires_at timestamptz,
  claim_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  check ((state = 'processing' and claim_token is not null and lease_until is not null)
    or (state <> 'processing' and claim_token is null and lease_until is null))
);
create table public.billing_subscriptions (
  subscription_id text primary key check (subscription_id like 'sub_%'),
  account_id uuid not null references public.billing_accounts(account_id),
  customer_id text not null references public.billing_accounts(customer_id),
  status text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  cancel_at_period_end boolean not null,
  reconciled_at timestamptz not null default now()
);
create index billing_subscriptions_account on public.billing_subscriptions(account_id);
create table public.stripe_receipts (
  event_id text primary key check (event_id like 'evt_%'),
  event_type text not null,
  subscription_id text check (subscription_id like 'sub_%'),
  customer_id text check (customer_id like 'cus_%'),
  fingerprint text not null,
  state text not null default 'pending' check (state in ('pending', 'processing', 'failed', 'processed')),
  attempts integer not null default 0,
  last_error text,
  result jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  check ((subscription_id is null) = (customer_id is null)),
  check ((state = 'processed') = (processed_at is not null and result is not null))
);
create table public.stripe_writers (
  subscription_id text primary key,
  event_id text not null references public.stripe_receipts(event_id),
  claim_token uuid not null,
  lease_until timestamptz not null
);

alter table public.billing_accounts enable row level security;
alter table public.billing_jobs enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.stripe_receipts enable row level security;
alter table public.stripe_writers enable row level security;
revoke all on public.billing_accounts, public.billing_jobs, public.billing_subscriptions, public.stripe_receipts, public.stripe_writers from anon, authenticated, stripe_worker;
grant select on public.billing_accounts, public.billing_jobs, public.billing_subscriptions to authenticated;
create policy billing_account_read on public.billing_accounts for select to authenticated using (account_id = auth.uid());
create policy billing_job_read on public.billing_jobs for select to authenticated using (account_id = auth.uid());
create policy billing_subscription_read on public.billing_subscriptions for select to authenticated using (account_id = auth.uid());

create function public.request_test_billing(p_intent_id uuid, p_community_id uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  payload jsonb := jsonb_build_object('community_id', p_community_id, 'kind', p_kind);
  prior public.command_intents;
  job public.billing_jobs;
  subscription public.billing_subscriptions;
begin
  if actor is null or not exists (select 1 from auth.users where id = actor and email_confirmed_at is not null) then
    raise exception using errcode = '42501', message = 'A verified account is required.';
  end if;
  perform public.require_current_membership(p_community_id);
  if p_intent_id is null or p_kind not in ('checkout', 'cancel') or p_kind is null then
    raise exception using errcode = '22023', message = 'A billing intent and valid action are required.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_intent_id::text, 0));
  select * into prior from public.command_intents where actor_id = actor and intent_id = p_intent_id;
  if found then
    if prior.command <> 'request_test_billing' or prior.payload <> payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    return prior.result;
  end if;
  insert into public.billing_accounts(account_id) values(actor) on conflict do nothing;
  perform 1 from public.billing_accounts where account_id = actor for update;
  select * into subscription from public.billing_subscriptions where account_id = actor
    order by case when status not in ('canceled', 'incomplete_expired') then 0 else 1 end, reconciled_at desc limit 1;
  if p_kind = 'checkout' and subscription.status not in ('canceled', 'incomplete_expired') then
    raise exception using errcode = '55000', message = 'This account already has a test subscription.';
  end if;
  if p_kind = 'cancel' and (subscription.subscription_id is null or subscription.status in ('canceled', 'incomplete_expired')) then
    raise exception using errcode = '55000', message = 'There is no current test subscription to cancel.';
  end if;
  select * into job from public.billing_jobs where account_id = actor and kind = p_kind
    and (state in ('pending', 'processing', 'failed') or (p_kind = 'checkout' and state = 'ready' and expires_at > now()))
    order by created_at desc limit 1;
  if job.id is null then
    insert into public.billing_jobs(account_id, community_id, kind, subscription_id)
      values(actor, p_community_id, p_kind, case when p_kind = 'cancel' then subscription.subscription_id end) returning * into job;
    insert into public.community_events(community_id, actor_id, kind, intent_id)
      values(p_community_id, actor, 'test_billing_requested', p_intent_id);
  end if;
  insert into public.command_intents(actor_id, intent_id, command, payload, result)
    values(actor, p_intent_id, 'request_test_billing', payload, jsonb_build_object('job_id', job.id));
  return jsonb_build_object('job_id', job.id);
end;
$$;
revoke all on function public.request_test_billing(uuid, uuid, text) from public, anon;
grant execute on function public.request_test_billing(uuid, uuid, text) to authenticated;

create function public.claim_test_billing(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job public.billing_jobs; customer text;
begin
  select * into job from public.billing_jobs where id = p_job_id for update;
  if job.id is null then raise exception using errcode = '22023', message = 'Unknown billing job.'; end if;
  if job.state = 'ready' then return to_jsonb(job); end if;
  if job.state = 'processing' and job.lease_until > clock_timestamp() then return null; end if;
  if job.created_at < now() - interval '22 hours' then
    raise exception using errcode = '55000', message = 'Billing recovery is required before another provider operation.';
  end if;
  update public.billing_jobs set state = 'processing', claim_token = gen_random_uuid(), lease_until = clock_timestamp() + interval '2 minutes', last_error = null
    where id = job.id returning * into job;
  select customer_id into customer from public.billing_accounts where account_id = job.account_id;
  return to_jsonb(job) || jsonb_build_object('customer_id', customer);
end;
$$;

create function public.link_test_customer(p_job_id uuid, p_claim_token uuid, p_customer_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare job public.billing_jobs;
begin
  select * into job from public.billing_jobs where id = p_job_id for update;
  if job.state <> 'processing' or job.claim_token is distinct from p_claim_token or job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'The billing lease is no longer current.';
  end if;
  update public.billing_accounts set customer_id = p_customer_id where account_id = job.account_id and (customer_id is null or customer_id = p_customer_id);
  if not found then raise exception using errcode = '23505', message = 'The account already has a different customer.'; end if;
end;
$$;

create function public.finish_test_billing(p_job_id uuid, p_claim_token uuid, p_session_id text default null, p_checkout_url text default null, p_expires_at timestamptz default null, p_failed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job public.billing_jobs;
begin
  select * into job from public.billing_jobs where id = p_job_id for update;
  if job.state = 'ready' then return to_jsonb(job); end if;
  if job.state <> 'processing' or job.claim_token is distinct from p_claim_token or job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'The billing lease is no longer current.';
  end if;
  if not p_failed and job.kind = 'checkout' and (p_session_id is null or p_session_id not like 'cs_test_%' or p_checkout_url is null or p_expires_at is null) then
    raise exception using errcode = '22023', message = 'A test Checkout session is required.';
  end if;
  update public.billing_jobs set state = case when p_failed then 'failed' else 'ready' end,
    session_id = p_session_id, checkout_url = p_checkout_url, expires_at = p_expires_at,
    claim_token = null, lease_until = null,
    last_error = case when p_failed then 'Test billing could not finish. Retry this action.' end
    where id = job.id returning * into job;
  return to_jsonb(job);
end;
$$;

create function public.receive_stripe_receipt(p_event_id text, p_event_type text, p_subscription_id text, p_customer_id text, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt public.stripe_receipts;
begin
  insert into public.stripe_receipts(event_id, event_type, subscription_id, customer_id, fingerprint)
    values(p_event_id, p_event_type, p_subscription_id, p_customer_id, p_fingerprint) on conflict do nothing;
  select * into receipt from public.stripe_receipts where event_id = p_event_id;
  if receipt.event_type <> p_event_type or receipt.subscription_id is distinct from p_subscription_id or receipt.customer_id is distinct from p_customer_id or receipt.fingerprint <> p_fingerprint then
    raise exception using errcode = '23505', message = 'The verified event identity has different details.';
  end if;
  if receipt.subscription_id is null and receipt.state <> 'processed' then
    update public.stripe_receipts set state = 'processed', processed_at = clock_timestamp(),
      result = jsonb_build_object('event_id', p_event_id, 'ignored', true) where event_id = p_event_id returning * into receipt;
  end if;
  return to_jsonb(receipt);
end;
$$;

create function public.claim_stripe_receipt(p_event_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt public.stripe_receipts; writer public.stripe_writers;
begin
  select * into receipt from public.stripe_receipts where event_id = p_event_id;
  if receipt.event_id is null then raise exception using errcode = '22023', message = 'Unknown verified event.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('stripe:' || receipt.subscription_id, 0));
  select * into receipt from public.stripe_receipts where event_id = p_event_id for update;
  if receipt.state = 'processed' then return to_jsonb(receipt); end if;
  select * into writer from public.stripe_writers where subscription_id = receipt.subscription_id;
  if writer.lease_until > clock_timestamp() then return null; end if;
  insert into public.stripe_writers(subscription_id, event_id, claim_token, lease_until)
    values(receipt.subscription_id, p_event_id, gen_random_uuid(), clock_timestamp() + interval '2 minutes')
    on conflict (subscription_id) do update set event_id = excluded.event_id, claim_token = excluded.claim_token, lease_until = excluded.lease_until
    returning * into writer;
  update public.stripe_receipts set state = 'processing', attempts = attempts + 1, last_error = null where event_id = p_event_id returning * into receipt;
  return to_jsonb(receipt) || jsonb_build_object('claim_token', writer.claim_token);
end;
$$;

create function public.finish_stripe_receipt(p_event_id text, p_claim_token uuid, p_account_id uuid default null, p_status text default null, p_cancel_at_period_end boolean default false, p_failed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt public.stripe_receipts; writer public.stripe_writers; outcome jsonb;
begin
  select * into receipt from public.stripe_receipts where event_id = p_event_id;
  if receipt.event_id is null then raise exception using errcode = '22023', message = 'Unknown verified event.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('stripe:' || receipt.subscription_id, 0));
  select * into receipt from public.stripe_receipts where event_id = p_event_id for update;
  if receipt.state = 'processed' then return receipt.result; end if;
  select * into writer from public.stripe_writers where subscription_id = receipt.subscription_id;
  if writer.event_id is distinct from p_event_id or writer.claim_token is distinct from p_claim_token or writer.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'The subscription writer is no longer current.';
  end if;
  if p_failed then
    update public.stripe_receipts set state = 'failed', last_error = 'Current subscription reconciliation failed. Retry is required.' where event_id = p_event_id;
    delete from public.stripe_writers where subscription_id = receipt.subscription_id;
    return jsonb_build_object('state', 'failed');
  end if;
  if p_status is null or not exists(select 1 from public.billing_accounts where account_id = p_account_id and customer_id = receipt.customer_id) then
    raise exception using errcode = '42501', message = 'The current Stripe customer must belong to this account.';
  end if;
  if exists(select 1 from public.billing_subscriptions where subscription_id = receipt.subscription_id and (account_id <> p_account_id or customer_id <> receipt.customer_id)) then
    raise exception using errcode = '42501', message = 'Subscription ownership cannot change.';
  end if;
  insert into public.billing_subscriptions(subscription_id, account_id, customer_id, status, cancel_at_period_end)
    values(receipt.subscription_id, p_account_id, receipt.customer_id, p_status, p_cancel_at_period_end)
    on conflict (subscription_id) do update set status = excluded.status, cancel_at_period_end = excluded.cancel_at_period_end, reconciled_at = clock_timestamp();
  update public.billing_jobs set expires_at = clock_timestamp()
    where account_id = p_account_id and kind = 'checkout' and state = 'ready' and expires_at > clock_timestamp();
  outcome := jsonb_build_object('event_id', p_event_id, 'subscription_id', receipt.subscription_id, 'status', p_status);
  update public.stripe_receipts set state = 'processed', result = outcome, processed_at = clock_timestamp(), last_error = null where event_id = p_event_id;
  delete from public.stripe_writers where subscription_id = receipt.subscription_id;
  return outcome;
end;
$$;

revoke all on function public.claim_test_billing(uuid), public.link_test_customer(uuid, uuid, text), public.finish_test_billing(uuid, uuid, text, text, timestamptz, boolean), public.receive_stripe_receipt(text, text, text, text, text), public.claim_stripe_receipt(text), public.finish_stripe_receipt(text, uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.claim_test_billing(uuid), public.link_test_customer(uuid, uuid, text), public.finish_test_billing(uuid, uuid, text, text, timestamptz, boolean), public.receive_stripe_receipt(text, text, text, text, text), public.claim_stripe_receipt(text), public.finish_stripe_receipt(text, uuid, uuid, text, boolean, boolean) to stripe_worker;
