/**
 * authorization domain contract: the web face of the authorization seam
 * (`ctx.authorization`). The value-free posture matches credentials: a flow
 * view names what can be authorized and how, never a token; prompts travel to
 * the browser and answers travel back, and the credential itself is written by
 * the owning flow through `ctx.credentials` on the Host, so no secret crosses
 * this wire in either direction.
 *
 * `begin` resolves only at settlement — an OAuth attempt stays open while the
 * human completes it in another tab — so its carrier call runs without the
 * unary deadline. Progress (notices, one pending prompt at a time) rides the
 * polled `status` side channel instead of the mux stream, keeping this domain
 * unary-only; a sign-in dialog polls it while its attempt is open.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One way a flow can obtain its credential, as the seam declares it. */
export interface AuthorizationMethodView {
  /** Flow-owned identifier, echoed back when beginning with this method. */
  id: string
  /** Label for the picker or button that starts this method. */
  label: string
}

/** Wire view of one registered authorization flow. */
export interface AuthorizationFlowView {
  /**
   * The credential record this flow writes (`<scope>/<id>`); the same key a
   * configuration surface derives from a provider's settings address.
   */
  key: string
  /** User-facing name of what is being authorized. */
  label: string
  /** The offered methods, most preferred first. */
  methods: readonly AuthorizationMethodView[]
  /** Whether an attempt for this key is running right now. */
  inFlight: boolean
}

/** One progress report from a running attempt. Never carries a secret. */
export interface AuthorizationNoticeView {
  /** What is happening, or what the human must do next. */
  message: string
  /** A page the human must open to continue. */
  url?: string
  /** A short code the human must enter on that page. */
  code?: string
}

/** One selectable option of a `select` prompt. */
export interface AuthorizationPromptOptionView {
  /** Value returned when this option is chosen. */
  id: string
  /** User-facing label. */
  label: string
}

/** One question the running attempt needs answered before it can continue. */
export type AuthorizationPromptView = {
  /** The pending question's correlation id; echo it in `authorization.answer`. */
  promptRpcId: string
} & ({
  kind: 'text' | 'secret'
  message: string
  placeholder?: string
} | {
  kind: 'select'
  message: string
  options: readonly AuthorizationPromptOptionView[]
})

/** The observed state of one key's attempt, as `status` reports it. */
export interface AuthorizationAttemptView {
  /** The method id the attempt was begun with. */
  method: string
  /** Every notice so far, in arrival order. */
  notices: readonly AuthorizationNoticeView[]
  /** The question awaiting an answer, when one is pending. */
  prompt?: AuthorizationPromptView
}

/** Authorization-domain unary methods (the map keys authorization.* of RpcMethodMap). */
export interface AuthorizationApi {
  /**
   * List every registered flow, in registration order. Absent service answers
   * `internal` naming the missing plugin, like the credentials domain.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ flows: readonly AuthorizationFlowView[] }>>

  /**
   * Run one attempt to obtain and commit the named flow's credential.
   * Resolves `{ status: 'authorized' }` once the record is committed, or
   * `{ status: 'cancelled' }` when the human declined or the caller withdrew;
   * every other failure is a thrown-seam refusal mapped to
   * `authorization-rejected` with the seam's own code in `details.reason`.
   */
  begin(
    request: RpcRequest<{ key: string; method?: string }>, signal: AbortSignal,
  ): Promise<RpcResponse<{ status: 'authorized' | 'cancelled' }>>

  /**
   * Withdraw the attempt running for a key, if any. Idempotent: cancelling a
   * key with nothing in flight succeeds.
   */
  cancel(request: RpcRequest<{ key: string }>): Promise<RpcResponse<{}>>

  /**
   * Read one key's current attempt: notices so far and any pending prompt.
   * No attempt in flight answers `{}`. This is the polling side channel of an
   * open `begin`; it reads process state and never blocks.
   */
  status(request: RpcRequest<{ key: string }>): Promise<RpcResponse<{ attempt?: AuthorizationAttemptView }>>

  /**
   * Answer one pending prompt. An unknown or already-answered `promptRpcId`,
   * or a key mismatch, is refused with `not-pending`.
   */
  answer(
    request: RpcRequest<{ key: string; promptRpcId: string; value: string }>,
  ): Promise<RpcResponse<{}>>
}
