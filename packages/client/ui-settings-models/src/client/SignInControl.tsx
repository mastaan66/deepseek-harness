/**
 * One provider's interactive sign-in control: starts an authorization flow
 * method, streams its progress through the polled `authorization.status`
 * side channel (notices, then at most one open question), answers that
 * question by its correlation id, and withdraws on cancel. The credential
 * itself never passes through here — the Host-side flow writes it through
 * `ctx.credentials`, so settlement only means the page's join refreshes.
 *
 * Polling (rather than a stream) is deliberate for this surface: the attempt
 * exists only while this control is mounted and the user is watching it, the
 * cadence is bounded, and it keeps the authorization domain unary-only.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AuthorizationFlowView, AuthorizationPromptView, IApiClient,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Default cadence for polling the Host while an attempt is open. */
const DEFAULT_POLL_MS = 1200

/** One progress report, as the status poll delivers it. */
interface NoticeView {
  message: string
  url?: string
  code?: string
}

interface AttemptState {
  running: boolean
  notices: readonly NoticeView[]
  prompt: AuthorizationPromptView | undefined
  answer: string
  error: string | undefined
}

const IDLE: AttemptState = { running: false, notices: [], prompt: undefined, answer: '', error: undefined }

/** Props of {@link SignInControl}. */
export interface SignInControlProps {
  /** The flow to drive; only methods with id `oauth` render as buttons. */
  flow: AuthorizationFlowView
  /** Wire face for the authorization calls this control drives. */
  api: Pick<IApiClient, 'authorization'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or busy editor). */
  disabled?: boolean
  /** Poll cadence override; production callers take the default. */
  pollMs?: number | undefined
  /** Called once an attempt settles, whatever the outcome. */
  onSettled: () => void
}

/**
 * Render one provider's sign-in buttons and, while an attempt is open, its
 * live progress.
 * @param props - the flow, wire face, copy, and settle callback.
 * @returns the control, or nothing when no OAuth method exists.
 */
export function SignInControl(props: SignInControlProps): ReactNode {
  const { flow, api, t } = props
  const oauthMethods = flow.methods.filter(method => method.id === 'oauth')
  const [state, setState] = useState<AttemptState>(IDLE)
  const [starting, setStarting] = useState(false)
  // The poll loop and the settlement guard read latest state without
  // re-subscribing per render.
  const attemptRef = useRef<{ key: string } | undefined>(undefined)

  useEffect(() => () => { attemptRef.current = undefined }, [])

  if (oauthMethods.length === 0) return null

  const pollMs = (): number => props.pollMs ?? DEFAULT_POLL_MS

  const poll = async (key: string): Promise<void> => {
    while (attemptRef.current?.key === key) {
      await new Promise((resolve) => { setTimeout(resolve, pollMs()) })
      if (attemptRef.current?.key !== key) return
      const response = await api.authorization.status({ key }).catch(() => undefined)
      if (response === undefined || !response.result.ok || attemptRef.current?.key !== key) return
      const attempt = response.result.value.attempt
      setState(current => ({
        ...current,
        ...attempt === undefined ? {} : {
          notices: attempt.notices,
          prompt: 'prompt' in attempt ? attempt.prompt : undefined,
        },
      }))
    }
  }

  const start = async (methodId: string): Promise<void> => {
    setStarting(true)
    setState({ ...IDLE, running: true })
    const key = flow.key
    attemptRef.current = { key }
    void poll(key)
    // Whether this attempt is still the one the control shows: a cancel
    // clears the ref, so a late settlement must neither touch state nor
    // report a settling the user already withdrew.
    const live = (): boolean => attemptRef.current?.key === key
    try {
      const response = await api.authorization.begin({ key, method: methodId })
      if (!live()) return
      if (response.result.ok) {
        setState({ ...IDLE })
        props.onSettled()
      } else {
        // A refused attempt is over: back to the entry buttons with the
        // reason shown, ready for another click.
        attemptRef.current = undefined
        setState({ ...IDLE, error: response.result.error.message })
      }
    } catch (error) {
      if (!live()) return
      attemptRef.current = undefined
      setState({ ...IDLE, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (live()) attemptRef.current = undefined
      setStarting(false)
    }
  }

  const cancel = async (): Promise<void> => {
    attemptRef.current = undefined
    setStarting(false)
    setState(IDLE)
    await api.authorization.cancel({ key: flow.key }).catch(() => undefined)
    props.onSettled()
  }

  const submitAnswer = async (promptRpcId: string): Promise<void> => {
    const value = state.answer.trim()
    if (value.length === 0) return
    setState(current => ({ ...current, prompt: undefined, answer: '' }))
    const response = await api.authorization.answer({
      key: flow.key, promptRpcId, value,
    }).catch(() => undefined)
    if (response === undefined || !response.result.ok) {
      setState(current => ({
        ...current,
        error: response?.result.ok === false ? response.result.error.message : t('answerFailed'),
      }))
    }
  }

  const latest = state.notices.at(-1)
  const prompt = state.prompt
  return (
    <div className={styles['signinBlock']}>
      {state.running
        ? (
          <>
            <span className={styles['signinStatus']}>
              {latest === undefined ? t('signingIn') : latest.message}
              {' '}
              {latest?.code === undefined ? null : <code>{latest.code}</code>}
            </span>
            {latest?.url === undefined
              ? null
              : (
                <a className={styles['signinLink']} href={latest.url} target="_blank" rel="noreferrer">
                  {t('authOpen')}
                </a>
              )}
            {prompt === undefined
              ? null
              : (
                <div className={styles['signinPrompt']}>
                  <label className={styles['fieldLabel']} htmlFor={`auth-prompt-${flow.key}`}>{prompt.message}</label>
                  {prompt.kind === 'select'
                    ? (
                      <select
                        id={`auth-prompt-${flow.key}`}
                        className={`${styles['input']} ${styles['selectInput']}`}
                        value=""
                        onChange={(event) => {
                          const value = event.target.value
                          setState(current => ({ ...current, prompt: undefined, answer: '' }))
                          void api.authorization.answer({
                            key: flow.key, promptRpcId: prompt.promptRpcId, value,
                          }).catch(() => undefined)
                        }}
                      >
                        <option value="" disabled>—</option>
                        {prompt.options.map(option => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                    )
                    : (
                      <input
                        id={`auth-prompt-${flow.key}`}
                        className={styles['input']}
                        type={prompt.kind === 'secret' ? 'password' : 'text'}
                        autoComplete="off"
                        value={state.answer}
                        placeholder={prompt.placeholder}
                        aria-label={prompt.message}
                        onChange={(event) => { setState(current => ({ ...current, answer: event.target.value })) }}
                        onKeyDown={(event) => { if (event.key === 'Enter') void submitAnswer(prompt.promptRpcId) }}
                      />
                    )}
                  {prompt.kind === 'select'
                    ? null
                    : (
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        aria-label={t('authSubmit')}
                        disabled={state.answer.trim().length === 0}
                        onClick={() => { void submitAnswer(prompt.promptRpcId) }}
                      >
                        {t('authSubmit')}
                      </button>
                    )}
                </div>
              )}
            <button
              type="button"
              className={styles['dangerButton']}
              onClick={() => { void cancel() }}
            >
              {t('authCancel')}
            </button>
          </>
        )
        : oauthMethods.map(method => (
          <button
            key={method.id}
            type="button"
            className={styles['secondaryButton']}
            disabled={props.disabled === true || starting}
            onClick={() => { void start(method.id) }}
          >
            {/* The flow's own label is the full call to action ('Sign in
                with …'); while an attempt runs this list is replaced by the
                progress view, so the busy state lives there alone. */}
            {method.label}
          </button>
        ))}
      {state.error === undefined ? null : <p className={styles['error']}>{state.error}</p>}
    </div>
  )
}
