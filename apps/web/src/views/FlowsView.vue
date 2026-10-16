<script setup lang="ts">
import type { FlowSummary } from "@navarch/contracts";
import { Plus, Workflow } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client.ts";
import { isDevice } from "../api/session.ts";
import { newFlowYaml } from "../lib/flowDoc.ts";
import { ago } from "../lib/status.ts";

/** The Flows (ADR 0033): built-in ones from `flows/`, read-only, and the user's Studio Flows. */
const { t } = useI18n();
const router = useRouter();
const flows = ref<FlowSummary[]>([]);
const loaded = ref(false);
const error = ref<string | null>(null);
const creating = ref(false);
const newName = ref("");

const builtins = computed(() => flows.value.filter((f) => f.source === "builtin"));
const studio = computed(() => flows.value.filter((f) => f.source === "studio"));

onMounted(async () => {
  try {
    flows.value = await api.flows();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loaded.value = true;
  }
});

async function create() {
  const name = newName.value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    error.value = t("flows.nameRule");
    return;
  }
  try {
    await api.saveFlowDraft(name, newFlowYaml(name), null);
    await router.push(`/flows/${name}`);
  } catch (err) {
    error.value = (err as Error).message;
  }
}

function state(f: FlowSummary): string {
  if (f.source === "builtin") return t("flows.builtin");
  return [f.published_version ? `v${f.published_version}` : t("flows.unpublished"), ...(f.draft ? [t("flows.draftRev", { n: f.draft.revision })] : [])].join(" · ");
}
</script>

<template>
  <section v-if="isDevice" class="p-6 text-muted">{{ t("studio.desktopOnly") }}</section>
  <section v-else class="mx-auto max-w-4xl p-6">
    <div class="mb-4 flex items-center gap-3">
      <h1 class="text-xl font-semibold">{{ t("flows.title") }}</h1>
      <button type="button" class="ml-auto inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-bg" @click="creating = !creating">
        <Plus :size="16" aria-hidden="true" />{{ t("flows.new") }}
      </button>
    </div>
    <p class="mb-4 text-sm text-muted">{{ t("flows.intro") }}</p>
    <form v-if="creating" class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line p-3" @submit.prevent="create">
      <label for="flow-name" class="text-sm">{{ t("flows.newName") }}</label>
      <input id="flow-name" v-model="newName" class="min-h-11 w-64 rounded-md border border-line bg-bg px-3 font-mono focus:border-accent focus:outline-none" placeholder="my-flow" />
      <button type="submit" class="min-h-11 rounded-md border border-line px-4 text-sm hover:bg-surface-2">{{ t("flows.create") }}</button>
      <span class="w-full text-xs text-muted">{{ t("flows.nameRule") }}</span>
    </form>
    <p v-if="error" class="tone-danger mb-3 text-sm" style="color: var(--tone)" role="alert">{{ error }}</p>
    <p v-if="!loaded" class="text-muted">{{ t("flows.loading") }}</p>

    <template v-for="group in [{ key: 'studio', items: studio }, { key: 'builtins', items: builtins }]" :key="group.key">
      <h2 v-if="loaded" class="mt-6 mb-2 text-sm font-semibold text-muted">{{ t(`flows.${group.key}`) }}</h2>
      <p v-if="loaded && !group.items.length" class="rounded-lg border border-dashed border-line p-4 text-sm text-muted">{{ t("flows.none") }}</p>
      <ul class="space-y-2">
        <li v-for="f in group.items" :key="f.name">
          <RouterLink :to="`/flows/${f.name}`" class="flex min-h-14 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 hover:bg-surface-2">
            <Workflow :size="18" class="shrink-0 text-accent" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="block font-mono font-medium">{{ f.name }}</span>
              <span class="block truncate text-xs text-muted">{{ f.description || t("flows.noDescription") }}</span>
            </span>
            <span v-if="f.shadowed" class="tone-warning text-xs" style="color: var(--tone)">{{ t("flows.shadowedShort") }}</span>
            <span class="rounded-full border border-line px-2 py-0.5 text-xs text-muted">{{ state(f) }}</span>
            <time v-if="f.updated_at" :datetime="f.updated_at" class="w-20 text-right text-xs text-muted">{{ ago(f.updated_at) }}</time>
          </RouterLink>
        </li>
      </ul>
    </template>
  </section>
</template>
