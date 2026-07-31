# Provider pattern

Use this document as the entry path for adding or changing a built-in provider.
It is the public contributor guide for provider evidence, implementation, and
verification.

`pi-meter` supports built-in providers only. This pattern does not define a
public registry, provider SDK, or third-party extension interface.

## Current built-ins

- **OpenAI Codex** is live with `first-party-source` evidence. It uses Pi's
  `openai-codex` authentication and OpenAI's source-reviewed ChatGPT usage
  route.
- **Claude** is `awaiting-interface`. Waiting for Anthropic to publish a
  supported Claude allowance interface.
- **OpenCode Go** remains `awaiting-interface` until a first-party allowance
  interface replaces dashboard scraping.
- **xAI SuperGrok** is live with `first-party-source` evidence. It accepts only
  Pi's xAI OAuth login, obtains the required user routing ID and plan through
  xAI's source-reviewed fixed-origin `/user?include=subscription` request, then
  reads the shared allowance from `/billing?format=credits`. An xAI API key must
  never be sent to the
  consumer origin.

## Choose the support path

Start with evidence, not code.

```text
Does an accepted allowance interface backed by first-party evidence exist?
├─ no  → add or keep an awaiting-interface provider definition
└─ yes → record the evidence, then add a live AllowanceSource adapter
```

Accepted evidence is either `documented` (a first-party documented developer
interface) or `first-party-source` (an interface implemented in source maintained
by the provider). Dashboard scraping, browser cookies, third-party reverse
engineering, and inferred values do not qualify.

The two paths model different facts:

- **Awaiting interface** is a package support state. It has no source adapter
  and performs no I/O.
- **Live support** has accepted evidence and one `AllowanceSource` adapter. A
  live provider may still be unavailable at runtime.

Runtime failures never change a live provider into an awaiting-interface
provider.

## Shared definition rules

Every provider definition must:

- use a unique, stable, lowercase slug ID;
- carry its display name so the overlay does not map IDs to labels;
- keep its intended position in the definition array because snapshot order is
  definition order;
- use immutable domain objects;
- keep credentials, account IDs, headers, URLs, and raw responses out of domain
  results, errors, fixtures, logs, and UI;
- treat all provider strings as untrusted terminal input.

Wire definitions in `src/index.ts`. Keep construction inside the lazy meter
initialization so loading the extension performs no auth or network work.

## Awaiting-interface path

Use this path when the provider lacks accepted first-party allowance evidence.

1. Record the evidence gap and the condition for reconsideration in the
   provider definition and its behavioral tests.
2. Add an `awaiting-interface` provider definition with its ID, display name,
   and concise explanation.
3. Do not add an `AllowanceSource`, auth resolution, request code, polling, or
   credential detection.
4. Wire the definition into `src/index.ts` in the intended display order.
5. Test the exact support state and prove that the definition has no source.
6. Cover its visible explanation through the overlay test surface when the copy
   or rendering changes.

An awaiting-interface definition is not an adapter. Move it to the live path
only after evidence review, behavioral contract tests, and an accepted
documentation change.

## Live adapter path

A live provider adapter owns one external provider protocol. It authenticates,
requests, validates, and normalizes provider-owned facts behind the
`AllowanceSource.read(signal)` seam.

Before implementation:

1. Record first-party links and the reviewed revision in the change description
   when establishing or changing the integration.
2. State the evidence class: `documented` or `first-party-source`.
3. Record the fixed origin, request shape, and accepted payload behavior in the
   adapter's behavioral tests.
4. Choose concise sanitized payloads in the adapter test by default. Use
   standalone fixtures only when payload size or provenance gives them
   independent value.

Then implement the adapter:

1. Resolve auth through Pi's `ctx.modelRegistry.getProviderAuth()` at call time.
2. Send requests only to the reviewed fixed first-party origin.
3. Pass the meter-owned abort signal to the request.
4. Decode remote payloads strictly from `unknown`.
5. Normalize only allowance windows, optional plan, and explicit provider
   observation time.
6. Return typed `SourceResult` failures. Never expose raw provider errors.
7. Return `invalid-response` for missing, malformed, unsafe, or out-of-range
   allowance data. Never substitute zero.
8. Create the live provider definition with its evidence class and source.
9. Wire it into `src/index.ts` without starting auth or I/O at extension load.

The adapter does **not** own freshness, caching, request floors, deadlines,
coalescing, retries, progressive notifications, or meter timestamps. The deep
meter module owns those rules. Do not reproduce them in a provider module.

## Required verification matrix

Each live adapter must cover the applicable scenarios below through its
external seams. Use deterministic payloads, injected `fetch`, and deferred
promises; never call a live provider in the test suite.

- **Evidence:** Record the evidence class, first-party source links, and reviewed
  revision in the change description.
- **Definition:** Verify the stable ID, display name, evidence, and live source.
- **Auth:** Cover missing auth, missing request material, auth resolution
  failure, and the absence of auth-file access.
- **Request:** Verify the fixed origin, method, headers, body or its absence, and
  abort signal.
- **Success:** Decode representative payloads and every supported optional
  shape. Assert exact windows and reset timestamps.
- **HTTP failure:** Cover unauthorized statuses, rate limiting, and other
  non-success statuses.
- **Rate limit:** Cover HTTP-date and delta-seconds `Retry-After` values. Ignore
  malformed values without scheduling work.
- **Transport:** Cover network rejection and abort behavior. Adapter abort
  covers the timer-driven case; the meter owns the deadline.
- **Decode:** Reject invalid JSON, missing fields, wrong types, non-finite or
  out-of-range percentages, unsafe provider strings, and schema drift.
- **Security:** Prove that results and failures contain no credential, account
  ID, header, URL, raw response, or raw provider error.
- **Composition:** Prove that extension load performs no auth or network work
  and that the provider keeps its definition order. When one Pi provider ID
  supports both API-key and subscription OAuth credentials, prove the adapter
  rejects the wrong credential type before sending any request.

The meter's existing tests remain the test surface for freshness, caching,
request floors, deadlines, coalescing, cancellation, stale generations, and
subscriber behavior. Do not duplicate those tests in each adapter.

Each awaiting-interface definition must cover:

- **Definition:** Verify the stable ID, display name, canonical explanation,
  and `awaiting-interface` support.
- **Safety:** Prove that no source adapter, auth resolution, or network path
  exists.
- **Composition:** Verify stable definition order and no startup I/O.
- **Presentation:** Verify the awaiting-interface badge and explanation when
  visible behavior changes.

## Change checklist

Before finishing a provider change:

- [ ] Evidence satisfies the first-party policy in this guide.
- [ ] The support state matches the distinction in this guide.
- [ ] Provider evidence, code, and behavioral tests describe the same contract.
- [ ] Provider strings fail closed before reaching the overlay.
- [ ] No secret-bearing or identity-bearing value crosses the source seam.
- [ ] `src/index.ts` remains lazy and preserves provider order.
- [ ] `pnpm check` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm dev` manual checks cover `/meter`, refresh, close, reload, and resize
      when the provider changes visible behavior.

## Do not add yet

A new provider does not justify a public registry, cross-extension event bus,
generic HTTP client, auth hierarchy, DI container, or provider SDK. The existing
`AllowanceSource` seam is the pattern. Revisit public extensibility only when a
separate provider package creates a real second integration use case.
