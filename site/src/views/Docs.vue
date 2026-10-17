<script setup lang="ts">
import GithubIcon from "../components/GithubIcon.vue";
import { ArrowLeft, ArrowRight } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { DOC_ORDER, DOC_SECTIONS, DOCS } from "../docs/index.ts";
import { GITHUB } from "../lib/site.ts";

const route = useRoute();
const router = useRouter();
const slug = computed(() => String(route.params.slug ?? ""));
const doc = computed(() => DOCS[slug.value]);
const index = computed(() => DOC_ORDER.indexOf(slug.value));
const prev = computed(() => (index.value > 0 ? DOC_ORDER[index.value - 1] : undefined));
const next = computed(() => (index.value >= 0 && index.value < DOC_ORDER.length - 1 ? DOC_ORDER[index.value + 1] : undefined));
const titleOf = (s: string) => DOCS[s]?.title ?? s;
const toc = computed(() => doc.value?.headings ?? []);
const current = ref("");
// The section list is open on wide screens and folded behind "Docs menu" on phones.
const wide = typeof matchMedia === "undefined" || matchMedia("(min-width: 1024px)").matches;

watch(
  doc,
  (d) => {
    document.title = d ? `${d.title} · Navarch docs` : "Page not found · Navarch";
  },
  { immediate: true },
);

/** Links inside the Markdown stay in the SPA. */
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const href = a.getAttribute("href") ?? "";
  if (!href.startsWith(`${base}/`) && !href.startsWith("#")) return;
  e.preventDefault();
  void router.push(href.startsWith("#") ? { hash: href } : href.slice(base.length));
}

// Highlights the section being read in the "On this page" list.
let observer: IntersectionObserver | undefined;
const body = ref<HTMLElement>();
watch(
  () => [slug.value, body.value] as const,
  async () => {
    await nextTick();
    observer?.disconnect();
    if (!body.value) return;
    current.value = toc.value[0]?.id ?? "";
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) current.value = visible.target.id;
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    body.value.querySelectorAll("h2[id], h3[id]").forEach((h) => observer!.observe(h));
  },
  { immediate: true },
);
onBeforeUnmount(() => observer?.disconnect());

const editUrl = computed(() => `${GITHUB}/edit/main/site/src/docs/${slug.value}.md`);
</script>

<template>
  <div class="mx-auto grid max-w-7xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_13rem]">
    <!-- Sections -->
    <nav aria-label="Docs" class="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:self-start lg:overflow-y-auto">
      <details class="docs-nav" :open="wide">
        <summary class="mb-2 cursor-pointer list-none rounded-lg border border-border px-3 py-2.5 text-sm font-semibold lg:hidden">Docs menu</summary>
        <div class="space-y-6 pb-2">
          <div v-for="section in DOC_SECTIONS" :key="section.title">
            <h2 class="eyebrow mb-2 !text-muted">{{ section.title }}</h2>
            <ul class="space-y-0.5 border-l border-border">
              <li v-for="p in section.pages" :key="p">
                <RouterLink
                  :to="`/docs/${p}`"
                  class="-ml-px block border-l-2 py-1.5 pl-3 text-sm transition-colors"
                  :class="p === slug ? 'border-accent font-semibold text-text' : 'border-transparent text-muted hover:text-text'"
                  :aria-current="p === slug ? 'page' : undefined"
                  >{{ titleOf(p) }}</RouterLink
                >
              </li>
            </ul>
          </div>
        </div>
      </details>
    </nav>

    <!-- Page -->
    <article v-if="doc" class="min-w-0">
      <div ref="body" class="prose max-w-3xl" @click="onClick" v-html="doc.html" />
      <div class="mt-12 flex max-w-3xl flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-sm">
        <a :href="editUrl" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-muted hover:text-text"><GithubIcon :size="15" aria-hidden="true" /> Edit this page</a>
      </div>
      <nav class="mt-6 grid max-w-3xl gap-3 sm:grid-cols-2" aria-label="Previous and next">
        <RouterLink v-if="prev" :to="`/docs/${prev}`" class="card flex flex-col gap-1 p-4 transition hover:border-edge">
          <span class="flex items-center gap-1 text-xs text-muted"><ArrowLeft :size="13" aria-hidden="true" /> Previous</span>
          <span class="font-semibold">{{ titleOf(prev) }}</span>
        </RouterLink>
        <span v-else />
        <RouterLink v-if="next" :to="`/docs/${next}`" class="card flex flex-col items-end gap-1 p-4 text-right transition hover:border-edge">
          <span class="flex items-center gap-1 text-xs text-muted">Next <ArrowRight :size="13" aria-hidden="true" /></span>
          <span class="font-semibold">{{ titleOf(next) }}</span>
        </RouterLink>
      </nav>
    </article>
    <article v-else class="min-w-0">
      <h1 class="text-3xl font-bold">This page does not exist</h1>
      <p class="mt-3 text-muted">It may have moved. Pick a page from the menu, or start with the <RouterLink to="/docs/introduction" class="text-accent underline">introduction</RouterLink>.</p>
    </article>

    <!-- On this page -->
    <aside v-if="doc && toc.length" class="hidden xl:block" aria-label="On this page">
      <div class="sticky top-24">
        <h2 class="eyebrow mb-3 !text-muted">On this page</h2>
        <ul class="space-y-1.5 text-sm">
          <li v-for="h in toc" :key="h.id" :class="h.level === 3 ? 'pl-3' : ''">
            <a :href="`#${h.id}`" class="block transition-colors" :class="current === h.id ? 'text-accent' : 'text-muted hover:text-text'" @click.prevent="router.push({ hash: `#${h.id}` })">{{ h.text }}</a>
          </li>
        </ul>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.docs-nav summary::-webkit-details-marker {
  display: none;
}
@media (min-width: 1024px) {
  .docs-nav > summary {
    display: none;
  }
}
</style>
