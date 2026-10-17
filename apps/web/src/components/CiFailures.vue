<script setup lang="ts">
import type { CiFailureView } from "@navarch/contracts";
import { Ban, ExternalLink, GitPullRequest, Wrench } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client.ts";
import { isDevice } from "../api/session.ts";
import { useCiStore } from "../stores/runs.ts";

/**
 * Failing checks noticed on open pull requests (ADR 0041). Titles and check names come from GitHub
 * and are untrusted (T1): shown as plain text, on one line. Starting a fix or dismissing a failure is
 * desktop only; a paired phone sees the list and opens the pull request.
 */
const { t } = useI18n();
const router = useRouter();
const ci = useCiStore();

const busy = ref<string | null>(null);
const errors = ref<Record<string, string>>({});

/** A GitHub link, or nothing: a stored URL is never trusted to be a web address. */
function safeUrl(url: string): string | undefined {
  return /^https:\/\//i.test(url) ? url : undefined;
}

function checks(f: CiFailureView): string {
  const names = f.checks.map((c) => c.name);
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

async function fix(f: CiFailureView) {
  busy.value = f.id;
  delete errors.value[f.id];
  try {
    const { run } = await api.fixCiFailure(f.id);
    await router.push(`/runs/${run.id}`);
  } catch (err) {
    errors.value[f.id] = (err as Error).message;
  } finally {
    busy.value = null;
    void ci.load();
  }
}

async function dismiss(f: CiFailureView) {
  busy.value = f.id;
  delete errors.value[f.id];
  try {
    await api.dismissCiFailure(f.id);
  } catch (err) {
    errors.value[f.id] = (err as Error).message;
  } finally {
    busy.value = null;
    void ci.load();
  }
}
</script>

<template>
  <div v-if="ci.failures.length" class="tone-danger rounded-lg border bg-surface p-3" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)" data-testid="ci-failures">
    <h2 class="flex items-center gap-2 text-sm font-medium">
      <GitPullRequest :size="16" style="color: var(--tone)" aria-hidden="true" />{{ t("home.ci.title") }}
      <span class="font-normal text-muted">{{ ci.failures.length }}</span>
    </h2>
    <ul class="mt-2 space-y-2">
      <li v-for="f in ci.failures" :key="f.id" class="rounded-md border border-line p-2.5">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ f.title }}</p>
            <p class="truncate text-xs text-muted">{{ t("home.ci.line", { repo: f.repo, number: f.number, checks: checks(f) }) }}</p>
          </div>
          <a
            v-if="safeUrl(f.url)"
            :href="safeUrl(f.url)"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-accent"
            :aria-label="t('home.ci.open')"
            :title="t('home.ci.open')"
          ><ExternalLink :size="16" aria-hidden="true" /></a>
        </div>
        <div v-if="!isDevice" class="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            class="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-bg disabled:opacity-60"
            :disabled="busy === f.id"
            @click="fix(f)"
          ><Wrench :size="15" aria-hidden="true" />{{ busy === f.id ? t("home.ci.starting") : t("home.ci.fix") }}</button>
          <button
            type="button"
            class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2 disabled:opacity-60"
            :disabled="busy === f.id"
            @click="dismiss(f)"
          ><Ban :size="15" aria-hidden="true" />{{ t("home.ci.dismiss") }}</button>
        </div>
        <p v-if="errors[f.id]" class="mt-1.5 text-xs" style="color: var(--tone-danger)" role="alert">{{ errors[f.id] }}</p>
      </li>
    </ul>
  </div>
</template>
