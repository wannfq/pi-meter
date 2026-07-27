# AGENTS.md

## Purpose

`pi-meter` is a Pi extension that opens a compact `/meter` overlay for provider
allowance windows. Keep the package narrow: one extension entry point, one
command, built-in provider adapters, and no startup or background network work.

## Documentation

User and contributor documentation lives in [`docs/`](docs/). For provider
work, start with [`docs/providers.md`](docs/providers.md); it defines the
required evidence, implementation, and verification steps.

Private design notes live in the gitignored `design/` directory. When that
local directory is available, consult its package design, domain model,
glossary, ADRs, and provider research before changing behavior. Do not add
links from public documentation to these local files.

When code and documentation disagree, preserve safety and domain invariants,
then update the relevant public documentation and local design notes in the
same change.

## Project structure

- `src/index.ts` — Pi composition root, built-in provider order, awaiting-interface
  definitions, and `/meter` registration. Keep live provider construction lazy
  so startup performs no auth or network work.
- `src/meter.ts` — deep meter module. Owns refresh coordination, cache,
  freshness, request floors, cancellation, notifications, and snapshots.
- `src/providers/openai-codex.ts` — OpenAI Codex auth, fixed-origin request,
  source-reviewed contract implementation, strict decoding, and normalization.
- `src/ui/meter-overlay.ts` — concrete Pi TUI adapter, input, lifecycle,
  rendering, and freshness-boundary timers.
- `src/ui/format.ts` — pure formatting and visible-width helpers.
- Co-located `*.test.ts` files define each module's test surface.

Do not split the meter into registry, cache, clock, result, or generic port
layers without demonstrated independent change pressure.

## Commands

Use the pinned pnpm version declared in `package.json`.

```sh
pnpm install
pnpm check       # TypeScript, no emit
pnpm test        # Full Vitest suite
pnpm test:watch  # Watch mode
pnpm dev         # Load only this extension in Pi
```

Before finishing a code change, run `pnpm check` and `pnpm test`. For UI work,
also load the extension with `pnpm dev` and manually check `/meter`, refresh,
close, reload, and terminal resizing when an interactive TUI is available.

## Coding conventions

- Use strict TypeScript and ESM.
- Use `.js` suffixes in relative TypeScript imports.
- Keep domain objects immutable with `readonly` fields.
- Prefer discriminated unions and typed expected failures over exceptions or
  sentinel values.
- Keep formatting functions pure.
- Inject `fetch` or `now` directly only where deterministic tests need them; do
  not introduce wrapper hierarchies.
- Use Node's built-in `fetch`, `AbortController`, and `Date` APIs.
- Preserve provider definition order and stable lowercase slug IDs.
- Keep comments focused on non-obvious constraints or intent.

## Architectural boundaries

Preserve these MVP decisions:

- TUI command overlay only; no footer.
- Built-in adapters only; no public provider registry or cross-extension event
  bus.
- On-demand progressive refresh only; no startup requests, polling, automatic
  retries, or persistent cache.
- No credential storage, direct Pi auth-file reads, browser-cookie extraction,
  or dashboard scraping.
- No OpenCode Go I/O until an accepted first-party allowance interface exists.
- No generic UI port, provider SDK, HTTP client hierarchy, DI container,
  bundler, or new framework without a concrete need.

A future live provider requires first-party evidence, an adapter, behavioral
contract tests, composition wiring, and documentation.

## Provider and security rules

- Resolve OpenAI Codex auth through Pi's
  `ctx.modelRegistry.getProviderAuth()`.
- Send requests only to the fixed, source-backed OpenAI/ChatGPT origin.
- Keep OpenAI request and decoding behavior aligned with the reviewed
  first-party source.
- Decode remote payloads strictly. Reject malformed values and schema drift as
  `invalid-response`; never convert missing or invalid allowance data to zero.
- Treat all provider strings as untrusted terminal input. Reject control
  characters and unsafe shapes before they reach the overlay.
- Never expose credentials, account IDs, request headers, URLs, raw responses,
  or raw provider errors in domain objects, UI, logs, or tests.
- Preserve separate latest-success and latest-failure facts. A failed refresh
  must not erase a usable cached reading.
- Use meter-stamped `fetchedAt` for freshness; provider `observedAt` is
  provenance only.

## Overlay rules

- Use Pi's callback theme; do not hard-code ANSI colors.
- Keep every rendered line within the width passed to `render(width)`, including
  ANSI and wide Unicode text.
- Render immediately, subscribe to coherent meter transitions, and call
  `tui.requestRender()` after visible state changes.
- Support loading, ready, stale, expired, unavailable, partial-success, and
  awaiting-interface states.
- `r` requests a force refresh but must still respect the provider safety floor.
  `Esc` and `q` close the overlay.
- On disposal, unsubscribe before aborting active work, clear the one-shot
  freshness timer, and suppress later repaint.
- Freshness-boundary timers may redraw an open overlay; they must not poll
  providers or survive disposal.

Pi's `Component` type does not declare `dispose()`, but Pi's custom-overlay
runtime calls an optional component `dispose()` method by structural lookup.
Keep overlay cleanup idempotent and test it directly.

## Testing expectations

Test through module interfaces and external seams rather than private
implementation details.

- Meter changes: cover ordering, progressive settlement, cache freshness,
  failures, coalescing, safety floors, deadlines, aborts, stale generations,
  and listener isolation.
- Provider changes: use representative sanitized payloads and cover auth
  absence, HTTP failures, rate limiting, timeout, network failure, malformed
  payloads, schema drift, and secret leakage.
- Overlay changes: cover command guards, all visible states, refresh feedback,
  close keys, disposal, repaint suppression, timers, ANSI width, Unicode width,
  and narrow terminals.
- Any bug fix must include a regression test. Boundary validation should test
  accepted and rejected edges.
- Keep tests deterministic: use fake time, injected dependencies, and deferred
  promises instead of live provider requests.

## Change discipline

- Make the smallest change that preserves the documented design.
- Do not weaken tests to accommodate behavior changes.
- Update relevant provider evidence, documentation, and behavioral tests with
  contract changes.
- Avoid unrelated formatting or refactors.
- Do not begin deferred features unless the task explicitly changes scope.
