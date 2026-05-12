<script setup lang="ts">
import type { Locale } from '../../../i18n/translations'

import { featureFlags } from '../../../config/featureFlags'
import FAQSection from '../../common/FAQSection.vue'

const { locale = 'en' } = defineProps<{ locale?: Locale }>()

const skipIndices: readonly number[] = featureFlags.cloudFreeTier ? [] : [1]
</script>

<template>
  <FAQSection
    :locale="locale"
    heading-key="cloud.faq.heading"
    faq-prefix="cloud.faq"
    :faq-count="15"
    :skip-indices="skipIndices"
  />
</template>
