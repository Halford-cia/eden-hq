// The hosted Realtime acceptance check (docs/SPEC.md, Stage 1 acceptance,
// "Realtime"; review round 3, P1-5). Three subscribers (a signed-out client,
// the manager and a same-workspace member) subscribe to Postgres changes on
// every Eden table; Owner A then makes a synthetic change in each workspace;
// the check passes only if the changes were made and no subscriber received
// anything. It reports subscriber names, channel states and counts only:
// never a token, a row, a name or an id.
//
// Pure: the supabase-js clients are passed in, so the logic is tested
// locally (tests/scripts/realtime.test.mjs); scripts/realtime-check.mjs runs
// it against the hosted project.

/** Every Eden table (schema, table), and each Eden schema as a whole. */
export const EDEN_TABLES = [
  ['eden', 'workspaces'],
  ['eden', 'workspace_members'],
  ['eden', 'outside_contacts'],
  ['eden', 'projects'],
  ['eden', 'tasks'],
  ['eden', 'task_updates'],
  ['eden', 'task_budgets'],
  ['eden_private', 'access_gate'],
];
export const EDEN_SCHEMAS = ['eden', 'eden_private', 'eden_api'];

/** The subscriptions each subscriber opens: one channel per table and per schema. */
export function subscriptionsFor() {
  return [
    ...EDEN_TABLES.map(([schema, table]) => ({ label: `${schema}.${table}`, filter: { event: '*', schema, table } })),
    ...EDEN_SCHEMAS.map((schema) => ({ label: `${schema}.*`, filter: { event: '*', schema } })),
  ];
}

const KIND_FOR = { home_building: 'task', stay_eden_ops: 'maintenance' };

async function rpc(client, name, args) {
  const { data, error } = await client.schema('eden_api').rpc(name, args);
  if (error) throw new Error(`${name} was refused (${error.code || 'error'})`);
  return data;
}

/** Subscribe one client to every subscription; resolves with each channel's state. */
function subscribeAll(client, name, onDelivery, { joinMs, setTimer }) {
  return Promise.all(subscriptionsFor().map(({ label, filter }) => new Promise((resolve) => {
    let settled = false;
    const done = (state) => {
      if (settled) return;
      settled = true;
      resolve({ label, state });
    };
    const channel = client.channel(`eden-realtime-check-${name}-${label}`);
    channel.on('postgres_changes', filter, () => onDelivery(label));
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') done('subscribed');
      else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') done('refused');
      else if (status === 'TIMED_OUT') done('timed out');
    });
    setTimer(() => done('no answer'), joinMs);
  })));
}

/**
 * clients: { owner, subscribers: [{ name, client }] }, supabase-js clients.
 * Returns { ok, lines, deliveries, changes }; `lines` is the printable report.
 */
export async function runRealtimeCheck({
  clients, stamp, listenMs = 15000, joinMs = 15000, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimer = (fn, ms) => setTimeout(fn, ms),
}) {
  const lines = [];
  const fail = (why) => {
    lines.push(`FAIL  ${why}`, 'realtime:check FAILED');
    return { ok: false, lines };
  };

  // 1. Owner A's synthetic projects, one per workspace (SETUP.md 9.6).
  let targets;
  try {
    const workspaces = await rpc(clients.owner, 'my_workspaces', {});
    targets = [];
    for (const kind of ['home_building', 'stay_eden_ops']) {
      const ws = workspaces.find((w) => w.kind === kind);
      if (!ws || ws.role !== 'owner') return fail(`the changes token is not an owner of ${kind}`);
      const projects = await rpc(clients.owner, 'list_projects', { p_workspace_id: ws.workspace_id });
      const p = projects.find((x) => typeof x.name === 'string' && x.name.startsWith('SYNTHETIC') && !x.archived);
      if (!p) return fail(`no SYNTHETIC project or property in ${kind} (SETUP.md 9.6)`);
      targets.push({ kind, projectId: p.id });
    }
  } catch (e) {
    return fail(`Owner A could not read the workspaces: ${e.message}`);
  }

  // 2. Every subscriber on every Eden table and schema.
  const deliveries = Object.fromEntries(clients.subscribers.map((s) => [s.name, 0]));
  const channelStates = {};
  await Promise.all(clients.subscribers.map(async (s) => {
    channelStates[s.name] = await subscribeAll(s.client, s.name, () => { deliveries[s.name] += 1; }, { joinMs, setTimer });
  }));

  // 3. One synthetic change set per workspace, then cleaned up (archived).
  const changes = [];
  try {
    for (const t of targets) {
      const [task] = await rpc(clients.owner, 'create_task', {
        p_project_id: t.projectId, p_kind: KIND_FOR[t.kind], p_title: `SYNTHETIC realtime check ${stamp}`,
      });
      await rpc(clients.owner, 'add_update', { p_task_id: task.id, p_body: `SYNTHETIC realtime check ${stamp}` });
      const [moved] = await rpc(clients.owner, 'set_task_status', {
        p_task_id: task.id, p_expected_version: task.version, p_status: 'done',
      });
      await rpc(clients.owner, 'set_task_archived', {
        p_task_id: task.id, p_expected_version: moved.version, p_archived: true,
      });
      changes.push(t.kind);
    }
  } catch (e) {
    for (const s of clients.subscribers) await s.client.removeAllChannels?.();
    return fail(`the synthetic changes were not all made (${changes.length} of ${targets.length} workspaces): ${e.message}`);
  }

  // 4. Listen, then report counts only.
  await wait(listenMs);
  for (const s of clients.subscribers) await s.client.removeAllChannels?.();

  lines.push(`PASS  synthetic changes made in ${changes.join(' and ')} (created, updated, moved to Done, archived)`);
  let ok = true;
  for (const s of clients.subscribers) {
    const states = channelStates[s.name];
    const tally = {};
    for (const c of states) tally[c.state] = (tally[c.state] || 0) + 1;
    const summary = Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ');
    const n = deliveries[s.name];
    if (n) ok = false;
    lines.push(`${n ? 'FAIL' : 'PASS'}  ${s.name}: ${n} change${n === 1 ? '' : 's'} delivered (${states.length} channels: ${summary})`);
  }
  lines.push(ok ? 'realtime:check PASSED' : 'realtime:check FAILED');
  return { ok, lines, deliveries, changes };
}
