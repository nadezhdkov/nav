<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { StatusLook } from "../lib/status.ts";

/** Icon + text, never color alone (spec §15.4). */
const props = defineProps<{ look: StatusLook; status: string; size?: "sm" | "md" }>();
const { t } = useI18n();
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium whitespace-nowrap"
    :class="[`tone-${props.look.tone}`, props.size === 'md' ? 'text-sm' : 'text-xs']"
    style="color: var(--tone); border-color: color-mix(in srgb, var(--tone) 40%, transparent); background: color-mix(in srgb, var(--tone) 10%, transparent)"
  >
    <component :is="props.look.icon" :size="props.size === 'md' ? 15 : 13" :class="{ spin: props.look.spin }" aria-hidden="true" />
    {{ t(`status.${props.status}`) }}
  </span>
</template>
