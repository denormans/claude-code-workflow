import { JSDOM } from 'jsdom'

export interface ValidationResult {
  valid: boolean
  error?: string
}

interface Mermaid {
  parse(text: string): Promise<unknown>
  mermaidAPI: { getDiagramFromText(text: string): Promise<{ db: object }> }
}

let mermaidReady: Promise<Mermaid> | undefined
let dom: JSDOM | undefined

export const validateMermaid = async (code: string): Promise<ValidationResult> =>
  // Mermaid needs a DOM, but only while it loads and parses. A `window` left on globalThis makes
  // @terrastruct/d2 0.1.33 take its browser path in this Node process, and its renderer never starts.
  withDomGlobals(async () => {
    const mermaid = await getMermaid()
    try {
      await mermaid.parse(code)
      return { valid: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { valid: false, error: message.split('\n')[0] }
    }
  })

export interface SequenceMessage {
  from: string
  to: string
}

export interface SequenceIds {
  participants: string[]
  // In source order, so a step's message index points into it.
  messages: SequenceMessage[]
}

// Whether a step id is a message index: a canonical non-negative integer, with no leading zeros.
export const isMessageIndex = (id: string): boolean => /^(0|[1-9]\d*)$/.test(id)

// Mermaid's LINETYPE.NOTE: a note names participants but is not a message between them.
const NOTE = 2

// A sequence's participant ids, and each message's sender and receiver. A message runs from one
// participant to another, so notes, blocks and activations are not messages. The source must
// already parse.
export const readSequence = async (code: string): Promise<SequenceIds> =>
  withDomGlobals(async () => {
    const { db } = await (await getMermaid()).mermaidAPI.getDiagramFromText(code)
    const actors = callDb(db, 'getActors')
    const signals = callDb(db, 'getMessages')
    return {
      participants: actors instanceof Map ? [...actors.keys()].map(String) : [],
      messages: Array.isArray(signals) ? signals.flatMap(messageOf) : [],
    }
  })

const getMermaid = (): Promise<Mermaid> => {
  mermaidReady ??= (async () => {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false })
    return mermaid
  })()
  return mermaidReady
}

const withDomGlobals = async <T>(run: () => Promise<T>): Promise<T> => {
  dom ??= new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, 'document')
  }
}

const callDb = (db: object, method: string): unknown => {
  const fn: unknown = Reflect.get(db, method)
  if (typeof fn !== 'function') {
    throw new Error(`validate-mermaid: a sequence diagram's database has no ${method}`)
  }
  return Reflect.apply(fn, db, [])
}

// A signal's sender and receiver, when it is a message rather than a note.
const messageOf = (signal: unknown): SequenceMessage[] => {
  if (typeof signal !== 'object' || signal === null || Reflect.get(signal, 'type') === NOTE) {
    return []
  }

  const from: unknown = Reflect.get(signal, 'from')
  const to: unknown = Reflect.get(signal, 'to')

  return typeof from === 'string' && typeof to === 'string' ? [{ from, to }] : []
}
