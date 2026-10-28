// tools/claude-agents-import.mjs: Claude Code subagent files → Orgtree team.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { args, build, frontmatter, team, toolList } from '../tools/claude-agents-import.mjs'

// agent files by name; "./<file>" is written at the project root instead
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-agents-import-'))
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    const file = name.startsWith('./') ? path.join(dir, name.slice(2)) : path.join(dir, '.claude', 'agents', name)
    fs.writeFileSync(file, text)
  }
  return dir
}
const agent = (meta, body = 'Body.') => `---\n${meta}\n---\n\n${body}\n`
const names = s => [s.name, ...(s.reports ?? []).flatMap(names)]
const find = (s, name) => s.name === name ? s : (s.reports ?? []).map(r => find(r, name)).find(Boolean)

test('frontmatter: scalars, quotes, folded blocks and lists', () => {
  const { meta, body } = frontmatter('---\r\nname: lead\r\ndescription: >\r\n  Plans the work\r\n  and reports.\r\n'
    + 'model: "opus"\r\nskills:\r\n  - one\r\n  - two\r\n---\r\n\r\nThe charter.\r\n')
  assert.equal(meta.name, 'lead')
  assert.equal(meta.description, 'Plans the work and reports.')
  assert.equal(meta.model, 'opus')
  assert.deepEqual(meta.skills, ['one', 'two'])
  assert.equal(body, 'The charter.')
})

test('tool lists: Agent(...) names the delegates', () => {
  assert.deepEqual(toolList('Agent(a, b), Read, Bash'), { names: ['Agent', 'Read', 'Bash'], delegates: ['a', 'b'] })
  assert.deepEqual(toolList('Read, Grep').delegates, null)
  assert.equal(toolList(undefined), null)
})

test('hierarchy, tools and folders', () => {
  const dir = project({
    'master.md': agent('name: master\ndescription: Orchestrator.\ntools: Agent(lead, helper), Read, Bash, Edit\nmodel: opus'),
    'lead.md': agent('name: lead\ntools: Agent(worker, helper), Read, Bash, Edit, Write\nmodel: opus'),
    'worker.md': agent('name: worker\nmodel: sonnet'),
    'helper.md': agent('name: helper\ntools: Read, Grep, Bash\nmodel: haiku'),
    'reviewer.md': agent('name: reviewer\ndisallowedTools: Edit, Write, Agent\nmodel: inherit'),
    './CLAUDE.md': '# rules\n',
  })
  const o = args(['--project', dir, '--name', 'demo'])
  const { root, notes } = team(o)
  // the helper is named by master and lead: it lands once, under the shallowest
  assert.deepEqual(names(root), ['master', 'helper', 'lead', 'worker', 'reviewer'])
  assert.deepEqual(root.reports.map(r => r.name), ['helper', 'lead', 'reviewer'])
  // the root holds the team's folder; read-only roles hold it read-only
  assert.deepEqual(root.add_dirs, [{ path: dir, mode: 'rw' }])
  assert.deepEqual(find(root, 'helper').add_dirs, [{ path: dir, mode: 'ro' }])
  assert.deepEqual(find(root, 'reviewer').add_dirs, [{ path: dir, mode: 'ro' }])
  assert.equal(find(root, 'worker').add_dirs, undefined)
  // tool switches; subagents are always off (delegation is by mail)
  assert.deepEqual(find(root, 'helper').tools, { bash: true, edit: false, web: false, subagents: false })
  assert.deepEqual(find(root, 'worker').tools, { bash: true, edit: true, web: true, subagents: false })
  assert.deepEqual(find(root, 'reviewer').tools, { bash: true, edit: false, web: true, subagents: false })
  // tiers: a non-catalog model inherits its superior's tier
  assert.equal(find(root, 'helper').tier, 'haiku')
  assert.equal(find(root, 'reviewer').tier, 'opus')
  // a manager learns who it mails: its reports, and roster agents placed elsewhere
  const lead = find(root, 'lead').charter.text
  assert.match(lead, /Your reports: worker\./)
  assert.match(lead, /mail them directly\): helper\./)
  assert.match(notes, /CLAUDE\.md/)
  assert.doesNotMatch(notes, /CLAUDE\.local\.md/)
})

test('--root-name renames the root and says so in the notes', () => {
  const dir = project({ 'master.md': agent('name: master\ntools: Agent(a)'), 'a.md': agent('name: a') })
  const { root, notes } = team(args(['--project', dir, '--root-name', 'demo-master']))
  assert.equal(root.name, 'demo-master')
  assert.match(notes, /"master" means demo-master/)
})

test('a project without a root agent gets one over every agent', () => {
  const dir = project({ 'a.md': agent('name: a\ndescription: Does A.'), 'b.md': agent('name: b') })
  const { root } = team(args(['--project', dir]))
  assert.equal(root.name, 'master')
  assert.equal(root.tier, 'opus')
  assert.deepEqual(root.reports.map(r => r.name), ['a', 'b'])
  assert.match(root.charter.text, /- a: Does A\./)
})

test('the template is version 1 and its agent slots carry no description', () => {
  const dir = project({ 'master.md': agent('name: master\ndescription: Lead.\ntools: Agent(a)'), 'a.md': agent('name: a\ndescription: A.') })
  const t = build(args(['--project', dir, '--id', 'demo', '--name', 'Demo']))
  assert.equal(t.version, 1)
  assert.equal(t.id, 'demo')
  assert.equal(t.quick_chat.superior, 'master')
  const slots = (function all(s) { return [s, ...(s.reports ?? []).flatMap(all)] })(t.agents[0])
  for (const s of slots) assert.equal('description' in s, false, s.name)
  assert.match(t.agents[0].charter.text, /^Role: Lead\./)
})

test('an invalid agent name is refused', () => {
  const dir = project({ 'bad.md': agent('name: no spaces allowed') })
  assert.throws(() => team(args(['--project', dir])), /not a valid Orgtree name/)
})
