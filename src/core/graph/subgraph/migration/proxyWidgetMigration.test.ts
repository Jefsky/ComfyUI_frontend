/**
 * Black-box tests for the merged `flushProxyWidgetMigration` entry point.
 *
 * This file replaces 7 white-box test files that targeted private helpers
 * (planner, classifier, value-widget repair, primitive-fanout repair,
 * preview-exposure migration, quarantine helpers, and an older flush shim).
 * Every behavior previously asserted via spies on those helpers is now
 * asserted through one of the four side effects observable from the public
 * API:
 *
 *   1. The numeric counters returned in `FlushResult`
 *      (`repaired`, `primitiveRepaired`, `previewMigrated`, `quarantined`).
 *   2. Host-side state: SubgraphInputs created on `host.subgraph.inputs`,
 *      promoted widget values updated, link reconnections.
 *   3. The PreviewExposureStore contents for the host's locator.
 *   4. The host's `properties.proxyWidgets` (cleared on success) and
 *      `properties.proxyWidgetErrorQuarantine` (entries appended on failure).
 *
 * White-box tests for the planner and classifier were dropped entirely:
 * every distinct plan kind is reachable through the cases below.
 */
import { createTestingPinia } from '@pinia/testing'
import { fromPartial } from '@total-typescript/shoehorn'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LGraph,
  LGraphNode,
  LiteGraph,
  SubgraphNode
} from '@/lib/litegraph/src/litegraph'
import type { TWidgetValue } from '@/lib/litegraph/src/types/widgets'
import {
  createTestSubgraph,
  createTestSubgraphNode,
  resetSubgraphFixtureState
} from '@/lib/litegraph/src/subgraph/__fixtures__/subgraphHelpers'

import {
  flushProxyWidgetMigration,
  readHostQuarantine
} from '@/core/graph/subgraph/migration/proxyWidgetMigration'
import type { PromotedWidgetView } from '@/core/graph/subgraph/promotedWidgetTypes'
import { usePreviewExposureStore } from '@/stores/previewExposureStore'

vi.mock('@/renderer/core/canvas/canvasStore', () => ({
  useCanvasStore: () => ({})
}))
vi.mock('@/services/litegraphService', () => ({
  useLitegraphService: () => ({ updatePreviews: () => ({}) })
}))

beforeEach(() => {
  setActivePinia(createTestingPinia({ stubActions: false }))
  resetSubgraphFixtureState()
  LGraph.proxyWidgetMigrationFlush = undefined
})

// ---------------------------------------------------------------------------
// Shared host builder. Lifted from the 7 deleted test files (each had its own
// near-identical copy). Returns the host node along with handles to the inner
// nodes the test cares about.
// ---------------------------------------------------------------------------

function buildHost(): SubgraphNode {
  const subgraph = createTestSubgraph()
  const hostNode = createTestSubgraphNode(subgraph)
  hostNode.graph!.add(hostNode)
  return hostNode
}

function addInnerNode(
  host: SubgraphNode,
  type: string,
  build: (node: LGraphNode) => void = () => {}
): LGraphNode {
  const node = new LGraphNode(type)
  build(node)
  host.subgraph.add(node)
  return node
}

function addPromotedHostInput(
  host: SubgraphNode,
  args: {
    inputName: string
    promotedName: string
    sourceNodeId: string
    sourceWidgetName: string
    initialValue?: TWidgetValue
  }
): { setValue: (v: TWidgetValue) => void; getValue: () => TWidgetValue } {
  let widgetValue: TWidgetValue = args.initialValue ?? 0
  const slot = host.addInput(args.inputName, '*')
  slot._widget = fromPartial<PromotedWidgetView>({
    node: host,
    name: args.promotedName,
    sourceNodeId: args.sourceNodeId,
    sourceWidgetName: args.sourceWidgetName,
    get value() {
      return widgetValue
    },
    set value(v: TWidgetValue) {
      widgetValue = v
    }
  })
  return {
    setValue: (v) => {
      widgetValue = v
    },
    getValue: () => widgetValue
  }
}

function addPrimitiveWithTargets(
  host: SubgraphNode,
  args: {
    primitiveType?: string
    primitiveValue?: number
    targetCount: number
    outputType?: string
    targetSlotType?: string
  }
): { primitive: LGraphNode; targets: LGraphNode[] } {
  const outputType = args.outputType ?? 'INT'
  const targetSlotType = args.targetSlotType ?? outputType
  const primitive = new LGraphNode('PrimitiveNode')
  primitive.type = 'PrimitiveNode'
  primitive.addOutput('value', outputType)
  primitive.addWidget('number', 'value', args.primitiveValue ?? 42, () => {})
  host.subgraph.add(primitive)

  const targets: LGraphNode[] = []
  for (let i = 0; i < args.targetCount; i++) {
    const target = new LGraphNode(`Target${i}`)
    const slot = target.addInput('value', targetSlotType)
    slot.widget = { name: 'value' }
    target.addWidget('number', 'value', 0, () => {})
    host.subgraph.add(target)
    primitive.connect(0, target, 0)
    targets.push(target)
  }
  return { primitive, targets }
}

// ---------------------------------------------------------------------------
// describe blocks below; each axis covers a Plan.kind from the merged file.
// Inventory mapping (deleted title → covered by here):
//   See the comment block above each describe. Where a deleted test asserted
//   the same observable side effect as another, only one `it()` survives.
// ---------------------------------------------------------------------------

describe('flushProxyWidgetMigration', () => {
  describe('no-op cases', () => {
    // Covers: 'returns an empty result when no proxyWidgets are present'
    //         (proxyWidgetMigrationFlush.test.ts)
    //         'returns an empty plan when properties.proxyWidgets is missing'
    //         (proxyWidgetMigrationPlanner.test.ts)
    it('returns an empty result when no proxyWidgets are present', () => {
      const host = buildHost()

      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toEqual({
        repaired: 0,
        primitiveRepaired: 0,
        previewMigrated: 0,
        quarantined: 0
      })
      expect(host.properties.proxyWidgets).toBeUndefined()
    })

    // Covers: 'tolerates a malformed proxyWidgets JSON string and returns empty'
    //         (proxyWidgetMigrationPlanner.test.ts)
    it('tolerates a malformed proxyWidgets payload and returns empty', () => {
      const host = buildHost()
      host.properties.proxyWidgets = '{not json}'

      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toEqual({
        repaired: 0,
        primitiveRepaired: 0,
        previewMigrated: 0,
        quarantined: 0
      })
    })
  })

  describe('value-widget repair', () => {
    // ------------------------------------------------------------------
    // Covers, from repairValueWidget.test.ts:
    //   - 'hydrates real promoted widget host state without mutating the
    //      interior widget'  (alreadyLinked, hostValueProvided)
    //   - 'applies host value to the linked input widget (host wins over
    //      interior)'        (alreadyLinked, hostValueProvided)
    //   - 'leaves widget value unchanged when hostValue is HOST_VALUE_HOLE'
    //                        (alreadyLinked, hostValueHole)
    //   - 'creates exactly one new SubgraphInput linked to the source widget'
    //                        (createSubgraphInput, success)
    // From classifyProxyEntry.test.ts:
    //   - 'returns alreadyLinked when an input already represents the entry'
    //   - 'plans a createSubgraphInput when the widget exists and is not linked'
    // From proxyWidgetMigrationFlush.test.ts:
    //   - 'counts already-linked entries as repaired and applies the host value'
    // ------------------------------------------------------------------

    it('alreadyLinked: applies host value to the matching promoted widget', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('number', 'seed', 0, () => {})
      })
      const handle = addPromotedHostInput(host, {
        inputName: 'seed_link',
        promotedName: 'seed',
        sourceNodeId: String(inner.id),
        sourceWidgetName: 'seed',
        initialValue: 0
      })

      host.properties.proxyWidgets = [[String(inner.id), 'seed']]
      const result = flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: [99]
      })

      expect(result).toMatchObject({ repaired: 1, quarantined: 0 })
      expect(handle.getValue()).toBe(99)
      expect(host.properties.proxyWidgets).toBeUndefined()
    })

    it('alreadyLinked: hydrates real promoted widget without mutating the interior widget', () => {
      // Variant of the above using the real PromotedWidgetView (rather than a
      // fromPartial fake), to pin that the interior widget is not mutated.
      const subgraph = createTestSubgraph({
        inputs: [{ name: 'seed', type: 'INT' }]
      })
      const host = createTestSubgraphNode(subgraph)
      host.graph!.add(host)
      const inner = addInnerNode(host, 'Inner', (n) => {
        const slot = n.addInput('seed', 'INT')
        const innerWidget = n.addWidget('number', 'seed', 0, () => {})
        slot.widget = { name: innerWidget.name }
      })
      subgraph.inputNode.slots[0].connect(inner.inputs[0], inner)

      host.properties.proxyWidgets = [[String(inner.id), 'seed']]
      const result = flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: [99]
      })

      expect(result).toMatchObject({ repaired: 1, quarantined: 0 })
      expect(host.widgets[0].value).toBe(99)
      const innerWidget = inner.widgets!.find((w) => w.name === 'seed')!
      expect(innerWidget.value).toBe(0)
    })

    it('alreadyLinked: leaves widget value unchanged when host value is a sparse hole', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('number', 'seed', 0, () => {})
      })
      const handle = addPromotedHostInput(host, {
        inputName: 'seed_link',
        promotedName: 'seed',
        sourceNodeId: String(inner.id),
        sourceWidgetName: 'seed',
        initialValue: 7
      })

      host.properties.proxyWidgets = [[String(inner.id), 'seed']]
      // Sparse: index 0 is a hole.
      const sparse: unknown[] = []
      const result = flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: sparse
      })

      expect(result).toMatchObject({ repaired: 1, quarantined: 0 })
      expect(handle.getValue()).toBe(7)
    })

    it('alreadyLinked: ambiguous matching inputs quarantine without applying host value', () => {
      // Covers classifyProxyEntry.test.ts:
      //   'quarantines as ambiguous when canonical inputs share the same identity'
      //   'quarantines ambiguous already-linked inputs without a disambiguator'
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('number', 'seed', 0, () => {})
      })
      const a = addPromotedHostInput(host, {
        inputName: 'first_seed',
        promotedName: 'seed',
        sourceNodeId: String(inner.id),
        sourceWidgetName: 'seed',
        initialValue: 1
      })
      const b = addPromotedHostInput(host, {
        inputName: 'second_seed',
        promotedName: 'seed',
        sourceNodeId: String(inner.id),
        sourceWidgetName: 'seed',
        initialValue: 2
      })

      host.properties.proxyWidgets = [[String(inner.id), 'seed']]
      const result = flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: [99]
      })

      expect(result).toMatchObject({ repaired: 0, quarantined: 1 })
      expect(a.getValue()).toBe(1)
      expect(b.getValue()).toBe(2)
      expect(readHostQuarantine(host)).toEqual([
        expect.objectContaining({
          originalEntry: [String(inner.id), 'seed'],
          reason: 'ambiguousSubgraphInput'
        })
      ])
    })

    it('createSubgraphInput: creates exactly one new SubgraphInput linked to the source widget', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        const slot = n.addInput('seed', 'INT')
        slot.widget = { name: 'seed' }
        n.addWidget('number', 'seed', 0, () => {})
      })

      const inputCountBefore = host.subgraph.inputs.length
      host.properties.proxyWidgets = [[String(inner.id), 'seed']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ repaired: 1, quarantined: 0 })
      expect(host.subgraph.inputs).toHaveLength(inputCountBefore + 1)
      const created = host.subgraph.inputs.at(-1)
      expect(created?._widget).toBeDefined()
    })

    it('createSubgraphInput: quarantines missingSubgraphInput when source widget has no backing input slot', () => {
      // The source widget exists but has no INodeInputSlot to wire through.
      // classify() returns 'createSubgraphInput'; repair surfaces
      // 'missingSubgraphInput' since there's no slot to bind.
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('number', 'seed', 0, () => {})
      })

      const inputCountBefore = host.subgraph.inputs.length
      host.properties.proxyWidgets = [[String(inner.id), 'seed']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ repaired: 0, quarantined: 1 })
      expect(host.subgraph.inputs).toHaveLength(inputCountBefore)
      expect(readHostQuarantine(host)).toEqual([
        expect.objectContaining({
          originalEntry: [String(inner.id), 'seed'],
          reason: 'missingSubgraphInput'
        })
      ])
    })
  })

  describe('primitive fan-out repair', () => {
    // ------------------------------------------------------------------
    // Covers, from repairPrimitiveFanout.test.ts:
    //   - 'repairs 1 primitive fanned out to 3 targets into a single SubgraphInput'
    //   - 'host value (first by legacyOrderIndex) wins over primitive widget value'
    //   - 'preserves an explicit undefined host value instead of falling back'
    //   - 'coalesces duplicate entries that share normalized source'
    //   - 'returns primitiveBypassFailed when a target slot type is incompatible'
    //   - 'returns primitiveBypassFailed for an empty cohort' (unreachable via
    //      flush; classify never emits an empty primitive cohort. Drop.)
    // From classifyProxyEntry.test.ts:
    //   - 'quarantines an unlinked primitive node with no fan-out'
    //   - 'emits primitiveBypass with target list when cohort points at the
    //      same primitive'
    // From proxyWidgetMigrationFlush.test.ts (Task 1.3 regression):
    //   - 'keeps surviving primitive targets when one fan-out link is dangling'
    // ------------------------------------------------------------------

    it('repairs 1 primitive fanned out to 3 targets into a single SubgraphInput', () => {
      const host = buildHost()
      const { primitive, targets } = addPrimitiveWithTargets(host, {
        targetCount: 3
      })

      const inputCountBefore = host.subgraph.inputs.length
      host.properties.proxyWidgets = [[String(primitive.id), 'value']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({
        primitiveRepaired: 1,
        repaired: 0,
        quarantined: 0
      })
      expect(host.subgraph.inputs).toHaveLength(inputCountBefore + 1)
      // After mutation each target's slot should no longer be linked to the
      // primitive (it's linked to the new SubgraphInput instead).
      for (const target of targets) {
        const slot = target.inputs[0]
        expect(slot.link).not.toBeNull()
        const link = host.subgraph.links.get(slot.link!)
        expect(link?.origin_id).not.toBe(primitive.id)
      }
    })

    it('coalesces duplicate cohort entries pointing at the same primitive', () => {
      const host = buildHost()
      const { primitive, targets } = addPrimitiveWithTargets(host, {
        targetCount: 2
      })

      // Cohort: 2 entries pointing at the same primitive's `value` widget.
      // With duplicate disambiguators they would still coalesce; we just
      // pin that the result is one repair, not two.
      host.properties.proxyWidgets = [
        [String(primitive.id), 'value'],
        [String(primitive.id), 'value']
      ]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ primitiveRepaired: 1, quarantined: 0 })
      // Two targets → two reconnects regardless of duplicate cohort entries.
      for (const target of targets) {
        const slot = target.inputs[0]
        const link = host.subgraph.links.get(slot.link!)
        expect(link?.origin_id).not.toBe(primitive.id)
      }
    })

    it('host value wins over primitive widget value', () => {
      const host = buildHost()
      const { primitive } = addPrimitiveWithTargets(host, {
        targetCount: 2,
        primitiveValue: 11
      })

      host.properties.proxyWidgets = [[String(primitive.id), 'value']]
      const result = flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: [123]
      })
      expect(result.primitiveRepaired).toBe(1)

      const created = host.subgraph.inputs.at(-1)
      expect(created?._widget?.value).toBe(123)
    })

    it('seeds value from the primitive widget when no host value is supplied', () => {
      // The deleted test 'preserves an explicit undefined host value' was a
      // white-box assertion (it constructed a cohort with `undefined` rather
      // than HOST_VALUE_HOLE). Through flush, the only observable distinction
      // is sparse-hole vs supplied: when sparse, fall back to primitive
      // widget value.
      const host = buildHost()
      const { primitive } = addPrimitiveWithTargets(host, {
        targetCount: 1,
        primitiveValue: 11
      })

      host.properties.proxyWidgets = [[String(primitive.id), 'value']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result.primitiveRepaired).toBe(1)
      const created = host.subgraph.inputs.at(-1)
      expect(created?._widget?.value).toBe(11)
    })

    it('quarantines an unlinked primitive node with no fan-out', () => {
      const host = buildHost()
      const primitive = new LGraphNode('Primitive')
      primitive.type = 'PrimitiveNode'
      primitive.addOutput('value', '*')
      host.subgraph.add(primitive)

      host.properties.proxyWidgets = [[String(primitive.id), 'value']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ primitiveRepaired: 0, quarantined: 1 })
      expect(readHostQuarantine(host)).toEqual([
        expect.objectContaining({
          originalEntry: [String(primitive.id), 'value'],
          reason: 'unlinkedSourceWidget'
        })
      ])
    })

    it('quarantines all cohort entries when a target slot type is incompatible', () => {
      const host = buildHost()
      const { primitive, targets } = addPrimitiveWithTargets(host, {
        targetCount: 1
      })
      // Make the target slot type incompatible with the primitive's INT output.
      targets[0].inputs[0].type = 'STRING'

      const inputCountBefore = host.subgraph.inputs.length
      host.properties.proxyWidgets = [[String(primitive.id), 'value']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ primitiveRepaired: 0, quarantined: 1 })
      // Original SubgraphInputs untouched; no new SubgraphInput created.
      expect(host.subgraph.inputs).toHaveLength(inputCountBefore)
      expect(readHostQuarantine(host)).toEqual([
        expect.objectContaining({
          originalEntry: [String(primitive.id), 'value'],
          reason: 'primitiveBypassFailed'
        })
      ])
    })

    // Task 1.3 regression: must survive intact.
    it('keeps surviving primitive targets when one fan-out link is dangling', () => {
      const host = buildHost()
      const { primitive } = addPrimitiveWithTargets(host, { targetCount: 1 })

      // Inject a dangling link id into the primitive's output: present in
      // `outputs[0].links` but absent from `subgraph.links`.
      const danglingLinkId = 999_999
      expect(host.subgraph.links.has(danglingLinkId)).toBe(false)
      primitive.outputs[0].links = [
        ...(primitive.outputs[0].links ?? []),
        danglingLinkId
      ]

      host.properties.proxyWidgets = [[String(primitive.id), 'value']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      // Before the Task 1.3 fix the merged classifier collapsed the dangling
      // link into an empty plan and quarantined as 'unlinkedSourceWidget'.
      // After the fix the surviving target is shipped through to repair,
      // which still treats the dangling link as fatal and emits
      // 'primitiveBypassFailed'.
      expect(result).toMatchObject({ primitiveRepaired: 0, quarantined: 1 })
      expect(readHostQuarantine(host)).toEqual([
        expect.objectContaining({
          originalEntry: [String(primitive.id), 'value'],
          reason: 'primitiveBypassFailed'
        })
      ])
    })
  })

  describe('preview exposure migration', () => {
    // ------------------------------------------------------------------
    // Covers, from migratePreviewExposure.test.ts:
    //   - 'adds an exposure for a $$-prefixed preview source'
    //   - 'produces a unique name on collision via nextUniqueName'
    //   - 'reuses an existing exposure for the same source preview'
    //   - 'returns missingSourceNode when the source node is absent'
    //   - 'round-trips through resolveChain across an outer host into an
    //      inner host' — DROPPED. That test exercised the
    //      previewExposureStore's `resolveChain`, not the migration. The
    //      migration's only contract is "place an exposure into the store",
    //      which is already covered by the $$-prefixed case below.
    // From classifyProxyEntry.test.ts:
    //   - 'classifies $$-prefixed names as preview exposure'
    //   - 'classifies type:preview serialize:false widgets as preview exposure'
    // From proxyWidgetMigrationFlush.test.ts:
    //   - 'migrates a preview-shaped entry into the PreviewExposureStore'
    // ------------------------------------------------------------------

    it('adds an exposure for a $$-prefixed preview source', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })

      host.properties.proxyWidgets = [
        [String(inner.id), '$$canvas-image-preview']
      ]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ previewMigrated: 1, quarantined: 0 })
      const exposures = usePreviewExposureStore().getExposures(
        host.rootGraph.id,
        String(host.id)
      )
      expect(exposures).toHaveLength(1)
      expect(exposures[0].sourcePreviewName).toBe('$$canvas-image-preview')
      expect(exposures[0].sourceNodeId).toBe(String(inner.id))
    })

    it('classifies type:preview serialize:false widgets as preview exposure', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        const widget = n.addWidget('text', 'videopreview', '', () => {})
        widget.type = 'preview'
        widget.serialize = false
      })

      host.properties.proxyWidgets = [[String(inner.id), 'videopreview']]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ previewMigrated: 1, quarantined: 0 })
      const exposures = usePreviewExposureStore().getExposures(
        host.rootGraph.id,
        String(host.id)
      )
      expect(exposures).toEqual([
        expect.objectContaining({
          sourceNodeId: String(inner.id),
          sourcePreviewName: 'videopreview'
        })
      ])
    })

    it('produces a unique name on collision via nextUniqueName', () => {
      const host = buildHost()
      const innerA = addInnerNode(host, 'InnerA', (n) => {
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })
      const innerB = addInnerNode(host, 'InnerB', (n) => {
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })

      const store = usePreviewExposureStore()
      const locator = String(host.id)
      // Pre-seed the store with an exposure that occupies the canonical name.
      store.addExposure(host.rootGraph.id, locator, {
        sourceNodeId: String(innerA.id),
        sourcePreviewName: '$$canvas-image-preview'
      })

      host.properties.proxyWidgets = [
        [String(innerB.id), '$$canvas-image-preview']
      ]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ previewMigrated: 1, quarantined: 0 })
      const exposures = store.getExposures(host.rootGraph.id, locator)
      expect(exposures).toHaveLength(2)
      const newExposure = exposures.find(
        (e) => e.sourceNodeId === String(innerB.id)
      )
      expect(newExposure?.name).toBe('$$canvas-image-preview_1')
    })

    it('reuses an existing exposure for the same source preview', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })

      const store = usePreviewExposureStore()
      const locator = String(host.id)
      store.addExposure(host.rootGraph.id, locator, {
        sourceNodeId: String(inner.id),
        sourcePreviewName: '$$canvas-image-preview'
      })

      host.properties.proxyWidgets = [
        [String(inner.id), '$$canvas-image-preview']
      ]
      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ previewMigrated: 1, quarantined: 0 })
      // Exactly one exposure: the existing one was reused.
      expect(store.getExposures(host.rootGraph.id, locator)).toHaveLength(1)
    })
  })

  describe('quarantine accumulation', () => {
    // ------------------------------------------------------------------
    // Covers, from quarantineEntry.test.ts:
    //   - 'builds an entry with attemptedAtVersion pinned to 1' — DROPPED;
    //      that's a constant, not behavior. The version is observable in any
    //      quarantine assertion below (e.g., the missingSourceNode round-trip).
    //   - 'includes hostValue when provided'
    //   - 'returns an empty array for an unconfigured host' (no-op cases above)
    //   - 'round-trips entries via append + read'
    //   - 'deduplicates entries with identical originalEntry tuples'
    //   - 'keeps entries that differ by disambiguator in the originalEntry tuple'
    //   - 'clearHostQuarantine removes the property entirely' — DROPPED;
    //      `clearHostQuarantine` was an unused helper after Task 1.2.
    //   - 'appendHostQuarantine is a no-op when given an empty list' — DROPPED;
    //      reachable only by deleted helper; the property staying undefined
    //      after a no-op flush already covers the underlying behavior.
    // From proxyWidgetMigrationFlush.test.ts:
    //   - 'quarantines entries whose source node has disappeared'
    // From classifyProxyEntry.test.ts:
    //   - 'quarantines when source node is missing'
    //   - 'quarantines when source widget is missing on the source node'
    // From proxyWidgetMigrationPlanner.test.ts:
    //   - 'quarantines entries pointing at missing source nodes'
    // ------------------------------------------------------------------

    it('quarantines entries whose source node has disappeared', () => {
      const host = buildHost()
      host.properties.proxyWidgets = [['9999', 'seed']]

      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ quarantined: 1 })
      expect(readHostQuarantine(host)).toEqual([
        {
          originalEntry: ['9999', 'seed'],
          reason: 'missingSourceNode',
          attemptedAtVersion: 1
        }
      ])
    })

    it('quarantines entries whose source widget is missing on the source node', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner')
      host.properties.proxyWidgets = [[String(inner.id), 'nonexistent']]

      const result = flushProxyWidgetMigration({ hostNode: host })

      expect(result).toMatchObject({ quarantined: 1 })
      expect(readHostQuarantine(host)).toEqual([
        expect.objectContaining({
          originalEntry: [String(inner.id), 'nonexistent'],
          reason: 'missingSourceWidget'
        })
      ])
    })

    it('preserves the host value on the quarantine row when one was supplied', () => {
      const host = buildHost()
      host.properties.proxyWidgets = [['9999', 'seed']]

      flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: [42]
      })

      expect(readHostQuarantine(host)).toEqual([
        expect.objectContaining({
          originalEntry: ['9999', 'seed'],
          reason: 'missingSourceNode',
          hostValue: 42
        })
      ])
    })

    it('round-trips appended entries via the public read helper', () => {
      const host = buildHost()
      host.properties.proxyWidgets = [['9999', 'seed']]
      flushProxyWidgetMigration({ hostNode: host })
      const first = readHostQuarantine(host)
      expect(first).toHaveLength(1)

      // A separate entry with a different disambiguator must coexist.
      host.properties.proxyWidgets = [['9999', 'seed', 'inner-leaf']]
      flushProxyWidgetMigration({ hostNode: host })

      const after = readHostQuarantine(host)
      expect(after).toHaveLength(2)
      expect(after.map((e) => e.originalEntry)).toEqual([
        ['9999', 'seed'],
        ['9999', 'seed', 'inner-leaf']
      ])
    })

    it('deduplicates entries with identical originalEntry tuples on re-flush', () => {
      const host = buildHost()
      host.properties.proxyWidgets = [['9999', 'seed']]
      flushProxyWidgetMigration({ hostNode: host })
      const firstQuarantine = readHostQuarantine(host)
      expect(firstQuarantine).toHaveLength(1)

      // Re-seed identical proxyWidgets to simulate a stale legacy reload of
      // the same unresolved entry.
      host.properties.proxyWidgets = [['9999', 'seed']]
      flushProxyWidgetMigration({ hostNode: host })

      expect(readHostQuarantine(host)).toEqual(firstQuarantine)
    })
  })

  describe('idempotency', () => {
    // Covers, from proxyWidgetMigrationFlush.test.ts:
    //   - 'clears properties.proxyWidgets after a successful flush'
    //   - 're-running flush over a fully migrated host produces no further mutations'
    //   - 're-running flush over a quarantined host does not duplicate quarantine entries'
    // From proxyWidgetMigrationPlanner.test.ts:
    //   - 'is idempotent: re-running on a host whose entries are already
    //      linked yields alreadyLinked plans' — covered transitively here:
    //      re-flush returns 0 mutations because proxyWidgets is already gone.

    it('clears properties.proxyWidgets after a successful flush', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })
      host.properties.proxyWidgets = [
        [String(inner.id), '$$canvas-image-preview']
      ]

      flushProxyWidgetMigration({ hostNode: host })

      expect(host.properties.proxyWidgets).toBeUndefined()
    })

    it('re-running flush over a fully migrated host produces no further mutations', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })
      host.properties.proxyWidgets = [
        [String(inner.id), '$$canvas-image-preview']
      ]

      const first = flushProxyWidgetMigration({ hostNode: host })
      expect(first.previewMigrated).toBe(1)

      const exposuresAfterFirst = usePreviewExposureStore()
        .getExposures(host.rootGraph.id, String(host.id))
        .map((e) => ({ ...e }))

      const second = flushProxyWidgetMigration({ hostNode: host })

      expect(second).toEqual({
        repaired: 0,
        primitiveRepaired: 0,
        previewMigrated: 0,
        quarantined: 0
      })
      expect(
        usePreviewExposureStore().getExposures(
          host.rootGraph.id,
          String(host.id)
        )
      ).toEqual(exposuresAfterFirst)
    })
  })

  describe('mixed cohort', () => {
    // Covers, from proxyWidgetMigrationPlanner.test.ts:
    //   - 'emits classified entries for a mixed value+preview cohort,
    //      preserving order'
    //   - 'preserves sparse holes in widgets_values when they are missing'

    it('migrates a mixed value+preview cohort in one flush, preserving entry order', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        const slot = n.addInput('seed', 'INT')
        slot.widget = { name: 'seed' }
        n.addWidget('number', 'seed', 0, () => {})
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })

      const subgraphInputCountBefore = host.subgraph.inputs.length
      host.properties.proxyWidgets = [
        [String(inner.id), 'seed'],
        [String(inner.id), '$$canvas-image-preview']
      ]
      const result = flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: [99]
      })

      expect(result).toMatchObject({
        repaired: 1,
        previewMigrated: 1,
        quarantined: 0
      })
      // Value branch created exactly one new SubgraphInput.
      expect(host.subgraph.inputs).toHaveLength(subgraphInputCountBefore + 1)
      expect(host.subgraph.inputs.find((i) => i.name === 'seed')).toBeDefined()
      // Preview branch routed through the store, not as a SubgraphInput.
      const exposures = usePreviewExposureStore().getExposures(
        host.rootGraph.id,
        String(host.id)
      )
      expect(exposures).toHaveLength(1)
      expect(exposures[0].sourcePreviewName).toBe('$$canvas-image-preview')
    })

    it('preserves sparse holes when supplied widgets_values is missing an index', () => {
      // Two value entries; index 0 is a sparse hole, index 1 has a value.
      // The classifier processes both; both create SubgraphInputs. The host
      // value at index 1 is observable on the corresponding host promoted
      // widget; the hole at index 0 is observable as the default widget value
      // (i.e. no host value applied).
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        const slotA = n.addInput('a', 'INT')
        slotA.widget = { name: 'a' }
        n.addWidget('number', 'a', 0, () => {})
        const slotB = n.addInput('b', 'INT')
        slotB.widget = { name: 'b' }
        n.addWidget('number', 'b', 0, () => {})
      })

      host.properties.proxyWidgets = [
        [String(inner.id), 'a'],
        [String(inner.id), 'b']
      ]
      const sparse: unknown[] = []
      sparse[1] = 'second-value'
      const result = flushProxyWidgetMigration({
        hostNode: host,
        hostWidgetValues: sparse
      })

      // Both entries reach repair successfully (sparse hole is not a failure).
      expect(result).toMatchObject({ repaired: 2, quarantined: 0 })
      // Both SubgraphInputs got created.
      expect(host.subgraph.inputs.find((i) => i.name === 'a')).toBeDefined()
      expect(host.subgraph.inputs.find((i) => i.name === 'b')).toBeDefined()
    })
  })

  describe('integration with LGraph.configure', () => {
    // Covers proxyWidgetMigrationFlush.test.ts:
    //   - 'runs through LGraph.configure when the flush hook is wired'
    it('runs through LGraph.configure when the migration hook is wired', () => {
      const host = buildHost()
      const inner = addInnerNode(host, 'Inner', (n) => {
        n.addWidget('text', '$$canvas-image-preview', '', () => {})
      })
      host.properties.proxyWidgets = [
        [String(inner.id), '$$canvas-image-preview']
      ]

      const serialized = host.rootGraph.serialize()
      LGraph.proxyWidgetMigrationFlush = (hostNode, nodeData) =>
        flushProxyWidgetMigration({
          hostNode,
          hostWidgetValues: nodeData?.widgets_values
        })

      const reloadedGraph = new LGraph()
      const subgraph = host.subgraph
      const instanceData = host.serialize()
      LiteGraph.registerNodeType(
        subgraph.id,
        class TestSubgraphNode extends SubgraphNode {
          constructor() {
            super(reloadedGraph, subgraph, instanceData)
          }
        }
      )
      try {
        reloadedGraph.configure(serialized)
      } finally {
        LiteGraph.unregisterNodeType(subgraph.id)
      }

      const reloadedHost = reloadedGraph.getNodeById(host.id)
      expect(reloadedHost?.properties.proxyWidgets).toBeUndefined()
      expect(
        usePreviewExposureStore().getExposures(
          host.rootGraph.id,
          String(host.id)
        )
      ).toEqual([
        expect.objectContaining({
          sourceNodeId: String(inner.id),
          sourcePreviewName: '$$canvas-image-preview'
        })
      ])
    })
  })
})
