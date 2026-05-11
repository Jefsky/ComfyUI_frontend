/**
 * Extension lifecycle — `defineExtension`, `defineNodeExtension`, and
 * the implicit-context lifecycle hooks (`onNodeMounted`, `onNodeRemoved`).
 *
 * Design decisions (D10):
 * - D10a: `currentExtension` global, Vue-style. Hook factories read the slot
 *   implicitly. Lifecycle hooks must be called synchronously inside `setup()`.
 * - D10b: Hook firing order = registration order with lexicographic tie-break
 *   on extension name.
 * - D10c: `setup()` is synchronous. `async setup` throws in dev, emits
 *   console.error in prod.
 * - D10d: The object returned by `setup()` is wrapped with `proxyRefs()` so
 *   callers read `entity.extensionState['my-ext'].count` without `.value`.
 *
 * Entry-point design (D6 Part 1): module-level import only. Extensions do NOT
 * depend on `window.app` being initialized at registration time.
 *
 * @stability stable
 * @packageDocumentation
 */

import type { NodeHandle } from './node'
import type { WidgetHandle } from './widget'

// ─── Extension options ───────────────────────────────────────────────────────

/**
 * Options for `defineNodeExtension`. Describes an extension that reacts to
 * node lifecycle events.
 *
 * @stability stable
 * @example
 * ```ts
 * import { defineNodeExtension } from '@comfyorg/extension-api'
 *
 * export default defineNodeExtension({
 *   name: 'my-org.my-extension',
 *   nodeTypes: ['KSampler'],
 *
 *   nodeCreated(node) {
 *     node.on('executed', (e) => console.log('done', e.output))
 *   }
 * })
 * ```
 */
export interface NodeExtensionOptions {
  /**
   * Globally unique extension name. Used for scope registry keying, hook
   * ordering (D10b lexicographic tie-break), and debug messages.
   *
   * Convention: `'org.extension-name'` or `'Comfy.ExtensionName'`.
   *
   * @stability stable
   */
  name: string

  /**
   * Filter to specific `comfyClass` names. When omitted, the extension
   * receives `nodeCreated` / `loadedGraphNode` for every node type.
   *
   * Replaces the v1 `beforeRegisterNodeDef` filtering pattern (DEP1).
   *
   * @stability stable
   * @example
   * ```ts
   * nodeTypes: ['KSampler', 'KSamplerAdvanced']
   * ```
   */
  nodeTypes?: string[]

  /**
   * Called once per node instance when the node is first created (typed in,
   * pasted from clipboard, duplicated, or loaded without an existing workflow).
   *
   * - Runs inside a Vue `EffectScope`. All `watch` / `computed` / `onNodeMounted`
   *   calls made here are captured and disposed automatically on node removal.
   * - Must be synchronous (D10c). Kick off async work inside the body; use
   *   `loading: ref(true)` for async-dependent state.
   * - Called only once per entity ID lifetime. Copy/paste creates a fresh entity
   *   and fires `nodeCreated` again on the new entity (D12 reset-to-fresh).
   *
   * @stability stable
   */
  nodeCreated?(node: NodeHandle): void

  /**
   * Called once per node instance when the node is restored from a saved
   * workflow. Widget values are already populated when this fires.
   *
   * Same rules as `nodeCreated`. Exactly one of `nodeCreated` or
   * `loadedGraphNode` fires per node entity, never both.
   *
   * Replaces the v1 `loadedGraphNode` hook (which had near-zero real usage per
   * R4-P11) and `nodeType.prototype.onConfigure` patching.
   *
   * @stability stable
   */
  loadedGraphNode?(node: NodeHandle): void
}

/**
 * Options for the global `defineExtension` entry point. Covers extension-wide
 * lifecycle and shell UI contributions.
 *
 * @stability stable
 * @example
 * ```ts
 * import { defineExtension } from '@comfyorg/extension-api'
 *
 * export default defineExtension({
 *   name: 'my-org.my-extension',
 *   async setup() {
 *     // App is ready; register commands, sidebar tabs, etc.
 *   }
 * })
 * ```
 */
export interface ExtensionOptions {
  /**
   * Globally unique extension name. Matches the format of
   * `NodeExtensionOptions.name`.
   *
   * @stability stable
   */
  name: string

  /**
   * Declared API version of this extension. Used by the telemetry system to
   * track v1 → v2 adoption (D6 Phase D gate: "<5% v1 usage before dropping
   * the v1 bridge"). Set to `'2'` for extensions written against this API.
   *
   * Optional in Phase A (no runtime enforcement). The runtime reads this field
   * via `getExtensionVersionReport()` to produce adoption metrics.
   *
   * @stability stable
   * @example
   * ```ts
   * defineExtension({ name: 'my-ext', apiVersion: '2', setup() { … } })
   * ```
   */
  apiVersion?: string

  /**
   * Runs once during app initialization (after the app is mounted but before
   * the first workflow is loaded). Equivalent to the v1 `ComfyExtension.init`.
   *
   * @stability stable
   */
  init?(): void | Promise<void>

  /**
   * Runs once after the app and all core extensions are initialized. Equivalent
   * to the v1 `ComfyExtension.setup`. Safe to call shell UI registration APIs
   * (`ExtensionManager`, `CommandManager`) here.
   *
   * @stability stable
   */
  setup?(): void | Promise<void>
}

// ─── Widget extension options ─────────────────────────────────────────────────

/**
 * Options for `defineWidgetExtension`. Describes an extension that provides a
 * custom widget type with its own DOM rendering.
 *
 * @stability experimental
 * @example
 * ```ts
 * import { defineWidgetExtension } from '@comfyorg/extension-api'
 *
 * export default defineWidgetExtension({
 *   name: 'my-org.color-picker',
 *   type: 'COLOR_PICKER',
 *
 *   widgetCreated(widget, node) {
 *     return {
 *       render(container) { /* mount color picker DOM *\/ },
 *       destroy()        { /* cleanup *\/ }
 *     }
 *   }
 * })
 * ```
 */
export interface WidgetExtensionOptions {
  /** Globally unique extension name. */
  name: string
  /** Widget type string this extension provides (e.g. `'COLOR_PICKER'`). */
  type: string

  /**
   * Called once per widget instance. Return a `{ render, destroy }` pair for
   * custom DOM rendering, or `void` for non-visual widgets.
   *
   * @stability experimental
   */
  widgetCreated?(
    widget: WidgetHandle,
    parentNode: NodeHandle | null
  ): { render(container: HTMLElement): void; destroy?(): void } | void
}

// ─── Registration functions ──────────────────────────────────────────────────

/**
 * Register a node extension. The runtime calls `nodeCreated` or
 * `loadedGraphNode` once per node entity matching `nodeTypes`.
 *
 * This is the primary entry point for extensions that interact with nodes and
 * widgets. Import directly from `@comfyorg/extension-api` — no dependency on
 * `window.app` at module evaluation time (D6 Part 1).
 *
 * Hook firing order across multiple extensions on the same entity follows
 * extension registration order with a lexicographic tie-break on `name` (D10b).
 *
 * @stability stable
 * @example
 * ```ts
 * import { defineNodeExtension } from '@comfyorg/extension-api'
 *
 * export default defineNodeExtension({
 *   name: 'Comfy.PreviewAny',
 *   nodeTypes: ['PreviewAny'],
 *
 *   nodeCreated(node) {
 *     const preview = node.addWidget('STRING', 'preview', '', {
 *       multiline: true, readonly: true, serialize: false
 *     })
 *     node.on('executed', (e) => {
 *       preview.setValue(String(e.output['text'] ?? ''))
 *     })
 *   }
 * })
 * ```
 */
export declare function defineNodeExtension(
  options: NodeExtensionOptions
): NodeExtensionOptions

/**
 * Register an extension for app-wide lifecycle and shell UI contributions.
 *
 * Use `defineNodeExtension` for node/widget interactions. Use this for
 * `init`, `setup`, sidebar tabs, commands, and other app-level concerns.
 *
 * @stability stable
 * @example
 * ```ts
 * import { defineExtension } from '@comfyorg/extension-api'
 *
 * export default defineExtension({
 *   name: 'my-org.my-extension',
 *   setup() {
 *     console.log('Extension ready')
 *   }
 * })
 * ```
 */
export declare function defineExtension(
  options: ExtensionOptions
): ExtensionOptions

/**
 * Register a custom widget type. Called once at module load time to declare
 * a new widget kind.
 *
 * @stability experimental
 */
export declare function defineWidgetExtension(
  options: WidgetExtensionOptions
): WidgetExtensionOptions

// ─── Implicit-context lifecycle hooks (D10a) ─────────────────────────────────
//
// These functions read the _currentScope global slot set by the runtime
// immediately before invoking nodeCreated()/loadedGraphNode(). They must be
// called synchronously during setup — calling them after an `await` is a no-op
// in production and throws in development.
//
// The ctx.onNodeMounted(fn) form from D6 Part 1 examples is a thin alias on
// NodeHandle that calls these same functions under the hood.

export {
  /**
   * Register a callback to fire when the node entity is fully mounted to the
   * graph (the reactive mount watcher has run, the scope is active, and
   * `setup()` has completed).
   *
   * Must be called synchronously inside `nodeCreated` or `loadedGraphNode`.
   *
   * @stability experimental
   * @example
   * ```ts
   * nodeCreated(node) {
   *   onNodeMounted(() => {
   *     // Safe to access DOM widgets, canvas, etc.
   *   })
   * }
   * ```
   */
  onNodeMounted,
  /**
   * Register a callback to fire when the node entity is removed from the graph
   * (NOT on subgraph promotion, which is a DOM-move, not an unmount).
   *
   * Replaces `nodeType.prototype.onRemoved` patching (S2.N4 — 7+ repos,
   * 4.89 blast radius).
   *
   * Must be called synchronously inside `nodeCreated` or `loadedGraphNode`.
   *
   * @stability experimental
   * @example
   * ```ts
   * nodeCreated(node) {
   *   onNodeRemoved(() => {
   *     cleanup()
   *   })
   * }
   * ```
   */
  onNodeRemoved
} from '@/services/extension-api-service'
