# Phase 3, slice 12: Specs screen

Status: implemented · Branch: `feat/phase-3-12-specs-view` · Spec: §6.8, §15 · ADR: 0053

`/specs` lists the extractions of `reverse-spec` and the addenda of `spec-sync`, with the confirmed share against the 70 % target.

## Behavior

- Latest extraction: its 🟢 share and whether it meets the target.
- Each extraction: run codename (link), time, share, a stacked bar, counts of components, claims, confirmed, inferred, gaps and downgraded claims, and its branch.
- Each addendum: `owner/repo#N`, run (link), time, changes, confirmed, inferred, gaps, stale claims and claims not found.
- `GET /api/v1/specs/addenda` (devices may read it); the screen refetches on `spec.generated` and `spec.addendum.written`.
- English, Brazilian Portuguese, Spanish, German and Simplified Chinese.

## Acceptance

- The view renders the shares, the target verdict (met or below), downgraded counts and the addendum's stale and unmatched counts as text; empty states say what to run.
- The store refetches once after spec events and ignores others; the route returns a spec-sync run's write.
- Checked in a browser screenshot on the desktop layout.

## Not in this slice

- Component and claim views, traceability matrices, a phone tab, reading the specs as merged in the repository.
