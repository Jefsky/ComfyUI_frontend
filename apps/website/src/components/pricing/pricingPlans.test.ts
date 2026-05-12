import { describe, expect, it } from 'vitest'

import { buildStandardPlans, gridColsClass } from './pricingPlans'

const ENTERPRISE_ROUTE = '/cloud/enterprise'

describe('buildStandardPlans', () => {
  it('includes the free tier card when cloudFreeTier is true', () => {
    const plans = buildStandardPlans(ENTERPRISE_ROUTE, true)
    expect(plans.map((p) => p.id)).toEqual([
      'free',
      'standard',
      'creator',
      'pro',
      'enterprise'
    ])
  })

  it('omits the free tier card when cloudFreeTier is false', () => {
    const plans = buildStandardPlans(ENTERPRISE_ROUTE, false)
    expect(plans.map((p) => p.id)).toEqual([
      'standard',
      'creator',
      'pro',
      'enterprise'
    ])
    expect(plans.find((p) => p.id === 'free')).toBeUndefined()
  })

  it('uses the Free-referencing standard feature intro when cloudFreeTier is true', () => {
    const plans = buildStandardPlans(ENTERPRISE_ROUTE, true)
    const standard = plans.find((p) => p.id === 'standard')
    expect(standard?.featureIntroKey).toBe('pricing.plan.standard.featureIntro')
  })

  it('uses the neutral standard feature intro when cloudFreeTier is false', () => {
    const plans = buildStandardPlans(ENTERPRISE_ROUTE, false)
    const standard = plans.find((p) => p.id === 'standard')
    expect(standard?.featureIntroKey).toBe(
      'pricing.plan.standard.featureIntroNoFreeTier'
    )
  })

  it('passes through the enterprise route on the enterprise plan', () => {
    const plans = buildStandardPlans('/zh-CN/cloud/enterprise', false)
    const enterprise = plans.find((p) => p.id === 'enterprise')
    expect(enterprise?.ctaHref).toBe('/zh-CN/cloud/enterprise')
  })

  it('preserves creator as the popular tier regardless of the flag', () => {
    for (const cloudFreeTier of [true, false]) {
      const plans = buildStandardPlans(ENTERPRISE_ROUTE, cloudFreeTier)
      const popular = plans.filter((p) => p.isPopular).map((p) => p.id)
      expect(popular).toEqual(['creator'])
    }
  })
})

describe('gridColsClass', () => {
  it('uses 4-col layout when the free tier card is present', () => {
    expect(gridColsClass(4)).toBe('lg:grid-cols-4')
  })

  it('uses 3-col layout when the free tier card is hidden', () => {
    expect(gridColsClass(3)).toBe('lg:grid-cols-3')
  })
})
