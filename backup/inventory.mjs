// Collects the schema and grant inventory the spec requires every migration
// to review (docs/SPEC.md, "Checks that apply to every stage").

const EDEN_SCHEMAS = ['eden', 'eden_private', 'eden_api'];
// Schemas whose objects are checked for exposure to the API roles. `auth` and
// `storage` belong to Supabase and are covered by the storage-policy and
// realtime items instead.
const SCOPED_SCHEMAS = [...EDEN_SCHEMAS, 'public'];
const API_ROLES = ['anon', 'authenticated'];
const DEFINER_ROLES = ['eden_membership_reader', 'eden_receipt_verifier', 'eden_audit_writer'];

const sortRows = (rows) =>
  rows.map((r) => JSON.stringify(r)).sort().map((s) => JSON.parse(s));

export async function collectInventory(db) {
  const q = async (sql, params) => sortRows((await db.query(sql, params)).rows);

  const grantee = `case when a.grantee = 0 then 'PUBLIC' else r.rolname end`;

  const schemaUsage = await q(`
    select n.nspname as schema, ${grantee} as grantee, a.privilege_type as privilege
    from pg_namespace n
    cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = any($1)
      and (a.grantee = 0 or r.rolname = any($2))`, [SCOPED_SCHEMAS, API_ROLES]);

  const relations = await q(`
    select n.nspname as schema, c.relname as name, c.relkind::text as kind,
           ${grantee} as grantee, a.privilege_type as privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = any($1) and c.relkind in ('r', 'v', 'm', 'S', 'f', 'p')
      and (a.grantee = 0 or r.rolname = any($2))`, [SCOPED_SCHEMAS, API_ROLES]);

  const columns = await q(`
    select n.nspname as schema, c.relname as name, att.attname as column,
           ${grantee} as grantee, a.privilege_type as privilege
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(att.attacl) a
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = any($1) and att.attnum > 0 and not att.attisdropped
      and att.attacl is not null
      and (a.grantee = 0 or r.rolname = any($2))`, [SCOPED_SCHEMAS, API_ROLES]);

  const functions = await q(`
    select n.nspname as schema, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
           ${grantee} as grantee, a.privilege_type as privilege
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = any($1)
      and (a.grantee = 0 or r.rolname = any($2))`, [SCOPED_SCHEMAS, API_ROLES]);

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
    schemaUsage, relations, columns, functions, rls, realtime, storagePolicies,
    definers, definerRoleGrants, definerRolePolicies, definerRoleAttributes, extensions,
    apiResults, policies,
  };
}
