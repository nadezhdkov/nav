# Phase 4, slice 7b — the phone's loader

Status: implemented. ADR 0067. Builds on slice 7a (ADR 0066).

## Behaviour

- `make relay-build` builds the loader page, `loader.js` and `sw.js` into `apps/relay/dist`; the relay serves them at `/r/<relay id>/`.
- A phone opens the QR link `<relay>/r/<id>/#pair=<code>`: the loader pairs end to end, keeps its secrets, registers the service worker and opens `/r/<id>/home`, which the daemon serves through the tunnel.
- The app runs under `/r/<id>`: API calls, router, logo, storage key and module preloads follow the base given by `<meta name="navarch-base">`. Behind a relay it polls instead of using the live socket.
- A computer that is offline or a phone that was revoked shows a clear page; the app shows its usual unreachable notice.

## Acceptance

- Pairing, the app on a phone-sized screen and the Home data load through a real relay and daemon in a browser, with no console errors.
- HTML, CSS and manifest links stay under the relay path; binary files are untouched; the daemon's CSP reaches the page.
- A burst of 60 requests is answered; an offline computer or revoked device gives a 503 with a reason.
