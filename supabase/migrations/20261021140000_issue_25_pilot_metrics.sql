create function public.read_pilot_metrics(p_community_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community public.communities;
  v_metrics jsonb;
begin
  perform public.require_current_membership(p_community_id, true);

  select c.* into v_community
  from public.communities c
  where c.id = p_community_id;

  if not found then
    raise exception using errcode = '42501', message = 'A current same-Community administrator is required.';
  end if;

  with
  completed as (
    select e.id, e.kind, e.provider_id, e.receiver_id, e.created_at, e.completed_at
    from public.exchanges e
    where e.community_id = p_community_id
      and e.state = 'completed'
      and e.completed_at is not null
      and exists (
        select 1 from public.exchange_events ev
        where ev.exchange_id = e.id and ev.community_id = e.community_id and ev.kind = 'completion_settled'
      )
  ),
  completed_people as (
    select c.provider_id as user_id, c.id as exchange_id, true as contributed from completed c
    union all
    select c.receiver_id as user_id, c.id as exchange_id, false as contributed from completed c
  ),
  cases as (
    select d.id, d.status, d.issue_type, d.created_at
    from public.disputes d where d.community_id = p_community_id
  ),
  billing as (
    select distinct s.subscription_id, s.status
    from public.billing_jobs j
    join public.billing_subscriptions s on s.subscription_id = j.subscription_id
    join public.billing_accounts a on a.account_id = s.account_id
    where j.community_id = p_community_id and j.account_id = s.account_id
  ),
  counts as (
    select
      (select count(*) from public.invites i where i.community_id = p_community_id) as invites_issued,
      (select count(*) from public.membership_applications a where a.community_id = p_community_id) as applications_submitted,
      (select count(*) from public.membership_applications a where a.community_id = p_community_id and a.status = 'approved') as applications_approved,
      (select count(*) from public.memberships m where m.community_id = p_community_id and m.status = 'active') as active_members,
      (select count(*) from public.listings l where l.community_id = p_community_id) as item_listings,
      (select count(*) from public.help_listings l where l.community_id = p_community_id) as help_offers,
      (select count(*) from public.item_need_posts n where n.community_id = p_community_id) as item_need_posts,
      (select count(*) from public.help_need_posts n where n.community_id = p_community_id) as help_need_posts,
      (select count(*) from public.borrow_requests r where r.community_id = p_community_id) as borrow_requests_submitted,
      (select count(*) from public.borrow_requests r where r.community_id = p_community_id and r.status = 'approved') as borrow_requests_approved,
      (select count(*) from public.exchanges e where e.community_id = p_community_id) as exchanges_started,
      (select count(*) from completed) as exchanges_completed,
      (select count(*) from completed_people p where p.contributed) as completed_contributions,
      (select count(distinct p.user_id) from completed_people p where not p.contributed and not exists (
        select 1 from completed_people p2 where p2.user_id = p.user_id and p2.contributed
      )) as receiving_only_participants,
      (select count(*) from cases) as disputes,
      (select count(*) from cases d where d.status in ('issue_reported', 'repairing', 'replacement_agreed', 'disputed', 'admin_review', 'unresolved')) as unresolved_cases,
      (select count(*) from public.reputation_events r where r.community_id = p_community_id and r.rule = 'unresolved_damage' and r.corrects_event_id is null
        and not exists (select 1 from public.reputation_events correction where correction.corrects_event_id = r.id)) as verified_damage_events,
      (select count(*) from public.reputation_events correction join public.reputation_events original on original.id = correction.corrects_event_id
        where correction.community_id = p_community_id and original.rule = 'unresolved_damage') as verified_damage_corrections,
      (select count(*) from public.vouches v where v.community_id = p_community_id) as vouches,
      (select count(*) from public.exchange_thank_yous t where t.community_id = p_community_id) as thank_yous,
      (select count(*) from billing) as test_subscriptions
  )
  select jsonb_build_object(
    'communityId', p_community_id,
    'communityName', v_community.name,
    'generatedAt', statement_timestamp(),
    'counts', jsonb_build_object(
      'invitesIssued', c.invites_issued,
      'applicationsSubmitted', c.applications_submitted,
      'applicationsApproved', c.applications_approved,
      'activeMembers', c.active_members,
      'itemListings', c.item_listings,
      'helpOffers', c.help_offers,
      'itemNeedPosts', c.item_need_posts,
      'helpNeedPosts', c.help_need_posts,
      'borrowRequestsSubmitted', c.borrow_requests_submitted,
      'borrowRequestsApproved', c.borrow_requests_approved,
      'exchangesStarted', c.exchanges_started,
      'exchangesCompleted', c.exchanges_completed,
      'repeatParticipants', (select count(*) from (
        select p.user_id from completed_people p group by p.user_id having count(distinct p.exchange_id) > 1
      ) repeat_people),
      'completedContributions', c.completed_contributions,
      'receivingOnlyParticipants', c.receiving_only_participants,
      'disputes', c.disputes,
      'unresolvedCases', c.unresolved_cases,
      'verifiedDamageEvents', c.verified_damage_events,
      'verifiedDamageCorrections', c.verified_damage_corrections,
      'vouches', c.vouches,
      'thankYous', c.thank_yous,
      'testSubscriptions', c.test_subscriptions
    ),
    'billing', jsonb_build_object(
      'mode', 'simulated_test_billing',
      'statuses', coalesce((select jsonb_object_agg(b.status, b.status_count) from (
        select s.status, count(*) as status_count from billing s group by s.status
      ) b), '{}'::jsonb)
    ),
    'sources', jsonb_build_object(
      'invitations', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'status', case when i.redeemed_at is null then 'issued' else 'redeemed' end, 'createdAt', i.created_at) order by i.created_at) from public.invites i where i.community_id = p_community_id), '[]'::jsonb),
      'applications', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status, 'createdAt', a.created_at) order by a.created_at) from public.membership_applications a where a.community_id = p_community_id), '[]'::jsonb),
      'itemListings', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'status', l.status, 'createdAt', l.created_at) order by l.created_at) from public.listings l where l.community_id = p_community_id), '[]'::jsonb),
      'helpOffers', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'status', l.status, 'createdAt', l.created_at) order by l.created_at) from public.help_listings l where l.community_id = p_community_id), '[]'::jsonb),
      'itemNeedPosts', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'status', n.status, 'createdAt', n.created_at) order by n.created_at) from public.item_need_posts n where n.community_id = p_community_id), '[]'::jsonb),
      'helpNeedPosts', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'status', n.status, 'createdAt', n.created_at) order by n.created_at) from public.help_need_posts n where n.community_id = p_community_id), '[]'::jsonb),
      'borrowRequests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'createdAt', r.created_at) order by r.created_at) from public.borrow_requests r where r.community_id = p_community_id), '[]'::jsonb),
      'exchanges', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'status', e.state, 'completedAt', e.completed_at) order by e.created_at) from public.exchanges e where e.community_id = p_community_id), '[]'::jsonb),
      'completedExchanges', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'completedAt', c.completed_at) order by c.completed_at) from completed c), '[]'::jsonb),
      'disputes', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'status', d.status, 'issueType', d.issue_type, 'createdAt', d.created_at) order by d.created_at) from cases d), '[]'::jsonb),
      'verifiedDamageEvents', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'createdAt', r.created_at) order by r.created_at) from public.reputation_events r where r.community_id = p_community_id and r.rule = 'unresolved_damage' and r.corrects_event_id is null
        and not exists (select 1 from public.reputation_events correction where correction.corrects_event_id = r.id)), '[]'::jsonb),
      'verifiedDamageCorrections', coalesce((select jsonb_agg(jsonb_build_object('id', correction.id, 'createdAt', correction.created_at) order by correction.created_at)
        from public.reputation_events correction join public.reputation_events original on original.id = correction.corrects_event_id
        where correction.community_id = p_community_id and original.rule = 'unresolved_damage'), '[]'::jsonb),
      'vouches', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'createdAt', v.created_at) order by v.created_at) from public.vouches v where v.community_id = p_community_id), '[]'::jsonb),
      'thankYous', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'createdAt', t.created_at) order by t.created_at) from public.exchange_thank_yous t where t.community_id = p_community_id), '[]'::jsonb),
      'testSubscriptions', coalesce((select jsonb_agg(jsonb_build_object('status', b.status) order by b.status) from billing b), '[]'::jsonb)
    )
  ) into v_metrics
  from counts c;

  return v_metrics;
end;
$$;

revoke all on function public.read_pilot_metrics(uuid) from public, anon;
grant execute on function public.read_pilot_metrics(uuid) to authenticated;
