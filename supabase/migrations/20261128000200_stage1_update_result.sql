-- Eden HQ · Stage 1: a posted update returns the saved entry
-- (review round 3, P1-4).
--
-- add_update returned only the new id and time, so the browser read the
-- thread back after every post, page by page up to what was on screen: seven
-- sequential reads for a 300-entry thread. It now returns the saved entry in
-- the shape list_updates gives (id, author_name, body, created_at), and the
-- browser shows it without reading anything.
--
-- Same checks as before: the caller's privileges (SECURITY INVOKER), active
-- membership in the task's workspace (require_access), the task_updates
-- insert policy. The author's name comes from the caller's own membership
-- row, which the workspace_members select policy already shows them. No
-- money field, no new definer function, no grant to a definer role.
-- Forward-only: the earlier definition is replaced, never edited.

drop function eden_api.add_update(uuid, text);

create function eden_api.add_update(p_task_id uuid, p_body text)
returns table (id uuid, author_name text, body text, created_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  r eden.tasks%rowtype;
  v_id uuid;
  v_author uuid;
  v_body text;
  v_at timestamptz;
begin
  select t.* into r from eden.tasks t where t.id = p_task_id;
  perform eden_private.require_access(r.workspace_id, false);
  insert into eden.task_updates (workspace_id, project_id, task_id, body)
    values (r.workspace_id, r.project_id, r.id, btrim(p_body))
    returning task_updates.id, task_updates.author_user_id, task_updates.body, task_updates.created_at
    into v_id, v_author, v_body, v_at;
  return query
    select v_id,
      (select m.display_name from eden.workspace_members m
        where m.workspace_id = r.workspace_id and m.user_id = v_author),
      v_body, v_at;
end
$$;

grant execute on function eden_api.add_update(uuid, text) to authenticated;
