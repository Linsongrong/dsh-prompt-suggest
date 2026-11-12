/**
 * dsh-prompt-suggest — host half.
 *
 * Serves one same-origin JSON endpoint the browser half polls:
 *   POST /api/prompt-suggest {method:'get', sessionId}
 *     -> { ok, candidates: string[], pending?, code? }
 *   POST /api/prompt-suggest {method:'diag', payload}
 *   POST /api/prompt-suggest {method:'diag-get'}
 *   POST /api/prompt-suggest {method:'probe', sessionId}   (structure introspection)
 *
 * Candidate generation is pull-based: the browser asks when the composer is
 * idle and empty; the host caches one result per completed turn, so repeated
 * polls cost nothing until a new turn finishes.
 */
import { randomUUID } from 'node:crypto'

const ROUTE_PATH = '/api/prompt-suggest'
const MAX_TURNS = 6
const MAX_TURN_CHARS = 1500
const TIMEOUT_MS = 30000
const MAX_OUTPUT_TOKENS = 600
const CANDIDATE_COUNT = 1

function service(ctx, name) {
  return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
}

function textOfMessage(message) {
  if (!message) return ''
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function turnsOf(events) {
  if (!Array.isArray(events)) return []
  const turns = []
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'user/message') {
      const text = textOfMessage(event.data)
      if (text !== '') turns.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data && event.data.message)
      if (text !== '') turns.push({ role: 'assistant', text })
    }
  }
  return turns
}

function lastTurnEnd(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'turn/end') return event
  }
  return undefined
}

/**
 * The turn/end that is still the newest activity. A later user/message means a
 * new turn has started (including Harness-injected context), so any prediction
 * cached for the previous turn is stale and must not be served.
 */
function idleTurnEnd(events) {
  if (!Array.isArray(events)) return undefined
  let end
  let superseded = false
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'turn/end') {
      end = event
      superseded = false
    } else if (event.type === 'user/message') {
      superseded = true
    }
  }
  return end && !superseded ? end : undefined
}

/**
 * Live sessions and persisted snapshots expose the event log differently
 * across Harness builds, so read it through every known door and take the
 * first non-empty answer.
 */
async function readEvents(ctx, sessionId, session) {
  if (session && Array.isArray(session.events) && session.events.length > 0) {
    return { source: 'session.events', events: session.events }
  }
  const query = service(ctx, 'sessionQuery')
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot && Array.isArray(snapshot.events) && snapshot.events.length > 0) {
        return { source: 'sessionQuery.readSession', events: snapshot.events }
      }
      return {
        source: 'sessionQuery.readSession',
        events: snapshot && Array.isArray(snapshot.events) ? snapshot.events : [],
        empty: true,
      }
    } catch (error) {
      return { source: 'sessionQuery.readSession', events: [], error: error && error.message }
    }
  }
  return { source: 'none', events: [] }
}

/**
 * Sent prompts of one Session, newest first, for ArrowUp recall. Reads the
 * same event log as generation, so no extra index or storage is needed.
 */
async function readHistory(ctx, sessionId, limit) {
  const sessions = service(ctx, 'sessions')
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  const read = await readEvents(ctx, sessionId, session)
  const prompts = []
  for (const event of read.events) {
    if (!event || event.type !== 'user/message') continue
    const data = event.data
    // Harness injects context as user/message too (runtime context, time
    // context, skill catalog, mnemon snapshots). Only real keystrokes carry
    // source.kind === 'user'; anything else must never be recalled.
    const source = data && data.source
    if (source && typeof source.kind === 'string' && source.kind !== 'user') continue
    const text = textOfMessage(data)
    // Delegated run data from other plugins (mnemon document archive and the
    // like) arrives with source.kind === 'user' but is not a keystroke.
    if (/^\[dsh-[^\]]*:delegated[^\]]*\]/.test(text)) continue
    if (text !== '') prompts.push(text)
  }
  const out = []
  for (let index = prompts.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const text = prompts[index].slice(0, 4000)
    if (out[out.length - 1] !== text) out.push(text)
  }
  return out
}

function clip(text) {
  return text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}…` : text
}

function systemPrompt() {
  return [
    'You predict the single next message a human will send to their coding agent, from the human side only.',
    'Read the recent conversation and write the one message they are most likely to send next.',
    'Rules:',
    '- Write in the language and tone the human actually uses in the conversation (usually Chinese).',
    '- The candidate must be a complete message the human could send as-is; 4 to 24 characters preferred, one line.',
    '- Anchor it in the concrete task state: what is being built, what just failed, or which decision is pending.',
    '- Prefer a concrete directive or a concrete question over generic praise or generic openers.',
    '- No numbering, no quotes, no explanations, no agent-side narration.',
    'Return only a JSON array containing that single string.',
  ].join('\n')
}

function parseCandidates(text) {
  const raw = String(text || '').trim()
  if (raw === '') return []
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .slice(0, CANDIDATE_COUNT)
      }
    } catch {
      // fall through to line parsing
    }
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\-*"'\d.、)）]+/, '').replace(/["',]+$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('[') && !line.startsWith(']'))
    .slice(0, CANDIDATE_COUNT)
}

async function collectStream(stream) {
  let text = ''
  let sawDelta = false
  let finish
  let sample = ''
  const kinds = []
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (sample === '') {
      try {
        sample = JSON.stringify(chunk).slice(0, 400)
      } catch {
        sample = String(chunk).slice(0, 400)
      }
    }
    if (typeof chunk.type === 'string' && kinds.length < 12 && !kinds.includes(chunk.type)) {
      kinds.push(chunk.type)
    }
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') {
        sawDelta = true
        text += chunk.text
      } else if (typeof chunk.delta === 'string') {
        sawDelta = true
        text += chunk.delta
      }
    } else if (!sawDelta && chunk.type === 'block-end' && chunk.block
      && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
      text = chunk.block.text
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return { text, kinds, finish, sample }
}

function resolveRoute(ctx, session) {
  let selected
  try {
    selected = session && typeof session.requestHeader === 'function'
      ? session.requestHeader()?.config
      : undefined
  } catch {
    selected = undefined
  }
  if (!selected) {
    const defaults = service(ctx, 'agentDefaultModel')
    if (defaults && typeof defaults.currentSelection === 'function') selected = defaults.currentSelection()
  }
  return selected && typeof selected.provider === 'string' && selected.provider !== ''
    && typeof selected.model === 'string' && selected.model !== ''
    ? { provider: selected.provider, model: selected.model }
    : undefined
}

function json(response, status, body) {
  if (response.writableEnded) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('request-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    request.on('error', reject)
  })
}

function describeEvents(events) {
  if (!Array.isArray(events)) return { isArray: false }
  const types = {}
  for (const event of events) {
    const type = event && typeof event.type === 'string' ? event.type : '(none)'
    types[type] = (types[type] || 0) + 1
  }
  return {
    isArray: true,
    length: events.length,
    types,
    last: events.slice(-3).map((event) => ({
      type: event && event.type,
      seq: event && event.seq,
      dataKeys: event && event.data && typeof event.data === 'object' ? Object.keys(event.data).slice(0, 8) : [],
    })),
  }
}

export default {
  name: 'dsh-prompt-suggest',
  apply(ctx) {
    /** sessionId -> { seq, candidates, at } */
    const cache = new Map()
    /** sessionId -> { seq, promise } */
    const inflight = new Map()
    const diag = { at: 0, payload: undefined, lastError: undefined, generations: 0, lastEvents: undefined, lastStream: undefined, lastRead: undefined }

    async function attemptStream(sessionId, route, turns, effort, skip) {
      const llm = service(ctx, 'llm')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const request = {
          provider: route.provider,
          model: route.model,
          sessionId,
          maxTokens: MAX_OUTPUT_TOKENS,
          system: systemPrompt(),
          messages: [{
            id: 'prompt-suggest-' + randomUUID(),
            role: 'user',
            content: [{
              type: 'text',
              text: JSON.stringify({
                recentTurns: turns.map((turn) => ({ role: turn.role, text: clip(turn.text) })),
                avoid: Array.isArray(skip) ? skip.slice(0, 6) : [],
              }),
            }],
            source: { kind: 'plugin', plugin: 'dsh-prompt-suggest' },
          }],
          signal: controller.signal,
        }
        if (effort !== undefined) request.reasoningEffort = effort
        const stream = llm.stream(request)
        return await collectStream(stream)
      } catch (error) {
        return {
          text: '',
          kinds: [],
          finish: undefined,
          sample: '',
          error: error && error.message ? error.message : String(error),
        }
      } finally {
        clearTimeout(timer)
      }
    }

    function unsupportedEffort(result) {
      const failure = result && result.finish && result.finish.failure
      const code = failure && failure.code
      const message = (failure && failure.message) || (result && result.error) || ''
      return code === 'UNSUPPORTED_REASONING_EFFORT'
        || (typeof message === 'string' && message.indexOf('does not support reasoning effort') !== -1)
    }

    async function generate(sessionId, session, events, seq, skip) {
      const llm = service(ctx, 'llm')
      if (!llm || typeof llm.stream !== 'function') return { code: 'NO_LLM' }
      const route = resolveRoute(ctx, session)
      if (!route) return { code: 'NO_MODEL_ROUTE' }
      const turns = turnsOf(events).slice(-MAX_TURNS)
      if (!turns.some((turn) => turn.role === 'user')) return { code: 'NO_CONTEXT' }
      diag.generations += 1
      diag.lastEvents = { seq, turns: turns.length }
      // Providers disagree about which reasoning-effort names exist (this build
      // rejects 'off'), so walk from cheapest to the model default and stop at
      // the first attempt the provider actually accepts.
      const efforts = ['none', 'minimal', 'low', undefined]
      let collected = { text: '', kinds: [], finish: undefined, sample: '', error: 'NO_ATTEMPT' }
      let usedEffort = 'none'
      for (const effort of efforts) {
        usedEffort = effort === undefined ? '(default)' : effort
        collected = await attemptStream(sessionId, route, turns, effort, skip)
        if (!unsupportedEffort(collected)) break
      }
      const debug = {
        effort: usedEffort,
        kinds: collected.kinds,
        finish: collected.finish,
        textLen: collected.text.length,
        raw: collected.text.slice(0, 600),
        sample: collected.sample,
        error: collected.error,
      }
      diag.lastStream = debug
      if (collected.error) return { code: 'STREAM_FAILED', debug }
      const candidates = parseCandidates(collected.text)
      if (candidates.length === 0) return { code: 'EMPTY_OUTPUT', debug }
      return { candidates, debug }
    }

    function startGeneration(sessionId, session, events, seq, skip) {
      const existing = inflight.get(sessionId)
      if (existing && existing.seq === seq) return
      const entry = { seq, promise: undefined }
      entry.promise = generate(sessionId, session, events, seq, skip)
        .then((result) => {
          if (result && Array.isArray(result.candidates) && result.candidates.length > 0) {
            cache.set(sessionId, { seq, candidates: result.candidates, at: Date.now() })
            diag.lastError = undefined
          } else {
            const code = (result && result.code) || 'NO_CANDIDATES'
            diag.lastError = code
            // Cache the failure for this turn so the polling client does not
            // re-trigger a model call every few seconds.
            cache.set(sessionId, { seq, candidates: [], failed: code, at: Date.now() })
          }
        })
        .catch((error) => {
          diag.lastError = error && error.message ? error.message : 'GENERATION_FAILED'
        })
        .finally(() => {
          if (inflight.get(sessionId) === entry) inflight.delete(sessionId)
        })
      inflight.set(sessionId, entry)
    }

    async function probe(sessionId) {
      const sessions = service(ctx, 'sessions')
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
      const query = service(ctx, 'sessionQuery')
      const info = {
        sessionsService: Boolean(sessions),
        sessionMethods: session ? Object.keys(session).slice(0, 20) : [],
        sessionHasEvents: Boolean(session && Array.isArray(session.events)),
        sessionEvents: describeEvents(session && session.events),
        sessionQuery: Boolean(query),
        sessionQueryMethods: query ? Object.keys(query).slice(0, 20) : [],
        route: session ? resolveRoute(ctx, session) || null : null,
        llm: Boolean(service(ctx, 'llm')),
      }
      if (query && typeof query.readSession === 'function') {
        try {
          const snapshot = await query.readSession(sessionId)
          info.readSession = {
            ok: true,
            keys: snapshot ? Object.keys(snapshot).slice(0, 20) : null,
            events: describeEvents(snapshot && snapshot.events),
          }
        } catch (error) {
          info.readSession = { ok: false, error: error && error.message }
        }
      }
      return info
    }

    async function handler(request, response) {
      if (request.method !== 'POST') {
        json(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
        return
      }
      let body
      try {
        body = await readJson(request)
      } catch (error) {
        const tooLarge = error && error.message === 'request-too-large'
        json(response, tooLarge ? 413 : 400, { ok: false, code: tooLarge ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON' })
        return
      }
      const method = body && typeof body.method === 'string' ? body.method : 'get'

      if (method === 'diag') {
        diag.at = Date.now()
        diag.payload = body.payload
        json(response, 200, { ok: true })
        return
      }
      if (method === 'diag-get') {
        json(response, 200, {
          ok: true,
          diag: diag.payload,
          at: diag.at,
          lastError: diag.lastError,
          generations: diag.generations,
          lastEvents: diag.lastEvents,
          lastStream: diag.lastStream,
          lastRead: diag.lastRead,
        })
        return
      }
      if (method === 'probe') {
        const probeId = typeof body.sessionId === 'string' ? body.sessionId : undefined
        const info = await probe(probeId)
        if (body.run === true && probeId !== undefined) {
          const probeSessions = service(ctx, 'sessions')
          const probeSession = probeSessions && typeof probeSessions.get === 'function'
            ? probeSessions.get(probeId)
            : undefined
          const probeRead = await readEvents(ctx, probeId, probeSession)
          const probeEnd = lastTurnEnd(probeRead.events)
          const probeSeq = probeEnd && Number.isSafeInteger(probeEnd.seq) ? probeEnd.seq : probeRead.events.length
          info.run = await generate(probeId, probeSession, probeRead.events, probeSeq)
        }
        json(response, 200, { ok: true, probe: info })
        return
      }

      if (method === 'history') {
        const historySessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
        if (historySessionId === undefined || historySessionId === '') {
          json(response, 200, { ok: true, history: [] })
          return
        }
        const list = await readHistory(ctx, historySessionId, 60)
        diag.lastHistory = { sessionId: historySessionId, size: list.length }
        json(response, 200, { ok: true, history: list })
        return
      }

      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      if (sessionId === undefined || sessionId === '') {
        json(response, 200, { ok: true, candidates: [], code: 'NO_SESSION_ID' })
        return
      }
      const sessions = service(ctx, 'sessions')
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
      if (!session) {
        json(response, 200, { ok: true, candidates: [], code: 'SESSION_NOT_LIVE' })
        return
      }
      const read = await readEvents(ctx, sessionId, session)
      const end = idleTurnEnd(read.events)
      const idle = end !== undefined
      const seq = end && Number.isSafeInteger(end.seq) ? end.seq : read.events.length
      diag.lastRead = { source: read.source, events: read.events.length, seq, idle, error: read.error }
      if (!idle) {
        // A turn is running or a new prompt was just sent: the previous
        // prediction is stale, so stay silent until this turn ends.
        json(response, 200, { ok: true, candidates: [], code: 'TURN_IN_FLIGHT', source: read.source })
        return
      }

      if (method === 'refresh') {
        cache.delete(sessionId)
        startGeneration(sessionId, session, read.events, seq, Array.isArray(body.skip) ? body.skip : [])
        json(response, 200, { ok: true, pending: true, seq })
        return
      }

      const cached = cache.get(sessionId)
      if (cached && cached.seq === seq
        && (cached.candidates.length > 0 || Date.now() - cached.at < 45000)) {
        json(response, 200, {
          ok: true,
          candidates: cached.candidates,
          suggestion: cached.candidates[0],
          source: read.source,
          seq,
        })
        return
      }
      startGeneration(sessionId, session, read.events, seq, [])
      json(response, 200, {
        ok: true,
        candidates: [],
        pending: true,
        source: read.source,
        events: read.events.length,
        seq,
      })
    }

    ctx.inject(['webServer'], (hostCtx) => {
      const webServer = service(hostCtx, 'webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        ctx.logger.warn('prompt-suggest: webServer service is unavailable')
        return
      }
      webServer.register({ kind: 'exact', path: ROUTE_PATH, handler })
    })
  },
}
