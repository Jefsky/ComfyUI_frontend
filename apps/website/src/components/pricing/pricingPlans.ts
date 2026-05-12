import type { TranslationKey } from '../../i18n/translations'

import { featureFlags } from '../../config/featureFlags'
import { externalLinks } from '../../config/routes'

interface PlanFeature {
  text: TranslationKey
}

interface PricingPlan {
  id: string
  labelKey: TranslationKey
  summaryKey: TranslationKey
  priceKey?: TranslationKey
  creditsKey?: TranslationKey
  estimateKey?: TranslationKey
  ctaKey: TranslationKey
  ctaHref: string
  featureIntroKey?: TranslationKey
  features: PlanFeature[]
  andMoreKey?: TranslationKey
  image?: string
  isPopular?: boolean
  isEnterprise?: boolean
}

type PaidTierId = 'standard' | 'creator' | 'pro'

function subscribeUrl(tier: PaidTierId): string {
  return `${externalLinks.cloud}/cloud/subscribe?tier=${tier}&cycle=monthly`
}

const freeTierPlan: PricingPlan = {
  id: 'free',
  labelKey: 'pricing.plan.free.label',
  summaryKey: 'pricing.plan.free.summary',
  priceKey: 'pricing.plan.free.price',
  creditsKey: 'pricing.plan.free.credits',
  estimateKey: 'pricing.plan.free.estimate',
  ctaKey: 'pricing.plan.free.cta',
  ctaHref: externalLinks.cloud,
  features: [
    { text: 'pricing.plan.free.feature1' },
    { text: 'pricing.plan.free.feature2' }
  ]
}

export function buildPricingPlans(
  enterpriseRoute: string,
  cloudFreeTier: boolean = featureFlags.cloudFreeTier
): PricingPlan[] {
  const standardFeatureIntroKey: TranslationKey = cloudFreeTier
    ? 'pricing.plan.standard.featureIntro'
    : 'pricing.plan.standard.featureIntroNoFreeTier'

  return [
    ...(cloudFreeTier ? [freeTierPlan] : []),
    {
      id: 'standard',
      labelKey: 'pricing.plan.standard.label',
      summaryKey: 'pricing.plan.standard.summary',
      priceKey: 'pricing.plan.standard.price',
      creditsKey: 'pricing.plan.standard.credits',
      estimateKey: 'pricing.plan.standard.estimate',
      ctaKey: 'pricing.plan.standard.cta',
      ctaHref: subscribeUrl('standard'),
      featureIntroKey: standardFeatureIntroKey,
      features: [
        { text: 'pricing.plan.standard.feature1' },
        { text: 'pricing.plan.standard.feature2' }
      ]
    },
    {
      id: 'creator',
      labelKey: 'pricing.plan.creator.label',
      summaryKey: 'pricing.plan.creator.summary',
      priceKey: 'pricing.plan.creator.price',
      creditsKey: 'pricing.plan.creator.credits',
      estimateKey: 'pricing.plan.creator.estimate',
      ctaKey: 'pricing.plan.creator.cta',
      ctaHref: subscribeUrl('creator'),
      featureIntroKey: 'pricing.plan.creator.featureIntro',
      features: [
        { text: 'pricing.plan.creator.feature1' },
        { text: 'pricing.plan.creator.feature2' }
      ],
      isPopular: true
    },
    {
      id: 'pro',
      labelKey: 'pricing.plan.pro.label',
      summaryKey: 'pricing.plan.pro.summary',
      priceKey: 'pricing.plan.pro.price',
      creditsKey: 'pricing.plan.pro.credits',
      estimateKey: 'pricing.plan.pro.estimate',
      ctaKey: 'pricing.plan.pro.cta',
      ctaHref: subscribeUrl('pro'),
      featureIntroKey: 'pricing.plan.pro.featureIntro',
      features: [
        { text: 'pricing.plan.pro.feature1' },
        { text: 'pricing.plan.pro.feature2' }
      ]
    },
    {
      id: 'enterprise',
      labelKey: 'pricing.enterprise.label',
      summaryKey: 'pricing.enterprise.description',
      ctaKey: 'pricing.enterprise.cta',
      ctaHref: enterpriseRoute,
      features: [],
      isEnterprise: true
    }
  ]
}

export function gridColsClass(standardPlanCount: number): string {
  if (standardPlanCount === 4) return 'lg:grid-cols-4'
  if (standardPlanCount === 3) return 'lg:grid-cols-3'
  throw new Error(
    `gridColsClass: unsupported standardPlanCount ${standardPlanCount}; only 3 or 4 are supported. Update pricing layout in PriceSection.vue if a new tier is added.`
  )
}
