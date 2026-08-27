/**
 * authorization RPC domain over createApiProxy: value-free flow listing,
 * seam-refusal mapping, notice/prompt progress through the polled side
 * channel, answer correlation, and every withdrawal path (endpoint cancel,
 * caller abort) folding into `cancelled`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { CredentialProvider, credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** Settle on the next macrotask so a begun attempt has registered its state. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** In-memory credential provider whose record half models real storage. */
class MemoryRecords extends CredentialProvider {
  private readonly values = new Map<string, string>()
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'file' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    // Post-commit verification reads this: report what the map holds.
    const configured = this.records.has(key)
    return Promise.resolve({ configured, ...configured ? { source: 'file' } : {}, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    // Enumeration carries the address and the tag, never the payload. The
    // map keys were built from branded keys, so the cast is faithful.
    return Promise.resolve(
      [...this.records.entries()].map(([key, record]) => ({ key: key as CredentialKey, kind: record.kind })),
    )
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next === undefined) this.records.delete(key)
    else this.records.set(key, next)
    // Commit observation rides this event at the seam; the storage double
    // must speak it or every attempt would read as never-committed.
    this.ctx.emit('credentials/record-updated', key)
    return next
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    this.ctx.emit('credentials/record-updated', key)
    return Promise.resolve()
  }
}

/** Harness with the real authorization service over in-memory records. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemoryRecords)
  await ctx.plugin(AuthorizationService)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  return ctx
}

/** The key every test flow writes; the shape a provider route derives. */
const KEY = credentialKey('llm-pi-ai', 'anthropic')

interface ScriptedFlow {
  /** Resolves once the flow is inside `run`. */
  entered: Promise<void>
  /** Completes the attempt: release the run and let it commit its record. */
  grant(): Promise<void>
}

/**
 * Register one oauth-method flow whose run body the test paces step by step.
 * With `prompt`, the flow first asks one text question, so a pending prompt
 * exists for the answer/withdrawal paths to exercise.
 */
function scriptFlow(ctx: Context, options: { prompt?: boolean } = {}): ScriptedFlow {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  ctx.authorization.registerFlow({
    key: KEY,
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
    async run(session) {
      enter()
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example' })
      if (options.prompt === true) await session.prompt({ kind: 'text', message: 'Paste the code' })
      await released
      session.notify({ message: 'committed' })
      await ctx.credentials.modifyRecord(KEY, () =>
        Promise.resolve({ kind: 'grant', payload: { access: 'at' } }))
    },
  })
  return {
    entered,
    grant: async (): Promise<void> => {
      release()
      await tick()
    },
  }
}

describe('authorization domain', () => {
  it('answers list with an internal report when no service is mounted', async () => {
    const bare = new Context()
    await bare.plugin(SessionStore)
    await bare.plugin(SystemPrompt, { persona: '' })
    await bare.plugin(ToolRuntime)
    await bare.plugin(UserQuestionService)
    await bare.plugin(AgentRegistry)
    await bare.plugin(LlmRuntime)
    bare.provide('workspaceRegistry', { list: () => [] } as never)
    const api = createApiProxy(bare, DEFAULTS)
    const error = expectErr(await api.authorization.list(request({})))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('dsh-authorization')
  })

  it('lists registered flows with their methods and live state', async () => {
    const ctx = await harness()
    scriptFlow(ctx)
    const api = createApiProxy(ctx, DEFAULTS)

    expect(expectOk(await api.authorization.list(request({})))).toEqual({
      flows: [{
        key: KEY,
        label: 'Anthropic',
        methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
        inFlight: false,
      }],
    })
  })

  it('maps unknown-key and unknown-method refusals onto authorization-rejected', async () => {
    const ctx = await harness()
    scriptFlow(ctx)
    const api = createApiProxy(ctx, DEFAULTS)

    const noFlow = expectErr(await api.authorization.begin(
      request({ key: 'llm-pi-ai/openai-codex' }), new AbortController().signal,
    ))
    expect(noFlow.code).toBe('authorization-rejected')
    expect(noFlow.details).toEqual({ key: 'llm-pi-ai/openai-codex', reason: 'NO_FLOW' })

    const badMethod = expectErr(await api.authorization.begin(
      request({ key: KEY, method: 'device' }), new AbortController().signal,
    ))
    expect(badMethod.details).toEqual({ key: KEY, reason: 'UNKNOWN_METHOD' })
  })

  it('reports notices through status while the attempt runs, then clears', async () => {
    const ctx = await harness()
    const flow = scriptFlow(ctx)
    const api = createApiProxy(ctx, DEFAULTS)

    const pending = api.authorization.begin(request({ key: KEY }), new AbortController().signal)
    await flow.entered

    const running = expectOk(await api.authorization.status(request({ key: KEY })))
    expect(running.attempt?.method).toBe('oauth')
    expect(running.attempt?.notices).toEqual([{
      message: 'Continue in your browser',
      url: 'https://auth.example',
    }])
    expect(running.attempt?.prompt).toBeUndefined()

    await flow.grant()
    expect(expectOk(await pending).status).toBe('authorized')
    // Settlement clears the record even though the final notice raced it.
    expect(expectOk(await api.authorization.status(request({ key: KEY }))).attempt).toBeUndefined()
    await expect(ctx.credentials.readRecord(KEY)).resolves.toEqual({
      kind: 'grant',
      payload: { access: 'at' },
    })
  })

  it('carries a pending prompt through status and answers it by rpcId', async () => {
    const ctx = await harness()
    const flow = scriptFlow(ctx, { prompt: true })
    const api = createApiProxy(ctx, DEFAULTS)

    const pending = api.authorization.begin(request({ key: KEY }), new AbortController().signal)
    await flow.entered
    await tick()

    const asked = expectOk(await api.authorization.status(request({ key: KEY })))
    const prompt = asked.attempt?.prompt
    expect(prompt).toMatchObject({ kind: 'text', message: 'Paste the code' })
    expect(prompt?.promptRpcId).toBeTruthy()

    expectOk(await api.authorization.answer(
      request({ key: KEY, promptRpcId: prompt?.promptRpcId ?? '', value: 'typed-code' }),
    ))
    await flow.grant()
    expect(expectOk(await pending).status).toBe('authorized')

    // The answered id is spent: replaying it names no pending prompt.
    const replay = expectErr(await api.authorization.answer(
      request({ key: KEY, promptRpcId: prompt?.promptRpcId ?? '', value: 'again' }),
    ))
    expect(replay.code).toBe('authorization-not-pending')
  })

  it('refuses an answer whose key does not match the pending prompt', async () => {
    const ctx = await harness()
    const flow = scriptFlow(ctx, { prompt: true })
    const api = createApiProxy(ctx, DEFAULTS)

    const pending = api.authorization.begin(request({ key: KEY }), new AbortController().signal)
    await flow.entered
    await tick()
    const asked = expectOk(await api.authorization.status(request({ key: KEY })))

    const mismatch = expectErr(await api.authorization.answer(
      request({
        key: 'llm-pi-ai/openai-codex',
        promptRpcId: asked.attempt?.prompt?.promptRpcId ?? '',
        value: 'x',
      }),
    ))
    expect(mismatch.code).toBe('authorization-not-pending')

    // The mismatched answer left the prompt intact: cancelling unwinds cleanly.
    expectOk(await api.authorization.cancel(request({ key: KEY })))
    expect(expectOk(await pending).status).toBe('cancelled')
  })

  it('withdraws the open prompt when the endpoint cancels the attempt', async () => {
    const ctx = await harness()
    const flow = scriptFlow(ctx, { prompt: true })
    const api = createApiProxy(ctx, DEFAULTS)

    const pending = api.authorization.begin(request({ key: KEY }), new AbortController().signal)
    await flow.entered
    await tick()

    expectOk(await api.authorization.cancel(request({ key: KEY })))
    expect(expectOk(await pending).status).toBe('cancelled')
    expect(expectOk(await api.authorization.status(request({ key: KEY }))).attempt).toBeUndefined()
  })

  it('withdraws the open prompt when the caller aborts begin', async () => {
    const ctx = await harness()
    const flow = scriptFlow(ctx, { prompt: true })
    const api = createApiProxy(ctx, DEFAULTS)
    const controller = new AbortController()

    const pending = api.authorization.begin(request({ key: KEY }), controller.signal)
    await flow.entered
    await tick()
    controller.abort()

    expect(expectOk(await pending).status).toBe('cancelled')
  })

  it('refuses a second begin while one attempt holds the key', async () => {
    const ctx = await harness()
    const flow = scriptFlow(ctx)
    const api = createApiProxy(ctx, DEFAULTS)

    const first = api.authorization.begin(request({ key: KEY }), new AbortController().signal)
    await flow.entered

    const second = expectErr(await api.authorization.begin(
      request({ key: KEY }), new AbortController().signal,
    ))
    expect(second.details).toEqual({ key: KEY, reason: 'ALREADY_IN_FLIGHT' })

    expectOk(await api.authorization.cancel(request({ key: KEY })))
    expect(expectOk(await first).status).toBe('cancelled')
  })

  it('surfaces a flow that commits nothing as NOT_COMMITTED', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Anthropic',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      // Resolves without ever touching the record store.
      run: () => Promise.resolve(),
    })
    const api = createApiProxy(ctx, DEFAULTS)

    const refused = expectErr(await api.authorization.begin(
      request({ key: KEY }), new AbortController().signal,
    ))
    expect(refused.details).toEqual({ key: KEY, reason: 'NOT_COMMITTED' })
    // The failed attempt still cleared the polled record.
    expect(expectOk(await api.authorization.status(request({ key: KEY }))).attempt).toBeUndefined()
  })

  it('keeps the record grammar derivation the docs describe', () => {
    // The UI derives `<settingsNs>/<route>`; both segments satisfy the same
    // lowercase-hyphenated grammar the schema pins.
    expect(credentialRef('ANTHROPIC_API_KEY')).toBe('ANTHROPIC_API_KEY')
    expect(credentialKey('llm-pi-ai', 'anthropic')).toBe(KEY)
  })
})
