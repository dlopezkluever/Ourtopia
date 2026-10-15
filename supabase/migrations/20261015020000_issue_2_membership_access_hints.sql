create table public.membership_access_hints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  community_id uuid not null references public.communities(id)
);
alter table public.membership_access_hints enable row level security;
revoke all on public.membership_access_hints from anon, authenticated;
grant select on public.membership_access_hints to authenticated;
create policy access_hint_recipient on public.membership_access_hints
  for select to authenticated using (user_id = auth.uid());

create function public.emit_membership_access_hint()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    insert into public.membership_access_hints(user_id, community_id) values (OLD.user_id, OLD.community_id);
    return OLD;
  end if;
  insert into public.membership_access_hints(user_id, community_id) values (NEW.user_id, NEW.community_id);
  if TG_OP = 'UPDATE' and (OLD.user_id is distinct from NEW.user_id or OLD.community_id is distinct from NEW.community_id) then
    insert into public.membership_access_hints(user_id, community_id) values (OLD.user_id, OLD.community_id);
  end if;
  return NEW;
end;
$$;
revoke all on function public.emit_membership_access_hint() from public, anon, authenticated;
create trigger membership_access_changed after insert or update or delete on public.memberships
  for each row execute function public.emit_membership_access_hint();
alter publication supabase_realtime add table public.membership_access_hints;
notify pgrst, 'reload schema';
