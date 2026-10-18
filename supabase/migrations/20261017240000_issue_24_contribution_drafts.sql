create table public.contribution_drafts (
  owner_id uuid not null references auth.users(id),
  community_id uuid not null references public.communities(id),
  kind text not null check (kind in ('item', 'help_offer', 'help_need')),
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object' and octet_length(fields::text) <= 24000),
  revision integer not null check (revision > 0),
  status text not null check (status in ('editing', 'published', 'discarded')),
  updated_at timestamptz not null default now(),
  primary key (owner_id, community_id, kind)
);
alter table public.contribution_drafts enable row level security;
revoke all on public.contribution_drafts from anon, authenticated;
grant select on public.contribution_drafts to authenticated;
create policy own_active_draft on public.contribution_drafts for select to authenticated
  using (owner_id = auth.uid() and public.is_active_member(community_id));
create policy private_draft_audit on public.community_events as restrictive for select to authenticated
  using (kind not like 'contribution_draft_%' or actor_id = auth.uid());

create function public.command_contribution_draft(p_intent_id uuid, p_owner_id uuid, p_community_id uuid, p_kind text,
  p_expected_revision integer, p_action text, p_fields jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); prior public.contribution_drafts; saved public.contribution_drafts;
  payload jsonb := jsonb_build_object('community', p_community_id, 'kind', p_kind,
    'revision', p_expected_revision, 'action', p_action, 'fields', p_fields);
  outcome jsonb; published jsonb := null;
  child_intent uuid := md5(p_intent_id::text || ':publish-contribution')::uuid;
begin
  if actor is null or actor is distinct from p_owner_id then
    raise exception using errcode = '42501', message = 'This draft belongs to another account. Reload before continuing.';
  end if;
  perform public.require_current_membership(p_community_id);
  outcome := private.borrow_intent(actor, p_intent_id, 'command_contribution_draft', payload);
  if outcome is not null then return outcome; end if;
  if p_kind is null or p_kind not in ('item', 'help_offer', 'help_need') or p_action is null
    or p_action not in ('save', 'publish', 'discard') or p_expected_revision is null or p_expected_revision < 0
    or p_fields is null or jsonb_typeof(p_fields) <> 'object' or octet_length(p_fields::text) > 24000 then
    raise exception using errcode = '22023', message = 'Choose a contribution type and a draft up to 24 KB.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_community_id::text || p_kind, 24));
  select * into prior from public.contribution_drafts where owner_id = actor and community_id = p_community_id and kind = p_kind for update;
  if coalesce(prior.revision, 0) <> p_expected_revision then
    raise exception using errcode = '40001', message = 'This draft changed in another window. Reload before continuing.';
  end if;
  if p_action = 'publish' then
    if prior.status is distinct from 'editing' then
      raise exception using errcode = '55000', message = 'Save a draft before publishing.';
    end if;
    if p_fields <> prior.fields then
      raise exception using errcode = '40001', message = 'Save your latest changes before publishing.';
    end if;
    if p_kind = 'item' then
      published := public.save_listing(child_intent, p_community_id, null, 0, prior.fields);
    else
      published := public.create_help_post(child_intent, p_community_id,
        case when p_kind = 'help_offer' then 'listing' else 'need_post' end, prior.fields);
    end if;
  end if;
  insert into public.contribution_drafts(owner_id, community_id, kind, fields, revision, status)
    values(actor, p_community_id, p_kind, case when p_action = 'save' then p_fields else '{}' end,
      p_expected_revision + 1, case p_action when 'save' then 'editing' when 'publish' then 'published' else 'discarded' end)
    on conflict (owner_id, community_id, kind) do update set fields = excluded.fields,
      revision = excluded.revision, status = excluded.status, updated_at = now() returning * into saved;
  insert into public.community_events(community_id, actor_id, kind, intent_id)
    values(p_community_id, actor, 'contribution_draft_' || p_action, p_intent_id);
  outcome := jsonb_build_object('draft', to_jsonb(saved), 'published', published);
  insert into public.command_intents(actor_id, intent_id, command, payload, result)
    values(actor, p_intent_id, 'command_contribution_draft', payload, outcome);
  return outcome;
end;
$$;
revoke all on function public.command_contribution_draft(uuid, uuid, uuid, text, integer, text, jsonb) from public, anon;
grant execute on function public.command_contribution_draft(uuid, uuid, uuid, text, integer, text, jsonb) to authenticated;
