/**
 * Tests for SubgraphNode.serialize() after ADR 0009.
 *
 * Covers:
 * - Removed copy-back loop: exterior promoted host value does NOT mutate
 *   the corresponding interior widget value.
 * - properties.proxyWidgets is no longer re-emitted on serialize.
 * - properties.previewExposures round-trip through the
 *   PreviewExposureStore.
 * - properties.proxyWidgetErrorQuarantine round-trips and is inert at
 *   runtime; an empty quarantine is omitted from the serialized payload.
 */
import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ISlotType, TWidgetType } from '@/lib/litegraph/src/litegraph'
import { BaseWidget, LGraphNode } from '@/lib/litegraph/src/litegraph'

import {
  appendHostQuarantine,
  makeQuarantineEntry
} from '@/core/graph/subgraph/migration/proxyWidgetMigration'
import type { PromotedWidgetView } from '@/core/graph/subgraph/promotedWidgetTypes'
import {
  reorderSubgraphInputAtIndex,
  reorderSubgraphInputsByName
} from '@/core/graph/subgraph/promotionUtils'
import type { SerializedProxyWidgetTuple } from '@/core/schemas/promotionSchema'
import { IS_CONTROL_WIDGET } from '@/scripts/controlWidgetMarker'
import { usePreviewExposureStore } from '@/stores/previewExposureStore'
import { useWidgetValueStore } from '@/stores/widgetValueStore'
import { extractVueNodeData } from '@/composables/graph/useGraphNodeManager'
import { computeProcessedWidgets } from '@/renderer/extensions/vueNodes/composables/useProcessedWidgets'
import { graphToPrompt } from '@/utils/executionUtil'

import {
  createTestSubgraph,
  createTestSubgraphNode,
  resetSubgraphFixtureState
} from './__fixtures__/subgraphHelpers'

vi.mock('@/renderer/core/canvas/canvasStore', () => ({
  useCanvasStore: () => ({})
}))
vi.mock('@/services/litegraphService', () => ({
  useLitegraphService: () => ({ updatePreviews: () => ({}) })
}))

beforeEach(() => {
  setActivePinia(createTestingPinia({ stubActions: false }))
  resetSubgraphFixtureState()
})

function createNodeWithWidget(
  title: string,
  widgetType: TWidgetType = 'number',
  widgetValue: unknown = 42,
  slotType: ISlotType = 'number'
) {
  const node = new LGraphNode(title)
  const input = node.addInput('value', slotType)
  node.addOutput('out', slotType)

  // @ts-expect-error Abstract class instantiation
  const widget = new BaseWidget({
    name: 'widget',
    type: widgetType,
    value: widgetValue,
    y: 0,
    options: widgetType === 'number' ? { min: 0, max: 100, step: 1 } : {},
    node
  })
  node.widgets = [widget]
  input.widget = { name: widget.name }

  return { node, widget, input }
}

function expectPromotedWidgetView(
  widget: unknown
): asserts widget is PromotedWidgetView {
  expect(widget).toMatchObject({
    sourceNodeId: expect.any(String),
    sourceWidgetName: expect.any(String)
  })
}

function getHostStateName(widget: PromotedWidgetView): string {
  return [widget.name, widget.sourceNodeId, widget.sourceWidgetName].join(':')
}

describe('SubgraphNode.serialize (ADR 0009)', () => {
  describe('removed copy-back loop', () => {
    it('does not mutate interior widget values during serialize', () => {
      const subgraph = createTestSubgraph({
        inputs: [{ name: 'value', type: 'number' }]
      })

      const { node: interiorNode, widget: interiorWidget } =
        createNodeWithWidget('Interior')
      subgraph.add(interiorNode)
      subgraph.inputNode.slots[0].connect(interiorNode.inputs[0], interiorNode)

      const hostNode = createTestSubgraphNode(subgraph)
      const hostWidget = hostNode.widgets[0]
      expectPromotedWidgetView(hostWidget)
      useWidgetValueStore().registerWidget(hostNode.rootGraph.id, {
        nodeId: hostNode.id,
        name: getHostStateName(hostWidget),
        type: hostWidget.type,
        value: 99,
        options: {}
      })

      hostNode.serialize()

      expect(interiorWidget.value).toBe(42)
    })

    it('does not mutate live properties while projecting store-owned serialization metadata', () => {
      const subgraph = createTestSubgraph()
      const hostNode = createTestSubgraphNode(subgraph)
      hostNode.properties.previewExposures = [
        {
          name: 'stale',
          sourceNodeId: '0',
          sourcePreviewName: '$$canvas-image-preview'
        }
      ]
      hostNode.properties.proxyWidgetErrorQuarantine = []
      const livePropertiesBefore = structuredClone(hostNode.properties)

      usePreviewExposureStore().addExposure(
        hostNode.rootGraph.id,
        String(hostNode.id),
        {
          sourceNodeId: '12',
          sourcePreviewName: '$$canvas-image-preview'
        }
      )

      const serialized = hostNode.serialize()

      expect(hostNode.properties).toEqual(livePropertiesBefore)
      expect(serialized.properties?.previewExposures).toEqual([
        {
          name: '$$canvas-image-preview',
          sourceNodeId: '12',
          sourcePreviewName: '$$canvas-image-preview'
        }
      ])
      expect(serialized.properties?.proxyWidgetErrorQuarantine).toBeUndefined()
    })
  })

  describe('host widget values', () => {
    type SourceSpec = {
      inputName: string
      title: string
      widgetType: TWidgetType
      slotType: ISlotType
      initialValue: unknown
      withComfyClass?: boolean
      hugeMaxSeed?: boolean
    }
    type EditValue = string | number | boolean
    type EditSpec = { via: 'viewKey' | 'vue'; index: number; value: EditValue }
    type ReorderSpec =
      | { kind: 'none' }
      | { kind: 'byName'; order: string[] }
      | { kind: 'atIndex'; from: number; to: number }

    const TEXT_PAIR: SourceSpec[] = [
      {
        inputName: 'first',
        title: 'First',
        widgetType: 'text',
        slotType: 'STRING',
        initialValue: '',
        withComfyClass: true
      },
      {
        inputName: 'second',
        title: 'Second',
        widgetType: 'text',
        slotType: 'STRING',
        initialValue: '',
        withComfyClass: true
      }
    ]
    const NUMBER_PAIR: SourceSpec[] = [
      {
        inputName: 'first',
        title: 'First',
        widgetType: 'number',
        slotType: 'number',
        initialValue: 1
      },
      {
        inputName: 'second',
        title: 'Second',
        widgetType: 'number',
        slotType: 'number',
        initialValue: 2
      }
    ]
    const TEXT_TEXT_SEED: SourceSpec[] = [
      {
        inputName: 'text_1',
        title: 'Positive',
        widgetType: 'text',
        slotType: 'STRING',
        initialValue: '',
        withComfyClass: true
      },
      {
        inputName: 'text',
        title: 'Negative',
        widgetType: 'text',
        slotType: 'STRING',
        initialValue: '',
        withComfyClass: true
      },
      {
        inputName: 'seed',
        title: 'Sampler',
        widgetType: 'number',
        slotType: 'INT',
        initialValue: 0,
        withComfyClass: true
      }
    ]

    function buildSources(
      subgraph: ReturnType<typeof createTestSubgraph>,
      specs: SourceSpec[]
    ) {
      const built = specs.map((s) => {
        const created = createNodeWithWidget(
          s.title,
          s.widgetType,
          s.initialValue,
          s.slotType
        )
        if (s.withComfyClass) created.node.comfyClass = s.title
        if (s.hugeMaxSeed) created.widget.options.max = 1125899906842624
        subgraph.add(created.node)
        return created
      })
      for (const [i, s] of specs.entries()) {
        subgraph
          .addInput(s.inputName, String(s.slotType))
          .connect(built[i].input, built[i].node)
      }
      return built
    }

    function vueEdit(
      host: ReturnType<typeof createTestSubgraphNode>,
      index: number,
      value: EditValue
    ) {
      const widgets = computeProcessedWidgets({
        nodeData: extractVueNodeData(host),
        graphId: host.rootGraph.id,
        showAdvanced: false,
        isGraphReady: false,
        rootGraph: null,
        ui: { getTooltipConfig: () => ({}), handleNodeRightClick: () => {} }
      })
      widgets[index].updateHandler(value)
    }

    function applyEdit(
      host: ReturnType<typeof createTestSubgraphNode>,
      edit: EditSpec
    ) {
      if (edit.via === 'viewKey') host.widgets[edit.index].value = edit.value
      else vueEdit(host, edit.index, edit.value)
    }

    function applyReorder(
      host: ReturnType<typeof createTestSubgraphNode>,
      r: ReorderSpec
    ) {
      if (r.kind === 'byName') reorderSubgraphInputsByName(host, r.order)
      else if (r.kind === 'atIndex')
        reorderSubgraphInputAtIndex(host, r.from, r.to)
    }

    function makeControlWidget(value: 'increment' | 'fixed', marker: boolean) {
      const base = {
        name: 'control_after_generate',
        value,
        serialize: false,
        beforeQueued: () => {},
        afterQueued: () => {}
      }
      return marker ? { ...base, [IS_CONTROL_WIDGET]: true } : base
    }

    type ReorderCase = {
      name: string
      sources: SourceSpec[]
      edits: EditSpec[]
      reorder: ReorderSpec
      expectedNames?: string[]
      expectedWidgetsValues?: unknown[]
      promptByIndex?: Record<number, unknown>
    }

    const reorderCases: ReorderCase[] = [
      {
        name: 'plain numbers via ViewKey, swap by name',
        sources: NUMBER_PAIR,
        edits: [
          { via: 'viewKey', index: 0, value: 111 },
          { via: 'viewKey', index: 1, value: 222 }
        ],
        reorder: { kind: 'byName', order: ['second', 'first'] },
        expectedNames: ['second', 'first'],
        expectedWidgetsValues: [222, 111]
      },
      {
        name: 'plain text via Vue, swap by name (widgets_values + prompt)',
        sources: TEXT_PAIR,
        edits: [
          { via: 'vue', index: 0, value: 'first value' },
          { via: 'vue', index: 1, value: 'second value' }
        ],
        reorder: { kind: 'byName', order: ['second', 'first'] },
        expectedWidgetsValues: ['second value', 'first value'],
        promptByIndex: { 0: 'first value', 1: 'second value' }
      },
      {
        name: 'mixed text/text/seed via ViewKey, atIndex seed up',
        sources: TEXT_TEXT_SEED,
        edits: [
          { via: 'viewKey', index: 0, value: 'positive prompt' },
          { via: 'viewKey', index: 1, value: 'negative prompt' },
          { via: 'viewKey', index: 2, value: 123456 }
        ],
        reorder: { kind: 'atIndex', from: 2, to: 1 },
        expectedWidgetsValues: ['positive prompt', 123456, 'negative prompt'],
        promptByIndex: { 0: 'positive prompt', 1: 'negative prompt', 2: 123456 }
      },
      {
        name: 'mixed text/text/seed via Vue, atIndex seed up',
        sources: TEXT_TEXT_SEED,
        edits: [
          { via: 'vue', index: 0, value: 'positive prompt' },
          { via: 'vue', index: 1, value: 'negative prompt' },
          { via: 'vue', index: 2, value: 123456 }
        ],
        reorder: { kind: 'atIndex', from: 2, to: 1 },
        expectedWidgetsValues: ['positive prompt', 123456, 'negative prompt'],
        promptByIndex: { 0: 'positive prompt', 1: 'negative prompt', 2: 123456 }
      }
    ]

    it.each(reorderCases)('$name', async (c) => {
      const subgraph = createTestSubgraph()
      const sources = buildSources(subgraph, c.sources)
      const host = createTestSubgraphNode(subgraph)
      if (c.promptByIndex) {
        host.comfyClass = 'Subgraph'
        host.graph?.add(host)
      }
      for (const edit of c.edits) applyEdit(host, edit)
      applyReorder(host, c.reorder)

      if (c.expectedNames) {
        expect(host.widgets.map((w) => w.name)).toEqual(c.expectedNames)
      }
      if (c.expectedWidgetsValues !== undefined) {
        expect(host.serialize().widgets_values).toEqual(c.expectedWidgetsValues)
      }
      if (c.promptByIndex) {
        const { output } = await graphToPrompt(host.rootGraph)
        for (const [iStr, value] of Object.entries(c.promptByIndex)) {
          const i = Number(iStr)
          expect(output[`${host.id}:${sources[i].node.id}`].inputs.value).toBe(
            value
          )
        }
      }
    })

    type ControlCase = {
      name: string
      editVia: 'viewKey' | 'vue'
      controlMode: 'increment' | 'fixed'
      controlMarker: boolean
      seedHostValue: number
      mutateSourceSeedAfterReorder?: number
      callAfterQueued?: boolean
      expect: {
        promptSeed?: number
        sourceSeed?: number
        processedSeedValue?: number
        hostSeedValue?: number
        storeSeedValue?: number
      }
    }

    const controlCases: ControlCase[] = [
      {
        name: 'ViewKey + increment: source seed mutation after reorder is ignored in prompt',
        editVia: 'viewKey',
        controlMode: 'increment',
        controlMarker: false,
        seedHostValue: 123456,
        mutateSourceSeedAfterReorder: 789,
        expect: { promptSeed: 123456 }
      },
      {
        name: 'Vue + fixed: pushes Vue value to source seed',
        editVia: 'vue',
        controlMode: 'fixed',
        controlMarker: false,
        seedHostValue: 123456,
        expect: { sourceSeed: 123456 }
      },
      {
        name: 'Vue + increment + afterQueued: processed widgets reflect increment',
        editVia: 'vue',
        controlMode: 'increment',
        controlMarker: true,
        seedHostValue: 123456,
        callAfterQueued: true,
        expect: { processedSeedValue: 123457 }
      },
      {
        name: 'ViewKey + increment + afterQueued: host seed increments without source value',
        editVia: 'viewKey',
        controlMode: 'increment',
        controlMarker: true,
        seedHostValue: 2,
        mutateSourceSeedAfterReorder: 8,
        callAfterQueued: true,
        expect: { hostSeedValue: 3, storeSeedValue: 3 }
      }
    ]

    it.each(controlCases)('$name', async (c) => {
      const subgraph = createTestSubgraph()
      const sources = buildSources(
        subgraph,
        TEXT_TEXT_SEED.map((s) =>
          s.title === 'Sampler' ? { ...s, hugeMaxSeed: true } : s
        )
      )
      const [, , seed] = sources
      const host = createTestSubgraphNode(subgraph)
      if (c.expect.promptSeed !== undefined) {
        host.comfyClass = 'Subgraph'
        host.graph?.add(host)
      }

      if (c.editVia === 'viewKey') {
        host.widgets[0].value = 'positive prompt'
        host.widgets[1].value = 'negative prompt'
        host.widgets[2].value = c.seedHostValue
        seed.widget.linkedWidgets = [
          makeControlWidget(c.controlMode, c.controlMarker) as never
        ]
      } else {
        seed.widget.linkedWidgets = [
          makeControlWidget(c.controlMode, c.controlMarker) as never
        ]
        vueEdit(host, 2, c.seedHostValue)
      }

      reorderSubgraphInputAtIndex(host, 2, 1)

      if (c.mutateSourceSeedAfterReorder !== undefined) {
        seed.widget.value = c.mutateSourceSeedAfterReorder
      }
      if (c.callAfterQueued) host.widgets[1].afterQueued?.()

      if (c.expect.promptSeed !== undefined) {
        const { output } = await graphToPrompt(host.rootGraph)
        expect(output[`${host.id}:${seed.node.id}`].inputs.value).toBe(
          c.expect.promptSeed
        )
      }
      if (c.expect.sourceSeed !== undefined) {
        expect(seed.widget.value).toBe(c.expect.sourceSeed)
      }
      if (c.expect.processedSeedValue !== undefined) {
        const updated = computeProcessedWidgets({
          nodeData: extractVueNodeData(host),
          graphId: host.rootGraph.id,
          showAdvanced: false,
          isGraphReady: false,
          rootGraph: null,
          ui: { getTooltipConfig: () => ({}), handleNodeRightClick: () => {} }
        })
        expect(updated[1].value).toBe(c.expect.processedSeedValue)
      }
      if (c.expect.hostSeedValue !== undefined) {
        expect(host.widgets[1].value).toBe(c.expect.hostSeedValue)
      }
      if (c.expect.storeSeedValue !== undefined) {
        expect(
          useWidgetValueStore()
            .getNodeWidgets(host.rootGraph.id, host.id)
            .find((entry) => entry.name.startsWith('seed:'))?.value
        ).toBe(c.expect.storeSeedValue)
      }
    })

    it('serializes promoted values from each host independently', () => {
      const subgraph = createTestSubgraph({
        inputs: [{ name: 'value', type: 'number' }]
      })

      const { node: interiorNode } = createNodeWithWidget('Interior')
      subgraph.add(interiorNode)
      subgraph.inputNode.slots[0].connect(interiorNode.inputs[0], interiorNode)

      const firstHost = createTestSubgraphNode(subgraph, { id: 101 })
      const secondHost = createTestSubgraphNode(subgraph, { id: 102 })
      subgraph.rootGraph.add(firstHost)
      subgraph.rootGraph.add(secondHost)

      firstHost.widgets[0].value = 111
      secondHost.widgets[0].value = 222

      expect(firstHost.serialize().widgets_values).toEqual([111])
      expect(secondHost.serialize().widgets_values).toEqual([222])
    })

    it('does not persist source widget store fallback values after reordering', () => {
      const subgraph = createTestSubgraph()
      const sources = buildSources(subgraph, TEXT_PAIR)
      const host = createTestSubgraphNode(subgraph)
      const widgetStore = useWidgetValueStore()
      for (const { node, widget } of sources) {
        widgetStore.registerWidget(host.rootGraph.id, {
          nodeId: node.id,
          name: widget.name,
          type: widget.type,
          value: `${node.title} value`,
          options: {}
        })
      }
      reorderSubgraphInputsByName(host, ['second', 'first'])
      expect(host.serialize().widgets_values).toBeUndefined()
    })

    it('does not acquire a host overlay when a source fallback is saved and reloaded', () => {
      const subgraph = createTestSubgraph({
        inputs: [{ name: 'value', type: 'STRING' }]
      })
      const { node: interiorNode, widget: interiorWidget } =
        createNodeWithWidget('Interior', 'text', '', 'STRING')
      subgraph.add(interiorNode)
      subgraph.inputNode.slots[0].connect(interiorNode.inputs[0], interiorNode)

      const host = createTestSubgraphNode(subgraph, { id: 101 })
      const widgetStore = useWidgetValueStore()
      widgetStore.registerWidget(host.rootGraph.id, {
        nodeId: interiorNode.id,
        name: interiorWidget.name,
        type: interiorWidget.type,
        value: 'source fallback',
        options: {}
      })
      const serialized = host.serialize()
      expect(serialized.widgets_values).toBeUndefined()

      widgetStore.clearGraph(host.rootGraph.id)
      const reloaded = createTestSubgraphNode(subgraph, { id: 101 })
      reloaded.configure(serialized)

      expect(
        widgetStore.getNodeWidgets(reloaded.rootGraph.id, reloaded.id)
      ).toEqual([])
      expect(reloaded.serialize().widgets_values).toBeUndefined()
    })

    it('does not hydrate missing widgets_values entries as explicit host overlays', () => {
      const subgraph = createTestSubgraph()
      buildSources(subgraph, TEXT_PAIR)

      const host = createTestSubgraphNode(subgraph, { id: 101 })
      host.widgets[1].value = 'second host value'
      const serialized = host.serialize()
      expect(serialized.widgets_values).toEqual([
        undefined,
        'second host value'
      ])

      const widgetStore = useWidgetValueStore()
      widgetStore.clearGraph(host.rootGraph.id)
      const reloaded = createTestSubgraphNode(subgraph, { id: 101 })
      reloaded.configure(serialized)

      const [first, second] = reloaded.widgets
      expectPromotedWidgetView(first)
      expectPromotedWidgetView(second)
      expect(
        widgetStore.getWidget(
          reloaded.rootGraph.id,
          reloaded.id,
          getHostStateName(first)
        )
      ).toBeUndefined()
      expect(
        widgetStore.getWidget(
          reloaded.rootGraph.id,
          reloaded.id,
          getHostStateName(second)
        )?.value
      ).toBe('second host value')
      expect(
        widgetStore.getNodeWidgets(reloaded.rootGraph.id, reloaded.id)
      ).toHaveLength(1)
      expect(reloaded.serialize().widgets_values).toEqual([
        undefined,
        'second host value'
      ])
    })
  })

  describe('proxyWidgets is no longer re-emitted', () => {
    it('does not write properties.proxyWidgets after serialize', () => {
      const subgraph = createTestSubgraph({
        inputs: [{ name: 'value', type: 'number' }]
      })

      const { node: interiorNode } = createNodeWithWidget('Interior')
      subgraph.add(interiorNode)
      subgraph.inputNode.slots[0].connect(interiorNode.inputs[0], interiorNode)

      const hostNode = createTestSubgraphNode(subgraph)
      // Ensure no pre-existing proxyWidgets property leaks through.
      delete hostNode.properties.proxyWidgets

      const serialized = hostNode.serialize()

      expect(serialized.properties?.proxyWidgets).toBeUndefined()
      expect(hostNode.properties.proxyWidgets).toBeUndefined()
    })

    it('preserves a pre-existing legacy proxyWidgets property without re-deriving it', () => {
      const subgraph = createTestSubgraph()
      const hostNode = createTestSubgraphNode(subgraph)

      const legacy: SerializedProxyWidgetTuple[] = [['7', 'seed']]
      hostNode.properties.proxyWidgets = legacy

      const serialized = hostNode.serialize()

      // Still serialized as-is — not deleted, not rewritten.
      expect(serialized.properties?.proxyWidgets).toStrictEqual(legacy)
    })
  })

  describe('previewExposures round-trip', () => {
    const CANVAS = '$$canvas-image-preview'
    const exposure12 = { sourceNodeId: '12', sourcePreviewName: CANVAS }
    const exposure14 = { sourceNodeId: '14', sourcePreviewName: 'videopreview' }
    const named12 = { name: CANVAS, ...exposure12 }
    const named14 = { name: 'videopreview', ...exposure14 }

    it('hydrates previewExposures into the store during configure', () => {
      const hostNode = createTestSubgraphNode(createTestSubgraph())
      hostNode.properties.previewExposures = [
        { name: 'preview', ...exposure12 }
      ]
      hostNode._internalConfigureAfterSlots()

      expect(
        usePreviewExposureStore().getExposures(
          hostNode.rootGraph.id,
          String(hostNode.id)
        )
      ).toEqual([{ name: 'preview', ...exposure12 }])
    })

    type SerializeCase = {
      name: string
      addExposures: (typeof exposure12)[]
      staleProperty?: {
        name: string
        sourceNodeId: string
        sourcePreviewName: string
      }[]
      expected: (typeof named12)[] | undefined
      expectLiveUnchanged?: boolean
    }

    const serializeCases: SerializeCase[] = [
      {
        name: 'writes previewExposures from the store on serialize',
        addExposures: [exposure12, exposure14],
        expected: [named12, named14]
      },
      {
        name: 'omits previewExposures when the store has no entries for the host',
        addExposures: [],
        staleProperty: [
          { name: 'stale', sourceNodeId: '0', sourcePreviewName: CANVAS }
        ],
        expected: undefined,
        expectLiveUnchanged: true
      }
    ]

    it.each(serializeCases)('$name', (c) => {
      const hostNode = createTestSubgraphNode(createTestSubgraph())
      if (c.staleProperty)
        hostNode.properties.previewExposures = c.staleProperty
      const store = usePreviewExposureStore()
      for (const e of c.addExposures) {
        store.addExposure(hostNode.rootGraph.id, String(hostNode.id), e)
      }

      const serialized = hostNode.serialize()
      expect(serialized.properties?.previewExposures).toEqual(c.expected)
      if (c.expectLiveUnchanged) {
        expect(hostNode.properties.previewExposures).toEqual(c.staleProperty)
      }
    })

    it('serializes preview exposures per host instance', () => {
      const subgraph = createTestSubgraph()
      const firstHost = createTestSubgraphNode(subgraph, { id: 101 })
      const secondHost = createTestSubgraphNode(subgraph, { id: 102 })
      subgraph.rootGraph.add(firstHost)
      subgraph.rootGraph.add(secondHost)

      const store = usePreviewExposureStore()
      store.addExposure(
        firstHost.rootGraph.id,
        String(firstHost.id),
        exposure12
      )
      store.addExposure(
        firstHost.rootGraph.id,
        String(secondHost.id),
        exposure14
      )

      const firstExposures = firstHost.serialize().properties?.previewExposures
      const secondExposures =
        secondHost.serialize().properties?.previewExposures
      if (!Array.isArray(firstExposures) || !Array.isArray(secondExposures)) {
        throw new Error('Expected serialized previewExposures arrays')
      }

      expect(firstExposures).toEqual([named12])
      expect(secondExposures).toEqual([named14])
      for (const exposed of [firstExposures[0], secondExposures[0]]) {
        expect(exposed).not.toHaveProperty('hostInstanceId')
        expect(exposed).not.toHaveProperty('hostNodeLocator')
        expect(exposed).not.toHaveProperty('rootGraphId')
      }
    })
  })

  describe('proxyWidgetErrorQuarantine', () => {
    it('preserves quarantine entries through serialize and is inert at runtime', () => {
      const subgraph = createTestSubgraph()
      const hostNode = createTestSubgraphNode(subgraph)

      appendHostQuarantine(hostNode, [
        makeQuarantineEntry({
          originalEntry: ['7', 'seed'],
          reason: 'missingSourceNode',
          hostValue: 42
        })
      ])

      const serialized = hostNode.serialize()
      const quarantine = serialized.properties?.proxyWidgetErrorQuarantine
      expect(Array.isArray(quarantine)).toBe(true)
      expect(quarantine).toHaveLength(1)

      // Inertness: quarantine entries do not produce widgets.
      expect(
        hostNode.widgets.some(
          (w) => 'sourceNodeId' in w && w.sourceNodeId === '7'
        )
      ).toBe(false)
    })

    it('removes the property entirely when quarantine is empty', () => {
      const subgraph = createTestSubgraph()
      const hostNode = createTestSubgraphNode(subgraph)
      hostNode.properties.proxyWidgetErrorQuarantine = []

      const serialized = hostNode.serialize()

      expect(serialized.properties?.proxyWidgetErrorQuarantine).toBeUndefined()
      expect(hostNode.properties.proxyWidgetErrorQuarantine).toEqual([])
    })
  })
})
