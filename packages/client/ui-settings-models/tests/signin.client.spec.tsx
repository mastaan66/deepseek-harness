// @vitest-environment jsdom
/** SignInControl behavior over a scripted authorization face, plus the store's flow join. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthorizationFlowView, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { SignInControl } from '../src/client/SignInControl.tsx'
import type { SignInControlProps } from '../src/client/SignInControl.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { en } from '../src/client/locales.ts'
import Schema from '@deepseek-ai/schemastery'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `r-${nextRpc++}` as never,
    result: { ok: false, error: { code: 'authorization-rejected', message, details: { key: 'k', reason: 'NO_FLOW' } } as never },
  }
}

const OAUTH_FLOW: AuthorizationFlowView = {
  key: 'llm-pi-ai/anthropic',
  label: 'Anthropic',
  methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }, { id: 'api-key', label: 'API key' }],
  inFlight: false,
}

interface FaceOverrides {
  begin?: (payload: { key: string; method?: string }) => Promise<RpcResponse<{ status: 'authorized' | 'cancelled' }>>
  status?: () => Promise<RpcResponse<{
    attempt?: { method: string; notices: { message: string; url?: string; code?: string }[]; prompt?: unknown }
  }>>
  answer?: (payload: { key: string; promptRpcId: string; value: string }) => Promise<RpcResponse<{}>>
  cancel?: () => Promise<RpcResponse<{}>>
}

function face(overrides: FaceOverrides = {}): Pick<IApiClient, 'authorization'> & {
  begin: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  answer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  const begin = vi.fn(overrides.begin ?? (() => Promise.resolve(ok({ status: 'authorized' as const }))))
  const status = vi.fn(overrides.status ?? (() => Promise.resolve(ok({}))))
  const answer = vi.fn(overrides.answer ?? (() => Promise.resolve(ok({}))))
  const cancel = vi.fn(overrides.cancel ?? (() => Promise.resolve(ok({}))))
  return {
    begin, status, answer, cancel,
    authorization: { list: () => Promise.resolve(ok({ flows: [] })), begin, cancel, status, answer },
  } as never
}

function mount(api: ReturnType<typeof face>, overrides: Partial<SignInControlProps> = {}) {
  const onSettled = vi.fn()
  render(
    <SignInControl
      flow={OAUTH_FLOW}
      api={api as never}
      t={key => en[key]}
      onSettled={onSettled}
      pollMs={5}
      {...overrides}
    />,
  )
  return { api, onSettled }
}

describe('SignInControl', () => {
  it('renders one button per oauth method and nothing while idle', async () => {
    const { api } = mount(face())
    const button = screen.getByRole('button', { name: 'Sign in with Anthropic' })
    expect(button).toBeTruthy()
    // The api-key method stays the editor's key field's job.
    expect(screen.queryByRole('button', { name: 'API key' })).toBeNull()
    await waitFor(() => { expect(api.begin).not.toHaveBeenCalled() })
  })

  it('renders nothing when the flow ships no interactive method', () => {
    render(
      <SignInControl
        flow={{ ...OAUTH_FLOW, methods: [{ id: 'api-key', label: 'API key' }] }}
        api={face() as never}
        t={key => en[key]}
        onSettled={() => {}}
      />,
    )
    expect(document.querySelector('.signinBlock')).toBeNull()
  })

  it('begins with the flow key and method, shows progress, and settles', async () => {
    // Held settlement: the notice assertions run while the attempt is still
    // open, so nothing depends on how the poll cadence races the resolver.
    let release!: (response: RpcResponse<{ status: 'authorized' | 'cancelled' }>) => void
    const { api, onSettled } = mount(face({
      begin: () => new Promise((resolve) => { release = resolve }),
      status: () => Promise.resolve(ok({
        attempt: {
          method: 'oauth',
          notices: [{ message: 'Continue in your browser', url: 'https://auth.example', code: 'WXYZ' }],
        },
      })),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    await waitFor(() => { expect(api.begin).toHaveBeenCalledWith({ key: OAUTH_FLOW.key, method: 'oauth' }) })

    // The polled side channel carries the notice through to the surface.
    await screen.findByText('Continue in your browser')
    expect(screen.getByText('WXYZ')).toBeTruthy()
    expect(screen.getByText(en.authOpen).getAttribute('href')).toBe('https://auth.example')

    release(ok({ status: 'authorized' }))
    await waitFor(() => { expect(onSettled).toHaveBeenCalledOnce() })
    // Back to the entry buttons after settlement.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Sign in with Anthropic' })).toBeTruthy() })
  }, 10000)

  it('ignores a settlement that lands after the user cancelled, either way', async () => {
    let release!: (response: RpcResponse<{ status: 'authorized' | 'cancelled' }>) => void
    let reject!: (error: Error) => void
    const { onSettled } = mount(face({
      begin: () => new Promise((resolve, rej) => {
        release = resolve
        reject = rej
      }),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    await waitFor(() => { expect(screen.getByText(en.authCancel)).toBeTruthy() })
    fireEvent.click(screen.getByText(en.authCancel))
    await waitFor(() => { expect(onSettled).toHaveBeenCalledOnce() })

    // The withdrawn attempt's late REJECTION is its first settlement, yet
    // still a no-op on screen: no error copy resurrects a control the user
    // already left, and no second settle fires.
    reject(new Error('boom'))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(onSettled).toHaveBeenCalledOnce()
    expect(screen.queryByText('boom')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in with Anthropic' })).toBeTruthy()
    void release
  }, 10000)

  it('surfaces a business refusal from begin as card error copy', async () => {
    const { onSettled } = mount(face({
      begin: () => Promise.resolve(fail('an authorization attempt is already running')),
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    await waitFor(() => { expect(screen.getByText(/already running/)).toBeTruthy() })
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('surfaces a transport rejection without losing the control', async () => {
    let calls = 0
    const { api } = mount(face({
      begin: () => {
        calls++
        // First click fails with an Error, second with a bare string: the
        // card renders whatever the carrier threw, either way.
        return Promise.reject(calls === 1 ? new Error('connection lost') : 'bare refusal')
      },
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    await waitFor(() => { expect(screen.getByText('connection lost')).toBeTruthy() })

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Anthropic' }))
    await waitFor(() => { expect(api.authorization.begin).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.getByText('bare refusal')).toBeTruthy() })
  })

  it('answers a pending text prompt by its rpcId and settles authorized', async () => {
    let answered: { promptRpcId: string; value: string } | undefined
    let release!: (response: RpcResponse<{ status: 'authorized' | 'cancelled' }>) => void
    const { api, onSettled } = mount(face({
      begin: () => new Promise((resolve) => { release = resolve }),
      status: () => Promise.resolve(ok({
        attempt: {
          method: 'oauth',
          notices: [],
          prompt: { kind: 'text', promptRpcId: 'pp-1', message: 'Paste the code', placeholder: 'ac#…' },
        },
      })),
      answer: (payload) => {
        answered = payload
        return Promise.resolve(ok({}))
      },
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    const input = await screen.findByLabelText('Paste the code')
    expect((input as HTMLInputElement).type).toBe('text')

    // Empty answers stay disabled; typing enables submit.
    const submit = screen.getByText(en.authSubmit) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '  ac-code  ' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => {
      expect(answered).toEqual({ key: OAUTH_FLOW.key, promptRpcId: 'pp-1', value: 'ac-code' })
    })
    release(ok({ status: 'authorized' }))
    await waitFor(() => { expect(onSettled).toHaveBeenCalledOnce() })
    void api
  }, 10000)

  it('submits a text prompt from the Enter key and surfaces a refused answer', async () => {
    const { api } = mount(face({
      begin: () => new Promise(() => { /* stays open while the question waits */ }),
      status: () => Promise.resolve(ok({
        attempt: {
          method: 'oauth',
          notices: [],
          prompt: { kind: 'secret', promptRpcId: 'pp-secret', message: 'Paste the token' },
        },
      })),
      answer: () => Promise.resolve(fail('that code was refused')),
    }), {})

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    const input = await screen.findByLabelText('Paste the token')
    // The secret spelling masks the value but answers like any other prompt.
    expect((input as HTMLInputElement).type).toBe('password')
    // An empty answer is a no-op even on Enter, and other keys never submit.
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(api.authorization.answer).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'tok' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByText('that code was refused')).toBeTruthy() })
  }, 10000)

  it('falls back to plain copy when a rejected answer carries no message', async () => {
    mount(face({
      begin: () => new Promise(() => { /* stays open */ }),
      status: () => Promise.resolve(ok({
        attempt: {
          method: 'oauth',
          notices: [],
          prompt: { kind: 'text', promptRpcId: 'pp-3', message: 'Paste the code' },
        },
      })),
      answer: () => Promise.reject(new Error('down')),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    const input = await screen.findByLabelText('Paste the code')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: en.authSubmit }))
    await waitFor(() => { expect(screen.getByText(en.answerFailed)).toBeTruthy() })
  }, 10000)

  it('answers a select prompt immediately from its options', async () => {
    const answer = vi.fn(() => Promise.resolve(ok({})))
    let release!: (response: RpcResponse<{ status: 'authorized' | 'cancelled' }>) => void
    mount(face({
      begin: () => new Promise((resolve) => { release = resolve }),
      status: () => Promise.resolve(ok({
        attempt: {
          method: 'oauth',
          notices: [],
          prompt: {
            kind: 'select',
            promptRpcId: 'pp-2',
            message: 'Which account?',
            options: [{ id: 'work', label: 'Work' }],
          },
        },
      })),
      answer,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    const select = await screen.findByLabelText('Which account?') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'work' } })
    await waitFor(() => {
      expect(answer).toHaveBeenCalledWith({ key: OAUTH_FLOW.key, promptRpcId: 'pp-2', value: 'work' })
    })
    release(ok({ status: 'cancelled' }))
  }, 10000)

  it('swallows transport failures from a select answer and from cancel', async () => {
    const { api } = mount(face({
      begin: () => new Promise(() => { /* stays open */ }),
      status: () => Promise.resolve(ok({
        attempt: {
          method: 'oauth',
          notices: [],
          prompt: {
            kind: 'select',
            promptRpcId: 'pp-drop',
            message: 'Which account?',
            options: [{ id: 'work', label: 'Work' }],
          },
        },
      })),
      answer: () => Promise.reject(new Error('socket gone')),
      cancel: () => Promise.reject(new Error('socket gone')),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    const select = await screen.findByLabelText('Which account?') as HTMLSelectElement
    // A dropped answer must neither crash nor fake success.
    fireEvent.change(select, { target: { value: 'work' } })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(screen.queryByText('socket gone')).toBeNull()

    fireEvent.click(screen.getByText(en.authCancel))
    await waitFor(() => { expect(api.cancel).toHaveBeenCalled() })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Sign in with Anthropic' })).toBeTruthy() })
  }, 10000)

  it('takes the production poll cadence and keeps past notices when none arrive', async () => {
    let reporting = true
    let release!: (response: RpcResponse<{ status: 'authorized' | 'cancelled' }>) => void
    // No pollMs override: this is the one run that exercises the default
    // cadence end to end, so it costs about two real ticks.
    const { api, onSettled } = mount(face({
      begin: () => new Promise((resolve) => { release = resolve }),
      status: () => Promise.resolve(ok(reporting
        ? { attempt: { method: 'oauth', notices: [{ message: 'waiting' }] } }
        : {})),
    }), { pollMs: undefined })

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    await screen.findByText('waiting', {}, { timeout: 5000 })

    reporting = false
    await new Promise((resolve) => { setTimeout(resolve, 1500) })
    // An attempt-shaped-but-empty answer keeps what was already shown.
    expect(screen.getByText('waiting')).toBeTruthy()

    release(ok({ status: 'cancelled' }))
    await waitFor(() => { expect(onSettled).toHaveBeenCalledOnce() })
    void api
  }, 10000)

  it('cancels an open attempt and returns to the buttons', async () => {
    let release!: (response: RpcResponse<{ status: 'authorized' | 'cancelled' }>) => void
    const { api, onSettled } = mount(face({
      begin: () => new Promise((resolve) => { release = resolve }),
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    await waitFor(() => { expect(screen.getByText(en.signingIn)).toBeTruthy() })

    fireEvent.click(screen.getByText(en.authCancel))
    await waitFor(() => { expect(api.cancel).toHaveBeenCalledWith({ key: OAUTH_FLOW.key }) })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Sign in with Anthropic' })).toBeTruthy() })

    // The attempt's own settlement lands after the withdrawal: it must not
    // report a second settling or touch the withdrawn state.
    release(ok({ status: 'cancelled' }))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(onSettled).toHaveBeenCalledOnce()
  }, 10000)

  it('keeps the attempt usable when a status poll rejects mid-flight', async () => {
    let polls = 0
    mount(face({
      begin: () => new Promise((resolve) => {
        setTimeout(() => resolve(ok({ status: 'cancelled' as const })), 25)
      }),
      status: () => {
        polls++
        return polls === 1 ? Promise.reject(new Error('down')) : Promise.resolve(ok({}))
      },
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Anthropic' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Sign in with Anthropic' })).toBeTruthy() }, { timeout: 5000 })
    expect(polls).toBeGreaterThanOrEqual(1)
  }, 10000)
})

describe('ModelsSettingsStore flow join', () => {
  const NAMESPACE: SettingsNamespaceView = {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(Schema.object({
      providers: Schema.dict(Schema.object({ apiKeyEnv: Schema.string().role('credential-ref') })).default({}),
    }).toJSON())) as unknown,
    value: {},
    applies: 'live',
    secrets: [],
    revision: 0,
  }

  function storeFace(flows: AuthorizationFlowView[]) {
    return {
      llm: {
        providers: vi.fn(() => Promise.resolve(ok({
          providers: [
            {
              provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai',
              settingsPath: ['providers', 'anthropic'], active: false,
            },
          ],
        }))),
        models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))),
      },
      settings: { describe: vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [NAMESPACE] }))) },
      credentials: { describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))) },
      authorization: { list: vi.fn(() => Promise.resolve(ok({ flows }))) },
    }
  }

  it('joins each row with the flow claiming its record address', async () => {
    const scripted = storeFace([OAUTH_FLOW])
    const mirror = new SettingsDescribeMirror(scripted as never)
    const controller = new ModelsSettingsStore(
      scripted as unknown as ConstructorParameters<typeof ModelsSettingsStore>[0], settingsSchema, mirror,
    )
    await controller.load()

    const [row] = controller.store.getSnapshot().rows
    expect(row?.flow?.key).toBe(OAUTH_FLOW.key)
  })

  it('renders rows without a flow when the face fails or lists nothing', async () => {
    for (const list of [
      (): Promise<RpcResponse<{ flows: AuthorizationFlowView[] }>> => Promise.reject(new Error('down')),
      (): Promise<RpcResponse<{ flows: AuthorizationFlowView[] }>> => Promise.resolve(fail('absent') as never),
    ]) {
      const scripted = storeFace([])
      scripted.authorization.list = list as never
      const mirror = new SettingsDescribeMirror(scripted as never)
      const controller = new ModelsSettingsStore(
        scripted as unknown as ConstructorParameters<typeof ModelsSettingsStore>[0], settingsSchema, mirror,
      )
      await controller.load()
      expect(controller.store.getSnapshot().rows[0]?.flow).toBeUndefined()
      // The page itself stays ready — sign-in is enrichment, not a gate.
      expect(controller.store.getSnapshot().status).toBe('ready')
    }
  })
})
