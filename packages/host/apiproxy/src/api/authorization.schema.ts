/**
 * authorization domain zod schemas (names derived from map keys:
 * authorizationListRequestSchema / authorizationBeginValueSchema / …).
 * The key pattern mirrors the seam's `CredentialKey` grammar — two
 * lowercase-hyphenated segments around one slash — so a malformed key fails as
 * `bad-request` before reaching the service.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  AuthorizationFlowView, AuthorizationPromptOptionView,
  AuthorizationPromptView,
} from './authorization.ts'

/** `<scope>/<id>`, each segment a lowercase hyphenated identifier. */
export const credentialKeySchema = z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)

/** One method entry of a flow view. */
const methodViewSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
})

/** AuthorizationFlowView entry of authorization.list. */
export const authorizationFlowViewSchema = z.object({
  key: credentialKeySchema,
  label: z.string().min(1),
  methods: z.array(methodViewSchema),
  inFlight: z.boolean(),
}) satisfies z.ZodType<Wire<AuthorizationFlowView>>

/** One notice of an attempt. */
const noticeViewSchema = z.object({
  message: z.string(),
  url: z.string().optional(),
  code: z.string().optional(),
})

/** One select option of a prompt. */
const promptOptionViewSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
}) satisfies z.ZodType<Wire<AuthorizationPromptOptionView>>

/** The pending-prompt projection `status` reports. */
export const authorizationPromptViewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    promptRpcId: z.string().min(1),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
  z.object({
    kind: z.literal('secret'),
    promptRpcId: z.string().min(1),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
  z.object({
    kind: z.literal('select'),
    promptRpcId: z.string().min(1),
    message: z.string(),
    options: z.array(promptOptionViewSchema).min(1),
  }),
]) satisfies z.ZodType<Wire<AuthorizationPromptView>>

/** authorization.status value. */
export const authorizationStatusValueSchema = z.object({
  attempt: z.object({
    method: z.string().min(1),
    notices: z.array(noticeViewSchema),
    prompt: authorizationPromptViewSchema.optional(),
  }).optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.status'>>>

/** authorization.list request payload. */
export const authorizationListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'authorization.list'>>>

/** authorization.list value. */
export const authorizationListValueSchema = z.object({
  flows: z.array(authorizationFlowViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.list'>>>

/** authorization.begin request payload. */
export const authorizationBeginRequestSchema = z.object({
  key: credentialKeySchema,
  method: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.begin'>>>

/** authorization.begin value. */
export const authorizationBeginValueSchema = z.object({
  status: z.union([z.literal('authorized'), z.literal('cancelled')]),
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.begin'>>>

/** authorization.cancel request payload. */
export const authorizationCancelRequestSchema = z.object({
  key: credentialKeySchema,
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.cancel'>>>

/** authorization.cancel value. */
export const authorizationCancelValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'authorization.cancel'>>>

/** authorization.status request payload. */
export const authorizationStatusRequestSchema = z.object({
  key: credentialKeySchema,
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.status'>>>

/** authorization.answer request payload. */
export const authorizationAnswerRequestSchema = z.object({
  key: credentialKeySchema,
  promptRpcId: z.string().min(1),
  value: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.answer'>>>

/** authorization.answer value. */
export const authorizationAnswerValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'authorization.answer'>>>
