<script setup lang="ts">
/** The Navarch mark (the favicon's compass), drawn in the current accent. */
defineProps<{ size?: number }>();
</script>

<template>
  <svg :width="size ?? 28" :height="size ?? 28" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="7" fill="var(--surface-2)" />
    <circle cx="16" cy="16" r="7" fill="none" stroke="var(--accent)" stroke-width="2.5" />
    <path d="M16 4v5M16 23v5M4 16h5M23 16h5" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
    <circle cx="16" cy="16" r="2.5" fill="var(--accent)" />
  </svg>
</template>
