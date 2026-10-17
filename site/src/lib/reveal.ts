import type { Directive } from "vue";

/**
 * `v-reveal` (optionally `v-reveal="120"` for a delay in ms): the element fades up the first time
 * it scrolls into view. Without IntersectionObserver, or with reduced motion, it is shown at once.
 */
const observer =
  typeof IntersectionObserver === "undefined"
    ? undefined
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add("is-visible");
            observer?.unobserve(entry.target);
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
      );

export const reveal: Directive<HTMLElement, number | undefined> = {
  mounted(el, binding) {
    el.classList.add("reveal");
    if (binding.value) el.style.setProperty("--reveal-delay", `${binding.value}ms`);
    if (!observer || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-visible");
      return;
    }
    observer.observe(el);
    // Whatever is on screen at load fades in on the next frame, without waiting for the observer.
    if (el.getBoundingClientRect().top < innerHeight) requestAnimationFrame(() => el.classList.add("is-visible"));
  },
  unmounted(el) {
    observer?.unobserve(el);
  },
};
