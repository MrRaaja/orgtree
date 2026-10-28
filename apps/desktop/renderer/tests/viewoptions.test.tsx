// viewoptions.test.tsx — canvas view options: collapsible teams and
// per-project colour/icon. Pure layers only: the collapse prune, the crowd
// pile's leaf rule with a collapsed card, and the automatic project look.
//
// Run:  node apps/desktop/renderer/tests/run.mjs viewoptions
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasNode } from '../src/canvas/shared'
import { DRAFT } from '../src/canvas/shared'
import { viewPiles } from '../src/canvas/canvaslayout'
import { PROJECT_PALETTE, autoProjectColors, pruneCollapsedView, suggestedIcon } from '../src/canvas/viewoptions'

const node = (id: string, children: CanvasNode[] = [], extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, state: 'live', parent: null, children, ...extra }) as CanvasNode

const org = () => node('user', [
  node('research', [
    node('lead', [
      node('sensors', [node('calibration'), node('streams')]),
      node('worker'),
      node('old', [], { state: 'archived' }),
    ]),
  ], { kind: 'project' }),
  node('solo'),
], { state: 'user' })

const ids = (n: CanvasNode): string[] => [n.id, ...(n.children ?? []).flatMap(ids)]

test('nothing collapsed returns the very same tree', () => {
  const root = org()
  const out = pruneCollapsedView(root, new Set())
  assert.equal(out.root, root)
  assert.equal(out.prunedIds.size, 0)
})

test('a collapsed node keeps its card and hides every descendant', () => {
  const out = pruneCollapsedView(org(), new Set(['lead']))
  assert.deepEqual(ids(out.root), ['user', 'research', 'lead', 'solo'])
  assert.deepEqual([...out.prunedIds].sort(), ['calibration', 'old', 'sensors', 'streams', 'worker'])
  // the count leaves retired agents out: 4 live below the lead
  assert.equal(out.hiddenCount.get('lead'), 4)
})

test('a collapse below a collapse only counts at the outer one', () => {
  const out = pruneCollapsedView(org(), new Set(['research', 'sensors']))
  assert.deepEqual(ids(out.root), ['user', 'research', 'solo'])
  assert.equal(out.hiddenCount.get('research'), 5)
  assert.equal(out.hiddenCount.has('sensors'), false)
})

test('a leaf marked collapsed changes nothing', () => {
  const root = org()
  assert.equal(pruneCollapsedView(root, new Set(['solo'])).root, root)
})

test('the draft hire card stays under a collapsed team', () => {
  const root = node('user', [node('m', [node('a'), node(DRAFT, [], { state: 'draft' })])], { state: 'user' })
  const out = pruneCollapsedView(root, new Set(['m']))
  assert.deepEqual(ids(out.root), ['user', 'm', DRAFT])
  assert.equal(out.hiddenCount.get('m'), 1)
})

test('a collapsed card is never stacked into a crowd pile as a leaf', () => {
  const team = Array.from({ length: 9 }, (_, i) => node('a' + i, i === 0 ? [node('sub')] : []))
  const root = pruneCollapsedView(node('user', [node('boss', team)], { state: 'user' }), new Set(['a0'])).root
  const crowd = viewPiles(root, {}, true, false, new Set(), new Set(['a0'])).get('boss|c')
  assert.ok(crowd)
  assert.equal(crowd.list.includes('a0'), false)
  // without the collapsed set the pruned card would read as a leaf
  assert.equal(viewPiles(root, {}, true, false, new Set()).get('boss|c')!.list.includes('a0'), true)
})

test('automatic colours: distinct per project and stable across calls', () => {
  const projects = ['alpha', 'beta-site', 'Gamma']
  const a = autoProjectColors(projects)
  assert.equal(new Set(a.values()).size, 3)
  assert.deepEqual([...autoProjectColors([...projects].reverse())].sort(), [...a].sort())
  for (const c of a.values()) assert.ok(PROJECT_PALETTE.includes(c))
  // more projects than hues still yields a colour for each
  assert.equal(autoProjectColors(Array.from({ length: 14 }, (_, i) => 'p' + i)).size, 14)
})

test('icons suggested by project name', () => {
  assert.equal(suggestedIcon('vision-pipeline'), 'camera')
  assert.equal(suggestedIcon('robot-arm'), 'robot')
  assert.equal(suggestedIcon('cad-parts'), 'cube')
  assert.equal(suggestedIcon('misc'), undefined)
})
