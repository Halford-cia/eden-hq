-- Eden HQ · Stage 1: owners correct and retire recorded names
-- (review round 2, P1-5).
--
-- A typo in a recorded person or company stayed in every assignee picker:
-- the browser could only create names. Two operations are added; archiving
-- uses the existing set_contact_archived.
--
--   list_contacts   the workspace's recorded names, active or archived, paged.
--                   Any active member (the same rows the select policy and
--                   list_assignees already show them).
--   update_contact  rename, or change person/company. Owners only: checked
--                   here and again by the outside_contacts update policy and
--                   column grants. Task rows keep pointing at the same
--                   contact, so past assignments show the corrected name.
--
-- Both run with the caller's privileges (SECURITY INVOKER) and return no
-- money field. No new grant to a definer role, no new definer function.

create function eden_api.list_contacts(
  p_workspace_id uuid,
  p_archived boolean default false,
  p_after text default null,
  p_page_size integer default 50
)
returns table (
  id uuid, display_name text, kind text, archived boolean, created_at timestamptz, next_cursor text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_size integer := eden_private.page_size(p_page_size);
  v_after record;
begin
  perform eden_private.require_access(p_workspace_id, false);
  select * into v_after from eden_private.parse_cursor(p_after);
  return query
    with page as (
      select c.*, row_number() over (order by c.created_at, c.id) as rn
      from eden.outside_contacts c
      where c.workspace_id = p_workspace_id
        and (c.archived_at is not null) = coalesce(p_archived, false)
        and (v_after.ts is null or (c.created_at, c.id) > (v_after.ts, v_after.id))
      order by c.created_at, c.id
      limit v_size + 1
    )
    select pg.id, pg.display_name, pg.kind, pg.archived_at is not null, pg.created_at,
      case when pg.rn = v_size and exists (select 1 from page x where x.rn > v_size)
        then eden_private.make_cursor(pg.created_at, pg.id) end
    from page pg
    where pg.rn <= v_size
    order by pg.created_at, pg.id;
end
$$;

create function eden_api.update_contact(p_contact_id uuid, p_display_name text, p_kind text)
returns table (id uuid)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid;
begin
  -- A name the caller cannot see is `unavailable`, whether or not it exists.
  select c.workspace_id into v_ws from eden.outside_contacts c where c.id = p_contact_id;
  perform eden_private.require_access(v_ws, true);
  update eden.outside_contacts c
    set display_name = btrim(p_display_name), kind = p_kind
    where c.id = p_contact_id;
  if not found then
    perform eden_private.unavailable();
  end if;
  return query select p_contact_id;
end
$$;

-- Default privileges (foundation migration) keep PUBLIC from executing these.
grant execute on function eden_api.list_contacts(uuid, boolean, text, integer) to authenticated;
grant execute on function eden_api.update_contact(uuid, text, text) to authenticated;
