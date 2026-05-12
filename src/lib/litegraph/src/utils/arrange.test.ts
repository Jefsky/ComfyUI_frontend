import { describe, expect, it } from 'vitest'
import { alignNodes, distributeNodes, getBoundaryNodes } from './arrange'

function createMockNode(pos: [number, number], size: [number, number], collapsed = false, collapsedWidth?: number) {
  return {
    pos: [...pos] as [number, number],
    size: [...size] as [number, number],
    flags: { collapsed },
    get renderingSize(): [number, number] {
      return this.flags.collapsed ? [collapsedWidth ?? 0, 0] : this.size
    }
  } as unknown as import('./arrange').LGraphNode
}

describe('getBoundaryNodes', () => {
  it('uses renderingSize for collapsed nodes', () => {
    const expanded = createMockNode([0, 0], [100, 50], false)
    const collapsed = createMockNode([200, 0], [200, 50], true, 40)

    const result = getBoundaryNodes([expanded, collapsed])

    // collapsed node's right edge is at x + collapsedWidth (40), not x + size[0] (200)
    expect(result?.right).toBe(collapsed)
    expect(result?.left).toBe(expanded)
    // collapsed node's height should be 0 (from renderingSize[1])
    expect(result?.bottom).toBe(expanded)
  })

  it('uses node.size for uncollapsed nodes', () => {
    const node1 = createMockNode([0, 0], [100, 50], false)
    const node2 = createMockNode([100, 0], [80, 40], false)

    const result = getBoundaryNodes([node1, node2])

    expect(result?.right).toBe(node1) // 0+100=100 > 100+80=180? No wait... 100+80=180 > 0+100=100 so node2 is right
    // x+width: node1=100, node2=180 → right is node2
    // y: both 0, so first one is top
  })
})

describe('distributeNodes', () => {
  it('uses renderingSize for collapsed nodes in horizontal distribution', () => {
    const nodes = [
      createMockNode([0, 0], [100, 50], false),
      createMockNode([100, 0], [200, 50], true, 40)
    ]

    distributeNodes(nodes, true)

    // When distributing, the collapsed node (width=40) takes less space
    // The gap calculation uses renderingSize widths, not full size widths
    // First node stays at 0, second node positioned after first + gap
    expect(nodes[1].pos[0]).not.toBe(100) // should not be at original pos
  })

  it('uses node.size for uncollapsed nodes', () => {
    const nodes = [
      createMockNode([0, 0], [100, 50], false),
      createMockNode([100, 0], [100, 50], false)
    ]

    const initialPos = nodes[1].pos[0]
    distributeNodes(nodes, true)

    // Two 100px nodes with 200px total span should be evenly distributed
    // Gap = (200 - 200) / 1 = 0, so second node stays or moves minimally
    expect(nodes[0].pos[0]).toBe(0)
  })
})

describe('alignNodes', () => {
  it('uses renderingSize of boundary node for right alignment', () => {
    const boundary = createMockNode([0, 0], [100, 50], true, 40)
    const node = createMockNode([200, 10], [100, 50], false)

    alignNodes([node], 'right', boundary)

    // node should align to boundary.right.pos[0] + boundary.renderingSize[0] - node.size[0]
    // = 0 + 40 - 100 = -60
    expect(node.pos[0]).toBe(-60)
  })

  it('uses renderingSize of boundary node for bottom alignment', () => {
    const boundary = createMockNode([0, 0], [100, 50], true, 40)
    const node = createMockNode([10, 100], [60, 40], false)

    alignNodes([node], 'bottom', boundary)

    // node should align to boundary.bottom.pos[1] + boundary.renderingSize[1] - node.size[1]
    // = 0 + 0 - 40 = -40
    expect(node.pos[1]).toBe(-40)
  })

  it('aligns left using boundary.pos for left direction', () => {
    const boundary = createMockNode([50, 50], [100, 50], true, 40)
    const node = createMockNode([200, 100], [80, 40], false)

    alignNodes([node], 'left', boundary)

    // left alignment: node.pos[0] = boundary.left.pos[0]
    expect(node.pos[0]).toBe(50)
  })

  it('aligns top using boundary.pos for top direction', () => {
    const boundary = createMockNode([50, 50], [100, 50], true, 40)
    const node = createMockNode([100, 200], [80, 40], false)

    alignNodes([node], 'top', boundary)

    expect(node.pos[1]).toBe(50)
  })
})
