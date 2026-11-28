-- Eden HQ · Stage 1 foundation
--
-- Schemas, roles, workspaces, memberships, outside contacts, projects, tasks,
-- task updates, the access gate, the membership helper (the only SECURITY
-- DEFINER function in Stage 1) and the owner-only money guard.
--
-- Rules this migration keeps (docs/SPEC.md, "Access at the database boundary"):
--   * RLS is enabled on every table in the statement block that creates it.
--   * App tables live in `eden`, helpers in `eden_private`; the Data API
--     exposes only `eden_api` (set in the dashboard and supabase/config.toml).
--   * Every function is revoked from PUBLIC and anon; published operations are
--     granted to `authenticated` only.
--   * Money is readable by active owners of the row's workspace only. Stage 1
--     creates `eden.task_budgets` with an owner-only SELECT policy and NO write
--     privilege for any app role; Stage 2 adds the audited write path.
--
-- Runs as Supabase's `postgres` role (not a superuser).

-- ---------------------------------------------------------------------------
-- Schemas and defaults
-- ---------------------------------------------------------------------------

create schema eden;
create schema eden_private;
create schema eden_api;

revoke all on schema eden, eden_private, eden_api from public;

-- New functions created by this role are not executable by PUBLIC.
alter default privileges revoke execute on functions from public;

-- Stage 1 exposes no GraphQL (docs/SPEC.md: the migrations disable it).
drop extension if exists pg_graphql;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

-- Owner of eden_private.is_member. Holds only the privileges granted below.
create role eden_membership_reader nologin noinherit;

-- ---------------------------------------------------------------------------
-- Caller identity (caller-privilege helper, not a definer function)
-- ---------------------------------------------------------------------------
-- Reads the `sub` claim PostgREST places in `request.jwt.claims`. This is the
-- value auth.uid() returns, read without depending on the `auth` schema, so a
-- role without USAGE on `auth` can still identify the caller (spec review
-- round 3, P1-1).

create function eden_private.caller_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when sub ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then sub::uuid
    else null
  end
  from (
    select coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ) as sub
  ) c
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table eden.workspaces (
  id uuid primary key default gen_random_uuid(),
  kind text not null unique check (kind in ('home_building', 'stay_eden_ops')),
  name text not null check (length(btrim(name)) between 1 and 80),
  time_zone text not null default 'America/Chicago'
    check (time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$')
);
alter table eden.workspaces enable row level security;

create table eden.workspace_members (
  workspace_id uuid not null references eden.workspaces (id),
  user_id uuid not null references auth.users (id),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  role text not null check (role in ('owner', 'member')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (workspace_id, user_id)
);
alter table eden.workspace_members enable row level security;
create index workspace_members_user_idx on eden.workspace_members (user_id, workspace_id);

create table eden.outside_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references eden.workspaces (id),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  kind text not null check (kind in ('person', 'vendor')),
  -- Reserved for outside logins later; must stay empty in v1.
  linked_user_id uuid check (linked_user_id is null),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, id)
);
alter table eden.outside_contacts enable row level security;
create index outside_contacts_workspace_idx on eden.outside_contacts (workspace_id, display_name);

create table eden.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references eden.workspaces (id),
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 4000),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  version integer not null default 1,
  unique (workspace_id, id)
);
alter table eden.projects enable row level security;
create index projects_workspace_idx on eden.projects (workspace_id, created_at, id);

create table eden.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  kind text not null check (kind in ('task', 'request', 'maintenance', 'note', 'follow_up')),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (description is null or length(description) <= 8000),
  assignee_user_id uuid,
  assignee_contact_id uuid,
  start_on date,
  due_on date,
  follow_up_on date,
  status text not null default 'ready' check (status in ('ready', 'in_progress', 'done')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  version integer not null default 1,
  unique (workspace_id, project_id, id),
  foreign key (workspace_id, project_id) references eden.projects (workspace_id, id),
  foreign key (workspace_id, assignee_user_id) references eden.workspace_members (workspace_id, user_id),
  foreign key (workspace_id, assignee_contact_id) references eden.outside_contacts (workspace_id, id),
  constraint tasks_one_assignee check (assignee_user_id is null or assignee_contact_id is null),
  constraint tasks_start_before_due check (start_on is null or due_on is null or start_on <= due_on)
);
alter table eden.tasks enable row level security;
create index tasks_project_idx on eden.tasks (project_id, created_at, id);
create index tasks_project_status_idx on eden.tasks (project_id, status, created_at, id);
create index tasks_workspace_due_idx on eden.tasks (workspace_id, due_on);
create index tasks_assignee_user_idx on eden.tasks (workspace_id, assignee_user_id);
create index tasks_assignee_contact_idx on eden.tasks (workspace_id, assignee_contact_id);

create table eden.task_updates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  author_user_id uuid not null,
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, project_id, task_id) references eden.tasks (workspace_id, project_id, id)
);
alter table eden.task_updates enable row level security;
create index task_updates_task_idx on eden.task_updates (task_id, created_at, id);
create index task_updates_project_idx on eden.task_updates (workspace_id, project_id);

-- Owner-only money guard. Stage 2 adds the write operations and the audit
-- trigger; until then no app role can write here at all.
create table eden.task_budgets (
  task_id uuid primary key,
  workspace_id uuid not null,
  project_id uuid not null,
  estimated_cents bigint check (estimated_cents is null or estimated_cents >= 0),
  actual_cents bigint check (actual_cents is null or actual_cents >= 0),
  vendor_name text,
  category text,
  payment_state text not null default 'unpaid' check (payment_state in ('paid', 'unpaid')),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, project_id, task_id) references eden.tasks (workspace_id, project_id, id)
);
alter table eden.task_budgets enable row level security;
create index task_budgets_project_idx on eden.task_budgets (workspace_id, project_id);

-- The access gate. Created closed; backups leave out its data, so every
-- restore starts closed (a missing row counts as closed).
create table eden_private.access_gate (
  id integer primary key check (id = 1),
  is_open boolean not null default false,
  changed_by text not null,
  changed_at timestamptz not null default now()
);
alter table eden_private.access_gate enable row level security;
insert into eden_private.access_gate (id, is_open, changed_by) values (1, false, 'migration');

-- ---------------------------------------------------------------------------
-- Seed: exactly the two workspaces
-- ---------------------------------------------------------------------------

insert into eden.workspaces (kind, name) values
  ('home_building', 'Home building'),
  ('stay_eden_ops', 'Stay Eden operations');

-- ---------------------------------------------------------------------------
-- Membership helper: the Stage 1 SECURITY DEFINER function
-- ---------------------------------------------------------------------------

create function eden_private.is_member(p_workspace_id uuid, p_need_owner boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from eden_private.access_gate g
      where g.id = 1 and g.is_open
    )
    and exists (
      select 1
      from eden.workspace_members m
      where m.workspace_id = p_workspace_id
        and m.user_id::text = coalesce(
          nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
          nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )
        and m.revoked_at is null
        and (not coalesce(p_need_owner, true) or m.role = 'owner')
    ),
    false
  )
$$;

-- Transfer ownership to the reader role. Supabase's `postgres` is not a
-- superuser, so it takes SET on the role and the role takes CREATE on the
-- schema just long enough for the ALTER, then both are taken back.
grant eden_membership_reader to current_user;
grant usage, create on schema eden_private to eden_membership_reader;
alter function eden_private.is_member(uuid, boolean) owner to eden_membership_reader;
revoke create on schema eden_private from eden_membership_reader;
-- Callable by authenticated only (Stage 2 adds eden_receipt_verifier). Granted
-- while this role still acts for the owner.
revoke all on function eden_private.is_member(uuid, boolean) from public, anon;
grant execute on function eden_private.is_member(uuid, boolean) to authenticated;
revoke eden_membership_reader from current_user;

grant usage on schema eden to eden_membership_reader;
grant select (workspace_id, user_id, role, revoked_at) on eden.workspace_members to eden_membership_reader;
grant select (id, is_open) on eden_private.access_gate to eden_membership_reader;

create policy membership_reader_all on eden.workspace_members
  for select to eden_membership_reader using (true);
create policy membership_reader_gate on eden_private.access_gate
  for select to eden_membership_reader using (true);

-- ---------------------------------------------------------------------------
-- Row triggers (caller privilege): server-derived columns and validation
-- ---------------------------------------------------------------------------

create function eden_private.unavailable()
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'unavailable' using errcode = 'P0002';
end
$$;

create function eden_private.workspace_kind(p_workspace_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select w.kind from eden.workspaces w where w.id = p_workspace_id
$$;

create function eden_private.contacts_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(eden_private.caller_id(), new.created_by);
    new.created_at := now();
    new.archived_at := null;
  end if;
  return new;
end
$$;

create trigger outside_contacts_before_write
  before insert or update on eden.outside_contacts
  for each row execute function eden_private.contacts_before_write();

create function eden_private.projects_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(eden_private.caller_id(), new.created_by);
    new.created_at := now();
    new.archived_at := null;
    new.version := 1;
  else
    new.version := old.version + 1;
  end if;
  return new;
end
$$;

create trigger projects_before_write
  before insert or update on eden.projects
  for each row execute function eden_private.projects_before_write();

create function eden_private.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_kind text;
  v_project_archived timestamptz;
begin
  -- Workspace and project must be visible to the caller (RLS applies here).
  v_kind := eden_private.workspace_kind(new.workspace_id);
  select p.archived_at into v_project_archived
    from eden.projects p
    where p.id = new.project_id and p.workspace_id = new.workspace_id;
  if v_kind is null or not found then
    perform eden_private.unavailable();
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(eden_private.caller_id(), new.created_by);
    new.created_at := now();
    new.updated_at := now();
    new.archived_at := null;
    new.version := 1;
    if v_project_archived is not null then
      raise exception 'project is archived' using errcode = '22023';
    end if;
  else
    new.version := old.version + 1;
    new.updated_at := now();
    if new.archived_at is distinct from old.archived_at then
      if not eden_private.is_member(new.workspace_id, true) and eden_private.caller_id() is not null then
        raise exception 'only owners archive or restore tasks' using errcode = '42501';
      end if;
    elsif old.archived_at is not null then
      raise exception 'task is archived' using errcode = '22023';
    end if;
    if v_project_archived is not null and new.archived_at is not distinct from old.archived_at then
      raise exception 'project is archived' using errcode = '22023';
    end if;
  end if;

  -- Kind must belong to the workspace.
  if v_kind = 'home_building' and new.kind <> 'task' then
    raise exception 'home building work uses kind task' using errcode = '22023';
  elsif v_kind = 'stay_eden_ops' and new.kind not in ('request', 'maintenance', 'note', 'follow_up') then
    raise exception 'operations items use request, maintenance, note or follow_up' using errcode = '22023';
  end if;

  -- New assignments require an active member or an unarchived contact.
  if new.assignee_user_id is not null
     and (tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id) then
    if not exists (
      select 1 from eden.workspace_members m
      where m.workspace_id = new.workspace_id
        and m.user_id = new.assignee_user_id
        and m.revoked_at is null
    ) then
      raise exception 'assignee is not an active member of this workspace' using errcode = '22023';
    end if;
  end if;
  if new.assignee_contact_id is not null
     and (tg_op = 'INSERT' or new.assignee_contact_id is distinct from old.assignee_contact_id) then
    if not exists (
      select 1 from eden.outside_contacts c
      where c.workspace_id = new.workspace_id
        and c.id = new.assignee_contact_id
        and c.archived_at is null
    ) then
      raise exception 'assignee is not a recorded name in this workspace' using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;

create trigger tasks_before_write
  before insert or update on eden.tasks
  for each row execute function eden_private.tasks_before_write();

create function eden_private.task_updates_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.author_user_id := coalesce(eden_private.caller_id(), new.author_user_id);
  new.created_at := now();
  if not exists (
    select 1
    from eden.tasks t
    join eden.projects p on p.id = t.project_id and p.workspace_id = t.workspace_id
    where t.id = new.task_id
      and t.project_id = new.project_id
      and t.workspace_id = new.workspace_id
      and t.archived_at is null
      and p.archived_at is null
  ) then
    perform eden_private.unavailable();
  end if;
  return new;
end
$$;

create trigger task_updates_before_insert
  before insert on eden.task_updates
  for each row execute function eden_private.task_updates_before_insert();

-- ---------------------------------------------------------------------------
-- Policies for the app role
-- ---------------------------------------------------------------------------
-- M = active member or owner of the row's workspace; O = active owner.

create policy workspaces_select on eden.workspaces
  for select to authenticated using (eden_private.is_member(id, false));

create policy workspace_members_select on eden.workspace_members
  for select to authenticated using (eden_private.is_member(workspace_id, false));

create policy outside_contacts_select on eden.outside_contacts
  for select to authenticated using (eden_private.is_member(workspace_id, false));
create policy outside_contacts_insert on eden.outside_contacts
  for insert to authenticated with check (eden_private.is_member(workspace_id, true));
create policy outside_contacts_update on eden.outside_contacts
  for update to authenticated
  using (eden_private.is_member(workspace_id, true))
  with check (eden_private.is_member(workspace_id, true));

create policy projects_select on eden.projects
  for select to authenticated using (eden_private.is_member(workspace_id, false));
create policy projects_insert on eden.projects
  for insert to authenticated with check (eden_private.is_member(workspace_id, true));
create policy projects_update on eden.projects
  for update to authenticated
  using (eden_private.is_member(workspace_id, true))
  with check (eden_private.is_member(workspace_id, true));

create policy tasks_select on eden.tasks
  for select to authenticated using (eden_private.is_member(workspace_id, false));
create policy tasks_insert on eden.tasks
  for insert to authenticated with check (eden_private.is_member(workspace_id, false));
create policy tasks_update on eden.tasks
  for update to authenticated
  using (eden_private.is_member(workspace_id, false))
  with check (eden_private.is_member(workspace_id, false));

create policy task_updates_select on eden.task_updates
  for select to authenticated using (eden_private.is_member(workspace_id, false));
create policy task_updates_insert on eden.task_updates
  for insert to authenticated with check (
    eden_private.is_member(workspace_id, false)
    and author_user_id = eden_private.caller_id()
  );

-- Owner-only money: SELECT for active owners; no write policy in Stage 1.
create policy task_budgets_select_owner on eden.task_budgets
  for select to authenticated using (eden_private.is_member(workspace_id, true));

-- No policy on eden_private.access_gate for app roles: deny.

-- ---------------------------------------------------------------------------
-- Table and column privileges for the app role
-- ---------------------------------------------------------------------------

grant usage on schema eden, eden_private, eden_api to authenticated;

grant select (id, kind, name, time_zone) on eden.workspaces to authenticated;
grant select (workspace_id, user_id, display_name, role, granted_at, revoked_at)
  on eden.workspace_members to authenticated;

grant select (id, workspace_id, display_name, kind, linked_user_id, created_by, created_at, archived_at)
  on eden.outside_contacts to authenticated;
grant insert (workspace_id, display_name, kind) on eden.outside_contacts to authenticated;
grant update (display_name, kind, archived_at) on eden.outside_contacts to authenticated;

grant select (id, workspace_id, name, description, created_by, created_at, archived_at, version)
  on eden.projects to authenticated;
grant insert (workspace_id, name, description) on eden.projects to authenticated;
grant update (name, description, archived_at) on eden.projects to authenticated;

grant select (id, workspace_id, project_id, kind, title, description, assignee_user_id,
              assignee_contact_id, start_on, due_on, follow_up_on, status, created_by,
              created_at, updated_at, archived_at, version)
  on eden.tasks to authenticated;
grant insert (workspace_id, project_id, kind, title, description, assignee_user_id,
              assignee_contact_id, start_on, due_on, follow_up_on, status)
  on eden.tasks to authenticated;
grant update (title, description, assignee_user_id, assignee_contact_id, start_on, due_on,
              follow_up_on, status, archived_at)
  on eden.tasks to authenticated;

grant select (id, workspace_id, project_id, task_id, author_user_id, body, created_at)
  on eden.task_updates to authenticated;
grant insert (workspace_id, project_id, task_id, body) on eden.task_updates to authenticated;

grant select (task_id, workspace_id, project_id, estimated_cents, actual_cents, vendor_name,
              category, payment_state, version, updated_at)
  on eden.task_budgets to authenticated;

-- Helper functions the policies and triggers call. (Trigger functions are
-- never called directly and need no EXECUTE grant.) The default privileges
-- set at the top already keep PUBLIC from executing new functions; the
-- inventory test proves it.
grant execute on function eden_private.caller_id() to authenticated;
grant execute on function eden_private.unavailable() to authenticated;
grant execute on function eden_private.workspace_kind(uuid) to authenticated;
