// Collects the schema and grant inventory the spec requires every migration
// to review (docs/SPEC.md, "Checks that apply to every stage").

const EDEN_SCHEMAS = ['eden', 'eden_private', 'eden_api'];
const API_ROLES = ['anon', 'authenticated'];
const DEFINER_ROLES = ['eden_membership_reader', 'eden_receipt_verifier', 'eden_audit_writer'];

// Every schema except PostgreSQL's own catalogs (review round 2, P0-3): a
// fixed list of schema names let an app-readable view in a new schema pass.
// Platform schemas (auth, storage, public, …) are inventoried like Eden's;
// their reviewed objects are the baseline in inventory.expected.mjs.
const USER_SCHEMA = `n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_(toast|temp_|toast_temp_)'`;

const sortRows = (rows) =>
  rows.map((r) => JSON.stringify(r)).sort().map((s) => JSON.parse(s));

export async function collectInventory(db) {
  const q = async (sql, params) => sortRows((await db.query(sql, params)).rows);

  // Effective access, as PostgreSQL decides it for each app role: direct
  // grants, grants to PUBLIC and grants inherited through role membership
  // (review round 2, P0-3). A role an app role may SET ROLE to without
  // inheriting is listed in apiRoleMemberships.
  const version = Number((await db.query('show server_version_num')).rows[0].server_version_num);
  const tablePrivs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  if (version >= 170000) tablePrivs.push('MAINTAIN');

  const schemaUsage = await q(`
    select n.nspname as schema, r.role as grantee, pr.p as privilege
    from pg_namespace n
    cross join unnest($1::text[]) as r(role)
    cross join (values ('USAGE'), ('CREATE')) as pr(p)
    where ${USER_SCHEMA}
      and has_schema_privilege(r.role, n.oid, pr.p)`, [API_ROLES]);

  const relations = await q(`
    select n.nspname as schema, c.relname as name, c.relkind::text as kind,
           r.role as grantee, pr.p as privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest($1::text[]) as r(role)
    cross join lateral (
      select p from unnest(case when c.relkind = 'S' then array['USAGE', 'SELECT', 'UPDATE'] else $2::text[] end) as p
    ) as pr
    where ${USER_SCHEMA} and c.relkind in ('r', 'v', 'm', 'S', 'f', 'p')
      and case when c.relkind = 'S' then has_sequence_privilege(r.role, c.oid, pr.p)
               else has_table_privilege(r.role, c.oid, pr.p) end`, [API_ROLES, tablePrivs]);

  // Column-level access that the relation-level rows above do not already cover.
  const columns = await q(`
    select n.nspname as schema, c.relname as name, att.attname as column,
           r.role as grantee, pr.p as privilege
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest($1::text[]) as r(role)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as pr(p)
    where ${USER_SCHEMA} and c.relkind in ('r', 'v', 'm', 'f', 'p')
      and att.attnum > 0 and not att.attisdropped
      and has_column_privilege(r.role, c.oid, att.attnum, pr.p)
      and not has_table_privilege(r.role, c.oid, pr.p)`, [API_ROLES]);

  const functions = await q(`
    select n.nspname as schema, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
           r.role as grantee, 'EXECUTE' as privilege
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join unnest($1::text[]) as r(role)
    where ${USER_SCHEMA}
      and has_function_privilege(r.role, p.oid, 'EXECUTE')`, [API_ROLES]);

  // Roles an app role belongs to, directly or through another role: their
  // privileges are reachable by inheritance or by SET ROLE.
  const apiRoleMemberships = await q(`
    with recursive m(member, roleid, inherit, set) as (
      select r.rolname::text, am.roleid, am.inherit_option, am.set_option
      from pg_auth_members am join pg_roles r on r.oid = am.member
      where r.rolname = any($1)
      union
      select m.member, am.roleid, m.inherit and am.inherit_option, m.set and am.set_option
      from m join pg_auth_members am on am.member = m.roleid
    )
    select m.member, g.rolname as role, bool_or(m.inherit) as inherit, bool_or(m.set) as set
    from m join pg_roles g on g.oid = m.roleid
    group by m.member, g.rolname`, [API_ROLES]);

  const rls = await q(`
    select n.nspname as schema, c.relname as name, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any($1) and c.relkind in ('r', 'p')`, [EDEN_SCHEMAS]);

  const realtime = await q(`
    select schemaname as schema, tablename as name
    from pg_publication_tables where pubname = 'supabase_realtime'`);

  const storagePolicies = await q(`
    select policyname as name, cmd, roles::text as roles
    from pg_policies where schemaname = 'storage'`);

  const definers = await q(`
    select n.nspname as schema, p.proname as name, pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proconfig, ','), '') as config
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = any($1) and p.prosecdef`, [EDEN_SCHEMAS]);

  const definerRoleGrants = await q(`
    with roles as (select oid, rolname from pg_roles where rolname = any($1))
    select 'schema' as object, n.nspname as name, null::text as column, ro.rolname as role, a.privilege_type as privilege
      from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      join roles ro on ro.oid = a.grantee
    union all
    select 'relation', n.nspname || '.' || c.relname, null, ro.rolname, a.privilege_type
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      join roles ro on ro.oid = a.grantee
    union all
    select 'column', n.nspname || '.' || c.relname, att.attname, ro.rolname, a.privilege_type
      from pg_attribute att join pg_class c on c.oid = att.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(att.attacl) a
      join roles ro on ro.oid = a.grantee
      where att.attnum > 0 and att.attacl is not null
    union all
    select 'function', n.nspname || '.' || p.proname, null, ro.rolname, a.privilege_type
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      join roles ro on ro.oid = a.grantee
      where n.nspname not in ('pg_catalog', 'information_schema')
    union all
    select 'owns', n.nspname || '.' || p.proname, null, ro.rolname, 'OWNER'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join roles ro on ro.oid = p.proowner
    union all
    select 'member_of', m.rolname, null, ro.rolname, 'MEMBER'
      from pg_auth_members am join roles ro on ro.oid = am.member
      join pg_roles m on m.oid = am.roleid`, [DEFINER_ROLES]);

  const definerRolePolicies = await q(`
    select schemaname || '.' || tablename as name, policyname as policy, cmd,
           coalesce(qual, '') as using, coalesce(with_check, '') as check
    from pg_policies where roles && $1::name[]`, [DEFINER_ROLES]);

  const definerRoleAttributes = await q(`
    select rolname as role, rolcanlogin as login, rolsuper as super, rolinherit as inherit,
           rolcreaterole as createrole, rolcreatedb as createdb, rolbypassrls as bypassrls
    from pg_roles where rolname = any($1)`, [DEFINER_ROLES]);

  const extensions = await q(`select extname as name from pg_extension where extname = 'pg_graphql'`);

  // Review P0-2: the exact result fields of every published operation, so an
  // added output column (a money field included) is an inventory difference.
  const apiResults = await q(`
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
           pg_get_function_result(p.oid) as returns
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'eden_api'`);

  // Every row policy on the Eden schemas, with its roles and expressions.
  const policies = await q(`
    select schemaname as schema, tablename as name, policyname as policy, cmd,
           roles::text as roles, coalesce(qual, '') as using, coalesce(with_check, '') as check
    from pg_policies where schemaname = any($1)`, [EDEN_SCHEMAS]);

  return {
    schemaUsage, relations, columns, functions, apiRoleMemberships, rls, realtime, storagePolicies,
    definers, definerRoleGrants, definerRolePolicies, definerRoleAttributes, extensions,
    apiResults, policies,
  };
}
