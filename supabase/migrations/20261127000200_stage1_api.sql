-- Eden HQ · Stage 1 published operations (schema eden_api)
--
-- Every operation runs with the caller's privileges (SECURITY INVOKER), so the
-- RLS policies and column grants in the foundation migration decide what each
-- caller can read or change. Operations return named fields only. A project,
-- task or workspace the caller cannot see raises the same `unavailable`
-- error (SQLSTATE P0002) whether or not it exists. Stale writes raise
-- `stale` with SQLSTATE PT409 (HTTP 409 through the Data API).
--
-- No Stage 1 operation returns or accepts a money field.

-- ---------------------------------------------------------------------------
-- Private helpers (caller privilege)
-- ---------------------------------------------------------------------------

create function eden_private.require_access(p_workspace_id uuid, p_need_owner boolean)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_workspace_id is null or not eden_private.is_member(p_workspace_id, false) then
    raise exception 'unavailable' using errcode = 'P0002';
  end if;
  if p_need_owner and not eden_private.is_member(p_workspace_id, true) then
    raise exception 'owners only' using errcode = '42501';
  end if;
end
$$;

create function eden_private.project_workspace(p_project_id uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select p.workspace_id into v_ws from eden.projects p where p.id = p_project_id;
  if v_ws is null or not eden_private.is_member(v_ws, false) then
    raise exception 'unavailable' using errcode = 'P0002';
  end if;
  return v_ws;
end
$$;

create function eden_private.page_size(p_page_size integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select greatest(1, least(coalesce(p_page_size, 50), 100))
$$;

create function eden_private.make_cursor(p_ts timestamptz, p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p_id::text
$$;

create function eden_private.parse_cursor(p_cursor text, out ts timestamptz, out id uuid)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_cursor is null or p_cursor = '' then
    ts := null;
    id := null;
    return;
  end if;
  if p_cursor !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  ts := split_part(p_cursor, '|', 1)::timestamptz;
  id := split_part(p_cursor, '|', 2)::uuid;
end
$$;

create function eden_private.reject_unknown_keys(p_object jsonb, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bad text;
begin
  if p_object is null then
    return;
  end if;
  if jsonb_typeof(p_object) <> 'object' then
    raise exception 'expected an object' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(p_object) k where not (k = any (p_allowed)) limit 1;
  if v_bad is not null then
    raise exception 'unknown field %', v_bad using errcode = '22023';
  end if;
end
$$;

create function eden_private.check_status(p_status text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('ready', 'in_progress', 'done') then
    raise exception 'status must be ready, in_progress or done' using errcode = '22023';
  end if;
  return p_status;
end
$$;

-- ---------------------------------------------------------------------------
-- Workspaces and assignees
-- ---------------------------------------------------------------------------

create function eden_api.my_workspaces()
returns table (workspace_id uuid, kind text, name text, time_zone text, role text)
language sql
stable
set search_path = ''
as $$
  select w.id, w.kind, w.name, w.time_zone, m.role
  from eden.workspace_members m
  join eden.workspaces w on w.id = m.workspace_id
  where m.user_id = eden_private.caller_id()
    and m.revoked_at is null
  order by case w.kind when 'home_building' then 1 else 2 end
$$;

create function eden_api.list_assignees(p_workspace_id uuid)
returns table (assignee_kind text, id uuid, display_name text, contact_kind text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform eden_private.require_access(p_workspace_id, false);
  return query
    select 'member'::text, m.user_id, m.display_name, null::text
    from eden.workspace_members m
    where m.workspace_id = p_workspace_id and m.revoked_at is null
    union all
    select 'contact'::text, c.id, c.display_name, c.kind
    from eden.outside_contacts c
    where c.workspace_id = p_workspace_id and c.archived_at is null
    order by 1 desc, 3, 2;
end
$$;

create function eden_api.create_contact(p_workspace_id uuid, p_display_name text, p_kind text)
returns table (id uuid)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  perform eden_private.require_access(p_workspace_id, true);
  insert into eden.outside_contacts (workspace_id, display_name, kind)
    values (p_workspace_id, btrim(p_display_name), p_kind)
    returning outside_contacts.id into v_id;
  return query select v_id;
end
$$;

create function eden_api.set_contact_archived(p_contact_id uuid, p_archived boolean)
returns table (id uuid)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid;
begin
  select c.workspace_id into v_ws from eden.outside_contacts c where c.id = p_contact_id;
  perform eden_private.require_access(v_ws, true);
  update eden.outside_contacts c
    set archived_at = case when p_archived then coalesce(c.archived_at, now()) else null end
    where c.id = p_contact_id;
  return query select p_contact_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

create function eden_api.list_projects(
  p_workspace_id uuid,
  p_include_archived boolean default false,
  p_after text default null,
  p_page_size integer default 50
)
returns table (
  id uuid, name text, description text, archived boolean, open_count bigint,
  version integer, created_at timestamptz, next_cursor text
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
      select p.*, row_number() over (order by p.created_at, p.id) as rn
      from eden.projects p
      where p.workspace_id = p_workspace_id
        and (coalesce(p_include_archived, false) or p.archived_at is null)
        and (v_after.ts is null or (p.created_at, p.id) > (v_after.ts, v_after.id))
      order by p.created_at, p.id
      limit v_size + 1
    )
    select pg.id, pg.name, pg.description, pg.archived_at is not null,
      (select count(*) from eden.tasks t
        where t.project_id = pg.id and t.archived_at is null and t.status <> 'done'),
      pg.version, pg.created_at,
      case when pg.rn = v_size and exists (select 1 from page x where x.rn > v_size)
        then eden_private.make_cursor(pg.created_at, pg.id) end
    from page pg
    where pg.rn <= v_size
    order by pg.created_at, pg.id;
end
$$;

create function eden_api.get_project(p_project_id uuid)
returns table (
  id uuid, workspace_id uuid, workspace_kind text, workspace_name text, name text,
  description text, archived boolean, version integer, created_at timestamptz
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform eden_private.project_workspace(p_project_id);
  return query
    select p.id, p.workspace_id, w.kind, w.name, p.name, p.description,
      p.archived_at is not null, p.version, p.created_at
    from eden.projects p
    join eden.workspaces w on w.id = p.workspace_id
    where p.id = p_project_id;
end
$$;

create function eden_api.create_project(p_workspace_id uuid, p_name text, p_description text default null)
returns table (id uuid, version integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_version integer;
begin
  perform eden_private.require_access(p_workspace_id, true);
  insert into eden.projects (workspace_id, name, description)
    values (p_workspace_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
    returning projects.id, projects.version into v_id, v_version;
  return query select v_id, v_version;
end
$$;

create function eden_api.update_project(
  p_project_id uuid, p_expected_version integer, p_name text, p_description text default null
)
returns table (id uuid, version integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid := eden_private.project_workspace(p_project_id);
  v_version integer;
begin
  perform eden_private.require_access(v_ws, true);
  update eden.projects p
    set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
    where p.id = p_project_id and p.version = p_expected_version
    returning p.version into v_version;
  if v_version is null then
    raise exception 'stale' using errcode = 'PT409';
  end if;
  return query select p_project_id, v_version;
end
$$;

create function eden_api.set_project_archived(p_project_id uuid, p_expected_version integer, p_archived boolean)
returns table (id uuid, version integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid := eden_private.project_workspace(p_project_id);
  v_version integer;
begin
  perform eden_private.require_access(v_ws, true);
  update eden.projects p
    set archived_at = case when p_archived then coalesce(p.archived_at, now()) else null end
    where p.id = p_project_id and p.version = p_expected_version
    returning p.version into v_version;
  if v_version is null then
    raise exception 'stale' using errcode = 'PT409';
  end if;
  return query select p_project_id, v_version;
end
$$;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create function eden_api.list_tasks(
  p_project_id uuid,
  p_filters jsonb default '{}'::jsonb,
  p_after text default null,
  p_page_size integer default 50
)
returns table (
  id uuid, project_id uuid, kind text, title text, status text,
  start_on date, due_on date, follow_up_on date,
  assignee_kind text, assignee_id uuid, assignee_name text,
  archived boolean, version integer, updated_at timestamptz, next_cursor text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid := eden_private.project_workspace(p_project_id);
  v_size integer := eden_private.page_size(p_page_size);
  v_after record;
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status text;
  v_user uuid;
  v_contact uuid;
  v_unassigned boolean;
  v_archived boolean;
  v_kind text;
begin
  perform eden_private.reject_unknown_keys(v_filters,
    array['status', 'assignee_user_id', 'assignee_contact_id', 'unassigned', 'include_archived', 'kind']);
  v_status := v_filters ->> 'status';
  if v_status is not null then
    perform eden_private.check_status(v_status);
  end if;
  v_user := (v_filters ->> 'assignee_user_id')::uuid;
  v_contact := (v_filters ->> 'assignee_contact_id')::uuid;
  v_unassigned := coalesce((v_filters ->> 'unassigned')::boolean, false);
  v_archived := coalesce((v_filters ->> 'include_archived')::boolean, false);
  v_kind := v_filters ->> 'kind';
  select * into v_after from eden_private.parse_cursor(p_after);

  return query
    with page as (
      select t.*, row_number() over (order by t.created_at, t.id) as rn
      from eden.tasks t
      where t.project_id = p_project_id
        and t.workspace_id = v_ws
        and (v_archived or t.archived_at is null)
        and (v_status is null or t.status = v_status)
        and (v_kind is null or t.kind = v_kind)
        and (v_user is null or t.assignee_user_id = v_user)
        and (v_contact is null or t.assignee_contact_id = v_contact)
        and (not v_unassigned or (t.assignee_user_id is null and t.assignee_contact_id is null))
        and (v_after.ts is null or (t.created_at, t.id) > (v_after.ts, v_after.id))
      order by t.created_at, t.id
      limit v_size + 1
    )
    select pg.id, pg.project_id, pg.kind, pg.title, pg.status,
      pg.start_on, pg.due_on, pg.follow_up_on,
      case when pg.assignee_user_id is not null then 'member'
           when pg.assignee_contact_id is not null then 'contact' end,
      coalesce(pg.assignee_user_id, pg.assignee_contact_id),
      coalesce(m.display_name, c.display_name),
      pg.archived_at is not null, pg.version, pg.updated_at,
      case when pg.rn = v_size and exists (select 1 from page x where x.rn > v_size)
        then eden_private.make_cursor(pg.created_at, pg.id) end
    from page pg
    left join eden.workspace_members m
      on m.workspace_id = pg.workspace_id and m.user_id = pg.assignee_user_id
    left join eden.outside_contacts c
      on c.workspace_id = pg.workspace_id and c.id = pg.assignee_contact_id
    where pg.rn <= v_size
    order by pg.created_at, pg.id;
end
$$;

create function eden_api.get_task(p_task_id uuid)
returns table (
  id uuid, workspace_id uuid, workspace_kind text, project_id uuid, project_name text,
  kind text, title text, description text, status text,
  start_on date, due_on date, follow_up_on date,
  assignee_kind text, assignee_id uuid, assignee_name text,
  archived boolean, created_by_name text, created_at timestamptz, updated_at timestamptz,
  version integer, updates jsonb, updates_next text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid;
begin
  select t.workspace_id into v_ws from eden.tasks t where t.id = p_task_id;
  perform eden_private.require_access(v_ws, false);
  return query
    with ups as (
      select u.id, u.body, u.created_at, a.display_name as author_name,
        row_number() over (order by u.created_at, u.id) as rn
      from eden.task_updates u
      left join eden.workspace_members a
        on a.workspace_id = u.workspace_id and a.user_id = u.author_user_id
      where u.task_id = p_task_id
      order by u.created_at, u.id
      limit 21
    )
    select t.id, t.workspace_id, w.kind, t.project_id, p.name,
      t.kind, t.title, t.description, t.status,
      t.start_on, t.due_on, t.follow_up_on,
      case when t.assignee_user_id is not null then 'member'
           when t.assignee_contact_id is not null then 'contact' end,
      coalesce(t.assignee_user_id, t.assignee_contact_id),
      coalesce(m.display_name, c.display_name),
      t.archived_at is not null, cb.display_name, t.created_at, t.updated_at, t.version,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', u.id, 'author_name', u.author_name, 'body', u.body, 'created_at', u.created_at
        ) order by u.rn)
        from ups u where u.rn <= 20
      ), '[]'::jsonb),
      (select eden_private.make_cursor(u.created_at, u.id) from ups u
        where u.rn = 20 and exists (select 1 from ups x where x.rn = 21))
    from eden.tasks t
    join eden.projects p on p.id = t.project_id and p.workspace_id = t.workspace_id
    join eden.workspaces w on w.id = t.workspace_id
    left join eden.workspace_members m
      on m.workspace_id = t.workspace_id and m.user_id = t.assignee_user_id
    left join eden.outside_contacts c
      on c.workspace_id = t.workspace_id and c.id = t.assignee_contact_id
    left join eden.workspace_members cb
      on cb.workspace_id = t.workspace_id and cb.user_id = t.created_by
    where t.id = p_task_id;
end
$$;

create function eden_api.create_task(
  p_project_id uuid,
  p_kind text,
  p_title text,
  p_description text default null,
  p_assignee_user_id uuid default null,
  p_assignee_contact_id uuid default null,
  p_start_on date default null,
  p_due_on date default null,
  p_follow_up_on date default null,
  p_status text default 'ready'
)
returns table (id uuid, version integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid := eden_private.project_workspace(p_project_id);
  v_id uuid;
  v_version integer;
begin
  perform eden_private.check_status(coalesce(p_status, 'ready'));
  insert into eden.tasks (
    workspace_id, project_id, kind, title, description, assignee_user_id,
    assignee_contact_id, start_on, due_on, follow_up_on, status
  ) values (
    v_ws, p_project_id, p_kind, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''),
    p_assignee_user_id, p_assignee_contact_id, p_start_on, p_due_on, p_follow_up_on,
    coalesce(p_status, 'ready')
  )
  returning tasks.id, tasks.version into v_id, v_version;
  return query select v_id, v_version;
end
$$;

-- p_changes keys: title, description, assignee ({"user_id": …} | {"contact_id": …} | null),
-- start_on, due_on, follow_up_on, status. Missing keys keep their value.
create function eden_api.update_task(p_task_id uuid, p_expected_version integer, p_changes jsonb)
returns table (id uuid, version integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  r eden.tasks%rowtype;
  v_assignee jsonb;
  v_user uuid;
  v_contact uuid;
  v_version integer;
begin
  select t.* into r from eden.tasks t where t.id = p_task_id;
  perform eden_private.require_access(r.workspace_id, false);
  perform eden_private.reject_unknown_keys(p_changes,
    array['title', 'description', 'assignee', 'start_on', 'due_on', 'follow_up_on', 'status']);

  v_user := r.assignee_user_id;
  v_contact := r.assignee_contact_id;
  if p_changes ? 'assignee' then
    v_assignee := p_changes -> 'assignee';
    if v_assignee is null or jsonb_typeof(v_assignee) = 'null' then
      v_user := null;
      v_contact := null;
    else
      perform eden_private.reject_unknown_keys(v_assignee, array['user_id', 'contact_id']);
      v_user := (v_assignee ->> 'user_id')::uuid;
      v_contact := (v_assignee ->> 'contact_id')::uuid;
    end if;
  end if;
  if p_changes ? 'status' then
    perform eden_private.check_status(p_changes ->> 'status');
  end if;

  update eden.tasks t set
    title = case when p_changes ? 'title' then btrim(p_changes ->> 'title') else t.title end,
    description = case when p_changes ? 'description'
      then nullif(btrim(coalesce(p_changes ->> 'description', '')), '') else t.description end,
    assignee_user_id = v_user,
    assignee_contact_id = v_contact,
    start_on = case when p_changes ? 'start_on' then (p_changes ->> 'start_on')::date else t.start_on end,
    due_on = case when p_changes ? 'due_on' then (p_changes ->> 'due_on')::date else t.due_on end,
    follow_up_on = case when p_changes ? 'follow_up_on'
      then (p_changes ->> 'follow_up_on')::date else t.follow_up_on end,
    status = case when p_changes ? 'status' then p_changes ->> 'status' else t.status end
  where t.id = p_task_id and t.version = p_expected_version
  returning t.version into v_version;
  if v_version is null then
    raise exception 'stale' using errcode = 'PT409';
  end if;
  return query select p_task_id, v_version;
end
$$;

create function eden_api.set_task_status(p_task_id uuid, p_expected_version integer, p_status text)
returns table (id uuid, version integer)
language sql
set search_path = ''
as $$
  select * from eden_api.update_task(p_task_id, p_expected_version, jsonb_build_object('status', p_status))
$$;

create function eden_api.set_task_archived(p_task_id uuid, p_expected_version integer, p_archived boolean)
returns table (id uuid, version integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_version integer;
begin
  select t.workspace_id into v_ws from eden.tasks t where t.id = p_task_id;
  perform eden_private.require_access(v_ws, true);
  update eden.tasks t
    set archived_at = case when p_archived then coalesce(t.archived_at, now()) else null end
    where t.id = p_task_id and t.version = p_expected_version
    returning t.version into v_version;
  if v_version is null then
    raise exception 'stale' using errcode = 'PT409';
  end if;
  return query select p_task_id, v_version;
end
$$;

-- ---------------------------------------------------------------------------
-- Task updates (append-only notes)
-- ---------------------------------------------------------------------------

create function eden_api.add_update(p_task_id uuid, p_body text)
returns table (id uuid, created_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  r eden.tasks%rowtype;
  v_id uuid;
  v_at timestamptz;
begin
  select t.* into r from eden.tasks t where t.id = p_task_id;
  perform eden_private.require_access(r.workspace_id, false);
  insert into eden.task_updates (workspace_id, project_id, task_id, body)
    values (r.workspace_id, r.project_id, r.id, btrim(p_body))
    returning task_updates.id, task_updates.created_at into v_id, v_at;
  return query select v_id, v_at;
end
$$;

create function eden_api.list_updates(p_task_id uuid, p_after text default null, p_page_size integer default 50)
returns table (id uuid, author_name text, body text, created_at timestamptz, next_cursor text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_size integer := eden_private.page_size(p_page_size);
  v_after record;
begin
  select t.workspace_id into v_ws from eden.tasks t where t.id = p_task_id;
  perform eden_private.require_access(v_ws, false);
  select * into v_after from eden_private.parse_cursor(p_after);
  return query
    with page as (
      select u.*, row_number() over (order by u.created_at, u.id) as rn
      from eden.task_updates u
      where u.task_id = p_task_id
        and (v_after.ts is null or (u.created_at, u.id) > (v_after.ts, v_after.id))
      order by u.created_at, u.id
      limit v_size + 1
    )
    select pg.id, a.display_name, pg.body, pg.created_at,
      case when pg.rn = v_size and exists (select 1 from page x where x.rn > v_size)
        then eden_private.make_cursor(pg.created_at, pg.id) end
    from page pg
    left join eden.workspace_members a
      on a.workspace_id = pg.workspace_id and a.user_id = pg.author_user_id
    where pg.rn <= v_size
    order by pg.created_at, pg.id;
end
$$;

-- ---------------------------------------------------------------------------
-- Operational export: one consistent snapshot (a single statement)
-- ---------------------------------------------------------------------------
-- Members and owners alike receive operational fields only. The full owner
-- export (budgets, receipts, money history) is Stage 2.

create function eden_api.export_project(p_project_id uuid)
returns table (project jsonb, tasks jsonb, updates jsonb)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform eden_private.project_workspace(p_project_id);
  return query
    select
      (select jsonb_build_object(
          'id', p.id, 'name', p.name, 'workspace_kind', w.kind, 'workspace_name', w.name,
          'archived', p.archived_at is not null)
        from eden.projects p join eden.workspaces w on w.id = p.workspace_id
        where p.id = p_project_id),
      coalesce((select jsonb_agg(jsonb_build_object(
          'id', t.id, 'kind', t.kind, 'title', t.title, 'description', t.description,
          'assignee_name', coalesce(m.display_name, c.display_name),
          'assignee_kind', case when t.assignee_user_id is not null then 'member'
                                when t.assignee_contact_id is not null then 'contact' end,
          'start_on', t.start_on, 'due_on', t.due_on, 'follow_up_on', t.follow_up_on,
          'status', t.status, 'archived', t.archived_at is not null,
          'created_at', t.created_at, 'updated_at', t.updated_at)
          order by t.created_at, t.id)
        from eden.tasks t
        left join eden.workspace_members m
          on m.workspace_id = t.workspace_id and m.user_id = t.assignee_user_id
        left join eden.outside_contacts c
          on c.workspace_id = t.workspace_id and c.id = t.assignee_contact_id
        where t.project_id = p_project_id), '[]'::jsonb),
      coalesce((select jsonb_agg(jsonb_build_object(
          'id', u.id, 'task_id', u.task_id, 'author_name', a.display_name,
          'body', u.body, 'created_at', u.created_at)
          order by u.task_id, u.created_at, u.id)
        from eden.task_updates u
        left join eden.workspace_members a
          on a.workspace_id = u.workspace_id and a.user_id = u.author_user_id
        where u.project_id = p_project_id), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Default privileges (foundation migration) keep PUBLIC from executing these.
grant execute on all functions in schema eden_api to authenticated;

grant execute on function eden_private.require_access(uuid, boolean) to authenticated;
grant execute on function eden_private.project_workspace(uuid) to authenticated;
grant execute on function eden_private.page_size(integer) to authenticated;
grant execute on function eden_private.make_cursor(timestamptz, uuid) to authenticated;
grant execute on function eden_private.parse_cursor(text) to authenticated;
grant execute on function eden_private.reject_unknown_keys(jsonb, text[]) to authenticated;
grant execute on function eden_private.check_status(text) to authenticated;
