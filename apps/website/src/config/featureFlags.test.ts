import { describe, expect, it } from 'vitest'

import snapshot from '../data/feature-flags.snapshot.json' with { type: 'json' }
import { featureFlags } from './featureFlags'

describe('featureFlags', () => {
  it('exposes cloudFreeTier derived from the build-time snapshot', () => {
    expect(featureFlags.cloudFreeTier).toBe(snapshot.flags.cloudFreeTier)
  })

  it('exposes cloudFreeTier as a boolean', () => {
    expect(typeof featureFlags.cloudFreeTier).toBe('boolean')
  })

  it('is frozen so consumers cannot mutate flag state at runtime', () => {
    expect(Object.isFrozen(featureFlags)).toBe(true)
  })
})
