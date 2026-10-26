#!/usr/bin/env node
// Turns a project's Claude Code subagents (.claude/agents/*.md) into an Orgtree
// organization template (~/.orgtree/templates/<id>.json), so Create
// organization can hire the whole hierarchy in one step.
//
//   node tools/claude-agents-import.mjs --project D:\proj [--id proj] [--name "Proj"]
//        [--root master] [--root-name <name>] [--context CLAUDE.md,WORKSPACE.md] [--grant <folder>]
//        [--notes <file.md>] [--into <org-slug>] [--out <dir>] [--dry-run] [--check]
//
// --grant is the folder the team holds when it is wider than the project, e.g. a
// parent that also holds the repo's git worktrees. --notes appends a Markdown file
// to the team's standing notes. --root-name renames the root in Orgtree (names are
// unique per org, so two imported teams cannot both have a "master").
//
// --into adds the team to an existing org instead of writing a template: it
// creates a project named --name whose Summary carries the notes, then hires the
// whole team under it in one undoable gesture.
//
// Hierarchy: the root (--root, default "master") is the agent the user talks to.
// A manager's reports are the agents named in its `tools: Agent(a, b)` list,
// taken breadth-first so an agent used by several managers lands once, under the
// shallowest one; the rest can still mail it. Agents nothing reaches report to
// the root. Without a root agent file, a root is written from the roster.
//
// --check previews the template against the running desktop engine
// (POST /api/templates/resolve) without creating anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIERS = new Set(['fable', 'opus', 'sonnet', 'haiku']);
const BASH = ['Bash', 'PowerShell'];
const EDIT = ['Edit', 'Write'];
const WEB = ['WebFetch', 'WebSearch'];

function args(argv) {
  const out = { root: 'master', out: path.join(os.homedir(), '.orgtree', 'templates') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--check') { out[a.slice(2).replace('-', '_')] = true; continue; }
    if (!a.startsWith('--') || i + 1 >= argv.length) throw new Error(`bad argument ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  if (!out.project) throw new Error('--project <folder> is required');
  out.project = path.resolve(out.project);
  out.grant = out.grant ? path.resolve(out.grant) : out.project;
  out.id ??= path.basename(out.project).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  out.name ??= path.basename(out.project);
  out.context = (out.context ?? 'CLAUDE.md,CLAUDE.local.md').split(',').map(s => s.trim()).filter(Boolean);
  return out;
}

// Enough YAML for agent frontmatter: scalars, quoted scalars, folded/literal
// blocks (> and |) and "- item" lists.
function frontmatter(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return { meta: {}, body: text.trim() };
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('unterminated frontmatter');
  const meta = {};
  let key = null;
  let block = null;
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m && !line.startsWith(' ')) {
      key = m[1];
      const v = m[2].trim();
      block = v === '>' || v === '>-' || v === '|' || v === '|-' ? v[0] : null;
      meta[key] = block ? '' : v === '' ? [] : v.replace(/^(['"])(.*)\1$/, '$2');
      continue;
    }
    if (!key) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (Array.isArray(meta[key]) && item) meta[key].push(item[1].trim());
    else if (block) meta[key] += (meta[key] && block === '>' ? ' ' : meta[key] ? '\n' : '') + line.trim();
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() };
}

// "Read, Grep, Agent(a, b), Bash" -> { names: [...], delegates: [a, b] | null }
function toolList(v) {
  if (v == null) return null;
  const s = Array.isArray(v) ? v.join(', ') : String(v);
  const names = [];
  let delegates = null;
  for (const m of s.matchAll(/([A-Za-z_][\w:*-]*)(?:\(([^)]*)\))?/g)) {
    names.push(m[1]);
    if (m[1] === 'Agent' || m[1] === 'Task') {
      delegates = (delegates ?? []).concat(m[2] ? m[2].split(',').map(x => x.trim()).filter(Boolean) : []);
    }
  }
  return { names, delegates };
}

function load(project) {
  const dir = path.join(project, '.claude', 'agents');
  const agents = new Map();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    const { meta, body } = frontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = (meta.name || path.basename(f, '.md')).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`${f}: "${name}" is not a valid Orgtree name`);
    const allowed = toolList(meta.tools);
    const denied = toolList(meta.disallowedTools)?.names ?? [];
    const has = list => list.some(t => (allowed ? allowed.names.includes(t) : true) && !denied.includes(t));
    agents.set(name, {
      name, file: path.join('.claude', 'agents', f), body,
      description: String(meta.description ?? '').trim(),
      tier: TIERS.has(meta.model) ? meta.model : null,
      skills: [].concat(meta.skills ?? []).filter(Boolean),
      delegates: allowed?.delegates ?? [],
      tools: { bash: has(BASH), edit: has(EDIT), web: has(WEB), subagents: false },
    });
  }
  return agents;
}

// breadth-first from the root: each agent reports to the shallowest manager that names it
function tree(agents, root) {
  const parent = new Map([[root, null]]);
  const queue = [root];
  while (queue.length) {
    const m = queue.shift();
    for (const d of agents.get(m)?.delegates ?? []) {
      if (!agents.has(d)) { console.warn(`warning: ${m} delegates to unknown agent ${d}`); continue; }
      if (!parent.has(d)) { parent.set(d, m); queue.push(d); }
    }
  }
  for (const n of agents.keys()) if (!parent.has(n)) parent.set(n, root);
  return parent;
}

function charter(a, o, reports, peers) {
  const parts = [];
  if (a.description) parts.push(`Role: ${a.description}`);
  parts.push(`Project folder: ${o.project}. Your shell starts in an Orgtree scratch folder, so `
    + `paths in this charter are relative to the project folder: work there.`);
  if (a.skills.length) parts.push(`Skills this role uses: ${a.skills.join(', ')}. Load them with the Skill tool when they apply.`);
  if (a.body) parts.push(a.body);
  if (reports.length || peers.length) {
    const lines = ['## Delegating in Orgtree',
      'This charter was written for Claude Code, where you delegated with the Agent tool. Here you cannot spawn '
      + 'subagents: delegate by mailing a brief to the agent through Orgtree messaging and wait for its reply. '
      + 'Read "spawn", "Agent tool" or "subagent" in the text above as "mail that agent".'];
    if (reports.length) lines.push(`Your reports: ${reports.join(', ')}.`);
    if (peers.length) lines.push(`Also on your roster but placed elsewhere in the org (mail them directly): ${peers.join(', ')}.`);
    parts.push(lines.join('\n'));
  }
  parts.push(`(Imported from ${a.file}; edit the source file and re-import to change it.)`);
  return parts.join('\n\n');
}

function rootAgent(agents, o) {
  const roster = [...agents.values()].map(a => `- ${a.name}: ${a.description}`).join('\n');
  return {
    name: o.root, file: '(written by the importer: the project had no root agent)', tier: 'opus', skills: [],
    description: `Master for ${o.name}. Plans, delegates to the specialists, verifies their results and reports to the user.`,
    body: 'You are the master agent the user talks to. Break each request into bounded tasks, hand each to the '
      + 'right specialist with exactly the context it needs, check what comes back, and report one consolidated '
      + 'answer. Do specialist work yourself only when no specialist covers it.\n\n'
      + (o.context.length ? `The project's own rules for the master are in ${o.context.join(' and ')}: follow them.\n\n` : '')
      + `Specialists:\n${roster}`,
    delegates: [...agents.keys()],
    tools: { bash: true, edit: true, web: true, subagents: false },
  };
}

// The team as nested template slots (the root first), plus its standing notes.
// Delegates that are not an agent's own reports are its siblings or cousins; Orgtree
// lets siblings mail each other, so no wider visibility is granted.
function team(o) {
  o.context = o.context.filter(f => fs.existsSync(path.join(o.project, f)));
  const agents = load(o.project);
  if (!agents.has(o.root)) agents.set(o.root, rootAgent(agents, o));
  const parent = tree(agents, o.root);
  const kids = n => [...agents.keys()].filter(k => parent.get(k) === n);
  const tierOf = n => agents.get(n).tier ?? (parent.get(n) ? tierOf(parent.get(n)) : 'opus');
  const rootName = o['root-name'] ?? o.root;

  const slot = n => {
    const a = agents.get(n);
    const reports = kids(n);
    const peers = a.delegates.filter(d => agents.has(d) && !reports.includes(d));
    const s = { name: n === o.root ? rootName : n, tier: tierOf(n), charter: { text: charter(a, o, reports, peers) }, spare: 0, tools: a.tools };
    // the root holds the team's folder (an org may hold other teams' folders too); reports
    // inherit it, and read-only roles keep it read-only, not just their edit tools off
    if (n === o.root) s.add_dirs = [{ path: o.grant, mode: 'rw' }];
    if (!a.tools.edit) s.add_dirs = [{ path: o.grant, mode: 'ro' }];
    if (reports.length) s.reports = reports.map(slot);
    return s;
  };

  const notes = [
    `These agents are the Claude Code agents of the project at ${o.project}.`,
    o.context.length ? `Before your first task, read ${o.context.map(f => path.join(o.project, f)).join(' and ')}: `
      + 'they describe the project and its rules, and they stay current there.' : '',
    rootName !== o.root ? `In this team's charters, "${o.root}" means ${rootName}.` : '',
    o.notes ? fs.readFileSync(o.notes, 'utf8').trim() : '',
  ].filter(Boolean).join('\n\n');
  return { root: slot(o.root), notes, size: agents.size };
}

function build(o) {
  const t = team(o);
  return {
    id: o.id,
    name: o.name,
    description: `${t.size} agents imported from ${path.join(o.project, '.claude', 'agents')}.`,
    version: 1,
    org_md: `# ${o.name}\n\n${t.notes}`,
    quick_chat: { superior: t.root.name, tier: 'opus' },
    agents: [t.root],
  };
}

function print(slots, depth = 0) {
  for (const s of slots) {
    const t = s.tools;
    const flags = ['bash', 'edit', 'web'].filter(k => t[k]).join(',') || 'read-only';
    const dirs = s.add_dirs ? ` ${s.add_dirs.map(d => `${d.path} ${d.mode}`).join(', ')}` : '';
    console.log(`${'  '.repeat(depth)}${s.name} [${s.tier}] ${flags}${dirs} - ${s.charter.text.length} chars`);
    if (s.reports) print(s.reports, depth + 1);
  }
}

// the running desktop engine's API, authenticated the way its own UI is
function engine() {
  const data = process.env.ORGTREE_V2_DATA ?? path.join(process.env.APPDATA ?? '', 'Orgtree v2', 'data');
  const { port, token } = JSON.parse(fs.readFileSync(path.join(data, 'engine-attach.json'), 'utf8'));
  return async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'content-type': 'application/json', 'X-Orgtree-Desktop-Token': token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p} refused (${res.status}): ${JSON.stringify(out)}`);
    return out;
  };
}

async function check(t, o) {
  console.log(JSON.stringify(await engine()('POST', '/api/templates/resolve', { id: t.id, name: t.name, dirs: [o.grant] }), null, 2));
}

// Adds the team to an existing org: a project holding the notes, then every hire in
// one gesture (one transaction, one undo entry). Grants are computed as a template's
// are: each manager's grant covers its reports' seats and grants.
async function into(o) {
  const api = engine();
  const { root, notes } = team(o);
  const org = await api('GET', `/api/orgs/${o.into}`);
  if (!org.dirs.some(d => o.grant.toLowerCase().startsWith(d.path.toLowerCase()))) {
    throw new Error(`${o.into} holds no folder containing ${o.grant}: add it in Organization settings first`);
  }
  const nodes = [];
  (function flat(ns) { for (const n of ns) { nodes.push(n); flat(n.children ?? []); } })(org.roots);
  // an empty project of the same name (live or archived) is reused rather than refused
  const project = nodes.find(n => n.tier === 'project' && n.id.toLowerCase() === o.name.toLowerCase()
    && !(n.children ?? []).some(c => c.state === 'live'));
  const taken = new Set(nodes.filter(n => n !== project).map(n => n.id.toLowerCase()));
  const clash = [o.name, ...(function all(s) { return [s.name, ...(s.reports ?? []).flatMap(all)]; })(root)]
    .filter(n => taken.has(n.toLowerCase()));
  if (clash.length) throw new Error(`already in ${o.into}: ${clash.join(', ')} (use --root-name or retire them first)`);

  const grant = s => s.spare + (s.reports ?? []).reduce((sum, r) => sum + org.tiers[r.tier] + grant(r), 0);
  const steps = [];
  (function hire(s, parent) {
    const step = { op: 'hire', name: s.name, tier: s.tier, grant: grant(s), parent, charter: s.charter.text, tools: s.tools };
    if (s.add_dirs) step.add_dirs = s.add_dirs;
    steps.push(step);
    (s.reports ?? []).forEach(r => hire(r, s.name));
  })(root, project?.id ?? o.name);

  if (project) {
    if (project.state !== 'live') await api('POST', `/api/orgs/${o.into}/ops`, { op: 'rehire', node: project.id });
    await api('POST', `/api/orgs/${o.into}/ops`, { op: 'configure_project', node: project.id, settings: { description: notes } });
    console.log(`reused project ${project.id} in ${o.into}${project.state !== 'live' ? ' (restored)' : ''}`);
  } else {
    await api('POST', `/api/orgs/${o.into}/ops`, { op: 'create_project', name: o.name, parent: 'user', description: notes });
    console.log(`created project ${o.name} in ${o.into}`);
  }
  const out = await api('POST', `/api/orgs/${o.into}/gesture`, { steps, label: `Import ${o.name} agents` });
  console.log(`hired ${out.results?.length ?? steps.length} agents under ${project?.id ?? o.name}`);
}

const o = args(process.argv.slice(2));
const t = build(o);
print(t.agents);
if (o.into) {
  if (!o.dry_run) await into(o);
} else if (!o.dry_run) {
  fs.mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, `${t.id}.json`);
  fs.writeFileSync(file, JSON.stringify(t, null, 2) + '\n');
  console.log(`wrote ${file}`);
  if (o.check) await check(t, o);
}
