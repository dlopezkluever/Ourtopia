create table public.vouch_settings (
  community_id uuid primary key references public.communities(id),
  annual_limit integer not null default 3 check (annual_limit between 0 and 100)
);
create table public.vouch_eligibility (
  community_id uuid not null references public.communities(id),
  sponsor_id uuid not null references auth.users(id),
  eligible boolean not null,
  primary key (community_id, sponsor_id)
);
create table public.vouch_requests (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  application_id uuid not null references public.membership_applications(id),
  applicant_id uuid not null references auth.users(id),
  sponsor_id uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (application_id, sponsor_id)
);
create table public.vouches (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id),
  application_id uuid not null references public.membership_applications(id),
  applicant_id uuid not null references auth.users(id),
  sponsor_id uuid not null references auth.users(id),
  statement text not null check (char_length(btrim(statement)) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  event_id uuid not null unique references public.community_events(id),
  unique (application_id, sponsor_id)
);
create index vouch_rolling_quota on public.vouches(community_id, sponsor_id, created_at);
create trigger vouches_append_only before update or delete on public.vouches
  for each row execute function private.reject_history_rewrite();
create trigger vouch_requests_append_only before update or delete on public.vouch_requests
  for each row execute function private.reject_history_rewrite();

create function public.is_eligible_sponsor(p_community_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_active_member(p_community_id) and exists (
    select 1 from public.vouch_eligibility where community_id = p_community_id and sponsor_id = auth.uid() and eligible
  );
$$;
revoke all on function public.is_eligible_sponsor(uuid) from public, anon;
grant execute on function public.is_eligible_sponsor(uuid) to authenticated;

alter table public.vouch_settings enable row level security;
alter table public.vouch_eligibility enable row level security;
alter table public.vouch_requests enable row level security;
alter table public.vouches enable row level security;
revoke all on public.vouch_settings, public.vouch_eligibility, public.vouch_requests, public.vouches from anon, authenticated;
grant select on public.vouch_settings, public.vouch_eligibility, public.vouch_requests, public.vouches to authenticated;
create policy vouch_settings_read on public.vouch_settings for select to authenticated using (public.is_active_member(community_id));
create policy vouch_eligibility_read on public.vouch_eligibility for select to authenticated
  using (public.is_community_administrator(community_id) or (sponsor_id = auth.uid() and public.is_active_member(community_id)));
create policy vouch_request_read on public.vouch_requests for select to authenticated
  using (applicant_id = auth.uid() or public.is_community_administrator(community_id) or (sponsor_id = auth.uid() and public.is_eligible_sponsor(community_id)));
create policy vouch_read on public.vouches for select to authenticated
  using (applicant_id = auth.uid() or public.is_community_administrator(community_id) or (sponsor_id = auth.uid() and public.is_active_member(community_id)));

create function private.vouch_prior(p_intent uuid, p_command text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior public.command_intents;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'Sign in first.'; end if;
  if p_intent is null then raise exception using errcode = '22023', message = 'An intent identity is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_intent::text, 0));
  select * into prior from public.command_intents where actor_id = auth.uid() and intent_id = p_intent;
  if found then
    if prior.command <> p_command or prior.payload <> p_payload then
      raise exception using errcode = '23505', message = 'This intent was already used with different details.';
    end if;
    return prior.result;
  end if;
  return null;
end;
$$;
revoke all on function private.vouch_prior(uuid, text, jsonb) from public, anon, authenticated;

create function public.configure_vouch(p_intent_id uuid, p_community_id uuid, p_sponsor_id uuid, p_eligible boolean, p_annual_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  payload jsonb := jsonb_build_object('community_id', p_community_id, 'sponsor_id', p_sponsor_id, 'eligible', p_eligible, 'annual_limit', p_annual_limit);
  result jsonb;
begin
  perform public.require_current_membership(p_community_id, true);
  result := private.vouch_prior(p_intent_id, 'configure_vouch', payload);
  if result is not null then return result; end if;
  if p_eligible is null or p_annual_limit is null or p_annual_limit not between 0 and 100 then
    raise exception using errcode = '22023', message = 'Choose eligibility and an annual limit between 0 and 100.';
  end if;
  perform 1 from public.memberships where community_id = p_community_id and user_id = p_sponsor_id and status = 'active' for share;
  if not found then raise exception using errcode = '42501', message = 'Choose an active member of this Community.'; end if;
  insert into public.vouch_settings(community_id) values(p_community_id) on conflict do nothing;
  perform 1 from public.vouch_settings where community_id = p_community_id for update;
  update public.vouch_settings set annual_limit = p_annual_limit where community_id = p_community_id;
  insert into public.vouch_eligibility values(p_community_id, p_sponsor_id, p_eligible)
    on conflict (community_id, sponsor_id) do update set eligible = excluded.eligible;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(p_community_id, auth.uid(), 'vouch_eligibility_configured', p_intent_id);
  result := payload;
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(auth.uid(), p_intent_id, 'configure_vouch', payload, result);
  insert into public.membership_access_hints(user_id, community_id) values(p_sponsor_id, p_community_id);
  return result;
end;
$$;
revoke all on function public.configure_vouch(uuid, uuid, uuid, boolean, integer) from public, anon;
grant execute on function public.configure_vouch(uuid, uuid, uuid, boolean, integer) to authenticated;

create function public.request_vouch(p_intent_id uuid, p_application_id uuid, p_sponsor_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  application public.membership_applications; request public.vouch_requests; sponsor uuid; event uuid; result jsonb;
  payload jsonb := jsonb_build_object('application_id', p_application_id, 'sponsor_email', p_sponsor_email);
begin
  select * into application from public.membership_applications where id = p_application_id;
  if auth.uid() is null or application.applicant_id is distinct from auth.uid() or private.verified_email() is null then
    raise exception using errcode = '42501', message = 'Only the verified applicant can request a Vouch.';
  end if;
  result := private.vouch_prior(p_intent_id, 'request_vouch', payload);
  insert into public.vouch_settings(community_id) values(application.community_id) on conflict do nothing;
  perform 1 from public.vouch_settings where community_id = application.community_id for update;
  select * into application from public.membership_applications where id = p_application_id for update;
  perform 1 from public.memberships where community_id = application.community_id and user_id = auth.uid() and status = 'pending' for share;
  if not found or application.status <> 'pending' then raise exception using errcode = '55000', message = 'This application is no longer pending.'; end if;
  if result is not null then return result; end if;
  select e.sponsor_id into sponsor from public.vouch_eligibility e join auth.users u on u.id = e.sponsor_id
    join public.memberships m on m.community_id = e.community_id and m.user_id = e.sponsor_id
    where e.community_id = application.community_id and e.eligible and m.status = 'active' and lower(u.email) = lower(btrim(p_sponsor_email)) for share of m;
  if sponsor is null then raise exception using errcode = '42501', message = 'No eligible sponsor is available for that email.'; end if;
  insert into public.vouch_requests(community_id, application_id, applicant_id, sponsor_id)
    values(application.community_id, application.id, auth.uid(), sponsor) returning * into request;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(application.community_id, auth.uid(), 'vouch_requested', p_intent_id) returning id into event;
  insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind, application_id)
    values(event, application.community_id, sponsor, 'in_app', 'vouch_requested', application.id);
  result := to_jsonb(request);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(auth.uid(), p_intent_id, 'request_vouch', payload, result);
  return result;
end;
$$;
revoke all on function public.request_vouch(uuid, uuid, text) from public, anon;
grant execute on function public.request_vouch(uuid, uuid, text) to authenticated;

create function public.submit_vouch(p_intent_id uuid, p_application_id uuid, p_statement text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  application public.membership_applications; item public.vouches; result jsonb; event uuid; recipient uuid; quota integer;
  payload jsonb := jsonb_build_object('application_id', p_application_id, 'statement', p_statement);
begin
  select * into application from public.membership_applications where id = p_application_id;
  if not found then raise exception using errcode = '42501', message = 'Application unavailable.'; end if;
  perform public.require_current_membership(application.community_id);
  result := private.vouch_prior(p_intent_id, 'submit_vouch', payload);
  insert into public.vouch_settings(community_id) values(application.community_id) on conflict do nothing;
  select annual_limit into quota from public.vouch_settings where community_id = application.community_id for update;
  if not public.is_eligible_sponsor(application.community_id) then raise exception using errcode = '42501', message = 'Current sponsorship eligibility is required.'; end if;
  if result is not null then return result; end if;
  if p_statement is null or char_length(btrim(p_statement)) not between 1 and 2000 then raise exception using errcode = '22023', message = 'Write a statement of up to 2000 characters.'; end if;
  select * into application from public.membership_applications where id = p_application_id for update;
  perform 1 from public.memberships where community_id = application.community_id and user_id = application.applicant_id and status = 'pending' for share;
  if not found or application.status <> 'pending' then raise exception using errcode = '55000', message = 'This application is no longer pending.'; end if;
  if exists (select 1 from public.vouches where application_id = application.id and sponsor_id = auth.uid()) then raise exception using errcode = '23505', message = 'You already vouched for this application.'; end if;
  if (select count(*) from public.vouches where community_id = application.community_id and sponsor_id = auth.uid() and created_at > statement_timestamp() - interval '1 year') >= quota then
    raise exception using errcode = '54000', message = 'Your rolling-year Vouch limit has been reached.';
  end if;
  insert into public.community_events(community_id, actor_id, kind, intent_id) values(application.community_id, auth.uid(), 'vouch_submitted', p_intent_id) returning id into event;
  insert into public.vouches(community_id, application_id, applicant_id, sponsor_id, statement, event_id)
    values(application.community_id, application.id, application.applicant_id, auth.uid(), p_statement, event) returning * into item;
  for recipient in select application.applicant_id union select user_id from public.memberships where community_id = application.community_id and role = 'administrator' and status = 'active' loop
    insert into public.notification_outbox(event_id, community_id, recipient_id, channel, kind, application_id)
      values(event, application.community_id, recipient, 'in_app', 'vouch_submitted', application.id);
  end loop;
  result := to_jsonb(item);
  insert into public.command_intents(actor_id, intent_id, command, payload, result) values(auth.uid(), p_intent_id, 'submit_vouch', payload, result);
  return result;
end;
$$;
revoke all on function public.submit_vouch(uuid, uuid, text) from public, anon;
grant execute on function public.submit_vouch(uuid, uuid, text) to authenticated;

create function public.vouch_workspace(p_community_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; is_admin boolean; eligible boolean;
begin
  perform public.require_current_membership(p_community_id);
  is_admin := public.is_community_administrator(p_community_id);
  eligible := public.is_eligible_sponsor(p_community_id);
  select jsonb_build_object('name', c.name, 'administrator', is_admin, 'eligible', eligible,
    'annualLimit', coalesce((select annual_limit from public.vouch_settings where community_id = c.id), 3),
    'used', (select count(*) from public.vouches where community_id = c.id and sponsor_id = auth.uid() and created_at > statement_timestamp() - interval '1 year'),
    'members', case when is_admin then (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'email', u.email, 'eligible', coalesce(e.eligible, false))), '[]') from public.memberships m join auth.users u on u.id = m.user_id left join public.vouch_eligibility e on e.community_id = m.community_id and e.sponsor_id = m.user_id where m.community_id = c.id and m.status = 'active') else '[]'::jsonb end,
    'applications', case when is_admin or eligible then (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'email', a.applicant_email)), '[]') from public.membership_applications a join public.memberships m on m.community_id = a.community_id and m.user_id = a.applicant_id where a.community_id = c.id and a.status = 'pending' and m.status = 'pending') else '[]'::jsonb end,
    'history', (select coalesce(jsonb_agg(to_jsonb(v) || jsonb_build_object('applicantEmail', a.applicant_email, 'sponsorEmail', u.email)), '[]') from public.vouches v join public.membership_applications a on a.id = v.application_id join auth.users u on u.id = v.sponsor_id where v.community_id = c.id and (is_admin or v.sponsor_id = auth.uid())),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'applicationId', r.application_id, 'applicantEmail', a.applicant_email, 'status', a.status)), '[]') from public.vouch_requests r join public.membership_applications a on a.id = r.application_id where r.community_id = c.id and (is_admin or (eligible and r.sponsor_id = auth.uid()))))
    into result from public.communities c where c.id = p_community_id;
  return result;
end;
$$;
revoke all on function public.vouch_workspace(uuid) from public, anon;
grant execute on function public.vouch_workspace(uuid) to authenticated;

create function public.my_vouch_statements()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'Sign in first.'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(v) || jsonb_build_object('sponsorEmail', u.email)), '[]')
    from public.vouches v join auth.users u on u.id = v.sponsor_id where v.applicant_id = auth.uid());
end;
$$;
revoke all on function public.my_vouch_statements() from public, anon;
grant execute on function public.my_vouch_statements() to authenticated;
notify pgrst, 'reload schema';
