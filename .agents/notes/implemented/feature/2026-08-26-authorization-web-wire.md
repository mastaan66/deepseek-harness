# Agent Note: Authorization on the web wire

Status: implemented

English | [中文](2026-08-26-authorization-web-wire.zh.md)

## Problem

The authorization seam ([dsh-authorization](../../../../packages/credentials/authorization/README.md)) gave every plugin a way to obtain a credential that only a human can supply — OAuth grants, device codes, interactive key collection — and the multi-provider adapter registered one flow per installed provider. But the only surface that could drive those flows was whatever shared the Host process: a CLI prompt or an editor bridge. A browser session, the product's primary surface, could list providers and type API keys, yet could not sign in to any provider whose credential requires a conversation. The seam existed; its largest consumer was unreachable from the web.

Bridging the two raised one structural question: `AuthorizationSession` is inherently conversational — notices stream out, prompts come back — while the web's apiproxy contract is unary request/response over HTTP, with streams reserved for session-owned frames.

## Decision

The authorization domain joins the apiproxy as five unary methods (`authorization.list/begin/cancel/status/answer`) with no mux frames and no changes to `respond()` routing:

- `begin` resolves only at settlement and runs under the caller-paced timeout policy (like `host.pickDirectory`): no unary deadline, only caller/connection aborts, because an OAuth attempt legitimately stays open for minutes while the human completes it in another tab.
- Progress rides a polled side channel instead of the mux stream: `status({key})` answers with the attempt's buffered notices and its at most one pending prompt, and `answer({key, promptRpcId, value})` correlates the reply by that id. The Models page polls it on a bounded cadence while a sign-in dialog is open.
- Withdrawal has one funnel: a settled event listener rejects any open prompt of that key with `AuthorizationDeclinedError`, so endpoint cancel, caller abort, service teardown, and flow self-failure all unwind the question through the same path, and the seam folds the decline into a `cancelled` settlement rather than a failure.

On the client, the Models page joins each provider row with the flow claiming its record address (`<settingsNs>/<route>`, exactly the key `recordKeyFor` derives) and renders a sign-in control beside the API-key field whenever the joined flow ships an interactive method. The credential itself never crosses this wire in either direction: the flow writes it through `ctx.credentials` on the Host, and settlement only triggers the page's join refresh.

### Why polling, not the mux stream

The mux is the sessions' stream: one consumer owns it in the client object layer, and threading authorization frames through that layer would have coupled a settings-domain control to session transport machinery for a dialog that exists only while a user watches it. Polling keeps the authorization domain unary-only, needs no fixture/runtime changes beyond the new domain, and degrades to "no progress shown" — never to a broken attempt — if a poll fails. The cost is up to one round trip per cadence tick per open dialog, which is bounded by the one-dialog-at-a-time UX of the Models page.

## Alternatives considered

**Full duplex over `respond()`** — pending-prompt registry answered through the approvals/questions channel, prompts pushed as answerable mux frames. Rejected for v1: it adds a third registry to `respond()`'s id space and mux replay baselines, touches the runtime object layer's frame dispatch, and buys immediacy a polling dialog does not need. The unary shape does not preclude migrating later; the wire types were chosen so `status`'s prompt projection can become a frame payload unchanged.

**Per-provider OAuth in the harness** — reimplementing token exchange per company outside pi-ai. Rejected: it duplicates refresh, scope, and security ownership that the provider library already holds, contradicting the store-not-own posture the credentials family documents.

## Consequences

- Every installed provider that ships OAuth (`anthropic`, `github-copilot`, `kimi-coding`, `openai-codex`, `openrouter`, `radius`, `xai`) is now sign-in-able from the web with zero per-provider code; providers added upstream appear automatically.
- An attempt is process-local state by construction: refreshing the page mid-sign-in abandons the browser side (the Host attempt settles cancelled when its carrier signal drops), which matches the seam's existing non-durability rather than introducing a durable attempt record nobody asked for yet.
- The polled side channel is the deliberate scope cut. If a future surface needs push (for example a background re-auth), forwarding `authorization/*` frames through the mux is the recorded reintroduction path.

## Verification

- Host: `packages/host/apiproxy/tests/api-proxy-authorization.spec.ts` drives the real `AuthorizationService` over the proxy — listing, refusal mapping, notice/prompt side channel, answer correlation, endpoint cancel, caller abort, late-settle guard, and both commit-contract refusals.
- Client: `packages/client/ui-settings-models/tests/signin.client.spec.tsx` covers the control against a scripted face at 100% file coverage; `components.client.spec.tsx` covers the page-level join and the full card → begin → settle → describe-refresh loop; the connection fixture and runtime fake gained the domain.
- Keyless lanes only: `pnpm run test --run packages/host/apiproxy/tests packages/client/connection/tests packages/credentials packages/client/ui-settings-models/tests`, plus `pnpm run typecheck`.
