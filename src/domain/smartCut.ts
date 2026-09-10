import type {
  AsrTranscriptionResult,
  ModelPlugin,
  VadDetectionResult,
} from '../types'

export type SmartCutReason = 'silence' | 'filler' | 'repetition' | 'manual'

export interface SmartCutCandidate {
  id: string
  reason: SmartCutReason
  start: number
  end: number
  label: string
  detail: string
  confidence: 'high' | 'medium' | 'low'
  selected: boolean
  visualSimilarity?: number
  visualStable?: boolean
  visualAvailable?: boolean
}

export interface TimeRange {
  start: number
  end: number
}

export interface SubtitleCue {
  start: number
  end: number
  text: string
}

const STRONG_FILLERS = new Set([
  '嗯',
  '呃',
  '额',
  '唔',
  'em',
  'um',
  'uh',
  'erm',
])
const CONTEXT_FILLERS = new Set([
  '那个',
  '这个',
  '就是',
  '然后',
  '其实',
  '怎么说',
  '你知道吧',
])

function normalizeToken(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s，。！？、,.!?;；:："“”'‘’（）()]+/g, '')
}

function isStandaloneWordToken(text: string, normalized: string): boolean {
  // English ASR timestamps can be subword pieces (for example " D" + "em" +
  // "ocratic"). Only a token that starts a new word may be treated as a
  // filler/repetition; otherwise "em" inside "Democratic" becomes a bad cut.
  return /[\u3400-\u9fff]/u.test(normalized) || /^\s/u.test(text)
}

interface TimedWord {
  text: string
  start: number
  end: number
  speechEnd: number
}

export interface SmartCutWord {
  id: string
  segmentId: string
  text: string
  start: number
  end: number
}

export interface SmartCutTextSegment {
  id: string
  start: number
  end: number
  text: string
  wordIds: string[]
}

export function activeSmartCutWordId(
  words: SmartCutWord[],
  currentTime: number,
): string | null {
  let active: SmartCutWord | null = null
  for (const word of words) {
    if (currentTime < word.start || currentTime >= word.end) continue
    if (
      !active ||
      word.start > active.start ||
      (word.start === active.start && word.end < active.end)
    ) active = word
  }
  return active?.id ?? null
}

const TIMESTAMP_CAPABILITY = /(?:时间戳|时间信息|time\s*stamp)/iu

export function modelSupportsSmartCutTimeline(model: ModelPlugin): boolean {
  return model.capabilities.some((capability) =>
    TIMESTAMP_CAPABILITY.test(capability),
  )
}

type UnknownRecord = Record<string, unknown>

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? value as UnknownRecord : null
}

function numericTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+(?::\d+){1,2}(?:[.,]\d+)?$/u.test(trimmed)) {
    const parts = trimmed.replace(',', '.').split(':').map(Number)
    return parts.reduce((seconds, part) => seconds * 60 + part, 0)
  }
  const parsed = Number(trimmed.replace(/\s*(?:ms|s)$/iu, ''))
  return Number.isFinite(parsed) ? parsed : null
}

const START_KEYS = [
  'start', 'startTime', 'start_time', 'startMs', 'start_ms', 'beginTime', 'begin_time',
] as const
const END_KEYS = [
  'end', 'endTime', 'end_time', 'endMs', 'end_ms', 'finishTime', 'finish_time',
] as const

function timestampEntry(
  value: UnknownRecord,
  keys: readonly string[],
): { key: string; value: number } | null {
  for (const key of keys) {
    const parsed = numericTimestamp(value[key])
    if (parsed !== null) return { key, value: parsed }
  }
  const timestamps = value.timestamps
  if (Array.isArray(timestamps)) {
    const index = keys === START_KEYS ? 0 : 1
    const parsed = numericTimestamp(timestamps[index])
    if (parsed !== null) return { key: 'timestamps', value: parsed }
  }
  return null
}

function isExplicitMilliseconds(key: string, source: unknown): boolean {
  if (typeof source === 'string' && /ms\s*$/iu.test(source.trim())) return true
  return /^(?:begin_time|end_time|startMs|endMs|start_ms|end_ms)$/u.test(key)
}

/**
 * Converts provider-specific ASR timelines to the app's canonical seconds.
 * Local engines already return seconds, while common APIs may return
 * milliseconds, begin_time/end_time fields, timestamps tuples, or timecodes.
 */
export function normalizeSmartCutTranscription(
  transcription: AsrTranscriptionResult,
  mediaDuration = transcription.duration,
): AsrTranscriptionResult {
  const rawSegments = Array.isArray(transcription.segments)
    ? transcription.segments as unknown[]
    : []
  const duration = Number.isFinite(mediaDuration) && mediaDuration > 0
    ? mediaDuration
    : transcription.duration
  const ordinaryValues: number[] = []
  for (const rawSegment of rawSegments) {
    const segment = recordValue(rawSegment)
    if (!segment) continue
    const children = [segment, ...(
      Array.isArray(segment.tokens)
        ? segment.tokens
        : Array.isArray(segment.words)
          ? segment.words
          : []
    ).map(recordValue).filter((item): item is UnknownRecord => Boolean(item))]
    for (const item of children) {
      for (const keys of [START_KEYS, END_KEYS] as const) {
        const entry = timestampEntry(item, keys)
        if (
          entry &&
          !isExplicitMilliseconds(entry.key, item[entry.key]) &&
          !(typeof item[entry.key] === 'string' && String(item[entry.key]).includes(':'))
        ) ordinaryValues.push(entry.value)
      }
    }
  }
  const maxOrdinary = Math.max(0, ...ordinaryValues)
  const ordinaryScale = duration > 0 && maxOrdinary > Math.max(duration * 4, duration + 60)
    ? 0.001
    : 1
  const seconds = (
    item: UnknownRecord,
    keys: readonly string[],
    fallback: number,
  ) => {
    const entry = timestampEntry(item, keys)
    if (!entry) return fallback
    const source = item[entry.key]
    const timecode = typeof source === 'string' && source.includes(':')
    const scale = timecode
      ? 1
      : isExplicitMilliseconds(entry.key, source)
        ? 0.001
        : ordinaryScale
    return Math.min(Math.max(0, entry.value * scale), Math.max(duration, 0))
  }

  const segments = rawSegments.flatMap((rawSegment, segmentIndex) => {
    const segment = recordValue(rawSegment)
    if (!segment) return []
    const start = seconds(segment, START_KEYS, 0)
    const end = Math.max(start, seconds(segment, END_KEYS, duration))
    const rawTokens = Array.isArray(segment.tokens)
      ? segment.tokens
      : Array.isArray(segment.words)
        ? segment.words
        : []
    const tokens = rawTokens.flatMap((rawToken, tokenIndex) => {
      const token = recordValue(rawToken)
      if (!token) return []
      const text = [token.text, token.word, token.token]
        .find((item): item is string => typeof item === 'string') ?? ''
      if (!text.trim()) return []
      const tokenStart = seconds(token, START_KEYS, start)
      const tokenEnd = Math.max(tokenStart, seconds(token, END_KEYS, tokenStart))
      return [{
        text,
        start: tokenStart,
        end: tokenEnd,
        index: tokenIndex,
      }]
    })
    const normalizedTokens = tokens.map(({ index: _index, ...token }, index) => ({
      ...token,
      end: token.end > token.start
        ? token.end
        : Math.max(token.start, tokens[index + 1]?.start ?? end),
    }))
    const text = typeof segment.text === 'string'
      ? segment.text
      : normalizedTokens.map((token) => token.text).join('')
    if (!text.trim()) return []
    return [{
      id: typeof segment.id === 'string' ? segment.id : `segment-${segmentIndex + 1}`,
      start,
      end,
      text,
      tokens: normalizedTokens,
    }]
  })
  const speechSeconds = segments.reduce(
    (total, segment) => total + Math.max(0, segment.end - segment.start),
    0,
  )
  return {
    ...transcription,
    duration,
    speechSeconds,
    segments,
  }
}

export function hasUsableSmartCutTimeline(
  transcription: AsrTranscriptionResult,
): boolean {
  return transcription.segments.some(
    (segment) => segment.end > segment.start,
  )
}

function timedWords(
  tokens: AsrTranscriptionResult['segments'][number]['tokens'],
): TimedWord[] {
  const words: TimedWord[] = []
  let current: TimedWord | null = null
  const flush = () => {
    if (current && normalizeToken(current.text)) words.push(current)
    current = null
  }
  for (const token of tokens) {
    const normalized = normalizeToken(token.text)
    const containsCjk = /[\u3400-\u9fff]/u.test(normalized)
    const startsWord = /^\s/u.test(token.text)
    const isJoiner = /^[’'-]+$/u.test(token.text.trim())
    if (containsCjk) {
      flush()
      words.push({
        text: token.text,
        start: token.start,
        end: token.end,
        speechEnd: token.end,
      })
      continue
    }
    if (startsWord && normalized) flush()
    if (!current && normalized) {
      current = {
        text: token.text,
        start: token.start,
        end: token.end,
        speechEnd: token.end,
      }
      continue
    }
    if (!current) continue
    current.text += token.text
    current.end = Math.max(current.end, token.end)
    if (normalized || isJoiner) current.speechEnd = Math.max(current.speechEnd, token.end)
    if (/^[.!?。！？]+$/u.test(token.text.trim())) flush()
  }
  flush()
  return words
}

export function smartCutWords(
  transcription: AsrTranscriptionResult,
): SmartCutWord[] {
  return transcription.segments.flatMap((segment) =>
    timedWords(segment.tokens).map((word, index) => ({
      id: `${segment.id}-${index}`,
      segmentId: segment.id,
      text: word.text.trim(),
      start: word.start,
      end: word.speechEnd,
    })),
  )
}

export function manualWordCandidate(word: SmartCutWord): SmartCutCandidate {
  return {
    id: `manual-${word.id}`,
    reason: 'manual',
    start: word.start,
    end: word.end,
    label: `手动删除「${word.text}」`,
    detail: '按词级时间戳手动选择',
    confidence: 'high',
    selected: true,
  }
}

function joinWordText(current: string, next: string): string {
  if (!current) return next
  const joinWithoutSpace =
    /[\u3400-\u9fff]$/u.test(current) && /^[\u3400-\u9fff]/u.test(next)
  return `${current}${joinWithoutSpace ? '' : ' '}${next}`
}

export function buildSmartCutTextSegments(
  transcription: AsrTranscriptionResult,
  _vad: VadDetectionResult | null,
): SmartCutTextSegment[] {
  const words = smartCutWords(transcription)
  if (!words.length) {
    return transcription.segments.map((segment) => ({
      id: `text-${segment.id}`,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      wordIds: [],
    }))
  }
  const segments: SmartCutTextSegment[] = []
  let current: SmartCutTextSegment | null = null
  let previousWord: SmartCutWord | null = null
  const flush = () => {
    if (current) segments.push(current)
    current = null
  }
  for (const word of words) {
    const gap = previousWord ? word.start - previousWord.end : 0
    const sentenceBoundary = Boolean(
      current &&
      previousWord &&
      /[.!?。！？]$/u.test(previousWord.text) &&
      previousWord.end - current.start >= 0.7,
    )
    const clearPauseBoundary = Boolean(
      current &&
      gap >= 1.5 &&
      previousWord &&
      previousWord.end - current.start >= 2.5,
    )
    if (current && (sentenceBoundary || clearPauseBoundary)) {
      flush()
    }
    if (!current) {
      current = {
        id: `text-segment-${segments.length + 1}`,
        start: word.start,
        end: word.end,
        text: word.text,
        wordIds: [word.id],
      }
    } else {
      current.end = word.end
      current.text = joinWordText(current.text, word.text)
      current.wordIds.push(word.id)
    }
    previousWord = word
  }
  flush()
  return segments
}

function mergeRanges(ranges: TimeRange[], gap = 0.06): TimeRange[] {
  const ordered = ranges
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end > range.start,
    )
    .sort((left, right) => left.start - right.start)
  const merged: TimeRange[] = []
  for (const range of ordered) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end + gap) {
      merged.push({ ...range })
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
  }
  return merged
}

function speechRanges(
  transcription: AsrTranscriptionResult,
  vad: VadDetectionResult | null,
): TimeRange[] {
  if (vad?.segments.length) {
    return mergeRanges(
      vad.segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
      })),
      0.12,
    )
  }
  const tokens = transcription.segments.flatMap((segment) => segment.tokens)
  if (tokens.length) {
    return mergeRanges(
      tokens.map((token) => ({ start: token.start, end: token.end })),
      0.24,
    )
  }
  return mergeRanges(
    transcription.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
    })),
    0.24,
  )
}

function silenceCandidates(
  transcription: AsrTranscriptionResult,
  vad: VadDetectionResult | null,
  duration: number,
  minimumSilence: number,
  edgePadding: number,
): SmartCutCandidate[] {
  const speech = speechRanges(transcription, vad)
  const candidates: SmartCutCandidate[] = []
  let cursor = 0
  for (const range of [...speech, { start: duration, end: duration }]) {
    const rawStart = cursor
    const rawEnd = Math.min(duration, range.start)
    cursor = Math.max(cursor, range.end)
    if (rawEnd - rawStart < minimumSilence) continue
    const start = rawStart <= 0.08 ? 0 : rawStart + edgePadding
    const end = rawEnd >= duration - 0.08 ? duration : rawEnd - edgePadding
    if (end - start < Math.max(0.16, minimumSilence - edgePadding * 2)) continue
    const leading = start === 0
    const trailing = !leading && end === duration
    candidates.push({
      id: `silence-${candidates.length}-${start.toFixed(3)}`,
      reason: 'silence',
      start,
      end,
      label: leading ? '片头静音' : trailing ? '片尾静音' : '停顿',
      detail: `${(end - start).toFixed(1)} 秒无语音`,
      confidence: leading || trailing ? 'medium' : 'high',
      selected: false,
    })
  }
  return candidates
}

function languageCandidates(
  transcription: AsrTranscriptionResult,
): SmartCutCandidate[] {
  const words = transcription.segments
    .flatMap((segment) => timedWords(segment.tokens))
    .filter((word) =>
      Number.isFinite(word.start) &&
      Number.isFinite(word.speechEnd) &&
      word.speechEnd > word.start,
    )
    .sort((left, right) => left.start - right.start)
  const candidates: SmartCutCandidate[] = []
  let previous = ''
  let previousEnd = -Infinity
  for (const [index, word] of words.entries()) {
    const normalized = normalizeToken(word.text)
    if (!normalized) continue
    const standalone = isStandaloneWordToken(word.text, normalized)
    const strong = standalone && STRONG_FILLERS.has(normalized)
    const contextual = standalone && CONTEXT_FILLERS.has(normalized)
    const repeated = standalone && normalized === previous && word.start - previousEnd <= 0.65
    if (strong || contextual || repeated) {
      const reason: SmartCutReason = repeated ? 'repetition' : 'filler'
      const previousWord = words[index - 1]
      const nextWord = words[index + 1]
      const gapBefore = previousWord
        ? Math.max(0, word.start - previousWord.speechEnd)
        : 0
      const gapAfter = nextWord ? Math.max(0, nextWord.start - word.speechEnd) : 0
      const repeatedHasSafeBoundary = gapBefore + gapAfter >= 0.12
      const fillerMargin = word.speechEnd - word.start <= 0.12 ? 0.005 : 0.02
      const startPadding = repeated
        ? Math.min(0.04, gapBefore / 2)
        : Math.min(0.32, Math.max(0, gapBefore - fillerMargin))
      const endPadding = repeated
        ? Math.min(0.04, gapAfter / 2)
        : Math.min(0.32, Math.max(0, gapAfter - fillerMargin))
      candidates.push({
        id: `${reason}-${candidates.length}-${word.start.toFixed(3)}`,
        reason,
        start: Math.max(0, word.start - startPadding),
        end: word.speechEnd + endPadding,
        label: repeated ? `重复词「${word.text.trim()}」` : `口水词「${word.text.trim()}」`,
        detail: strong
          ? '明确语气词，可优先检查'
          : repeated
            ? repeatedHasSafeBoundary
              ? '与前一个词重复，附近有可用切口'
              : '与前一个词重复，但连续语音切口风险较高'
            : '依赖上下文，默认保留',
        confidence: strong || (repeated && repeatedHasSafeBoundary) ? 'high' : repeated ? 'medium' : 'low',
        selected: strong || (repeated && repeatedHasSafeBoundary),
      })
    }
    if (standalone) {
      previous = normalized
      previousEnd = word.speechEnd
    }
  }
  return candidates
}

export function buildSmartCutCandidates(
  transcription: AsrTranscriptionResult,
  vad: VadDetectionResult | null,
  duration: number,
  options?: { minimumSilence?: number; edgePadding?: number },
): SmartCutCandidate[] {
  const minimumSilence = Math.max(0.25, options?.minimumSilence ?? 0.65)
  const edgePadding = Math.max(0.04, options?.edgePadding ?? 0.12)
  return [
    ...silenceCandidates(
      transcription,
      vad,
      duration,
      minimumSilence,
      edgePadding,
    ),
    ...languageCandidates(transcription),
  ].sort((left, right) => {
    if (left.label === '片头静音' && right.label !== '片头静音') return -1
    if (right.label === '片头静音' && left.label !== '片头静音') return 1
    if (left.label === '片尾静音' && right.label !== '片尾静音') return 1
    if (right.label === '片尾静音' && left.label !== '片尾静音') return -1
    return left.start - right.start
  })
}

export function selectedDeleteRanges(
  candidates: SmartCutCandidate[],
  duration: number,
): TimeRange[] {
  return mergeRanges(
    candidates
      .filter((candidate) => candidate.selected)
      .map((candidate) => ({
        start: Math.max(0, Math.min(duration, candidate.start)),
        end: Math.max(0, Math.min(duration, candidate.end)),
      })),
  )
}

export function keepRangesFromCuts(
  candidates: SmartCutCandidate[],
  duration: number,
): TimeRange[] {
  const cuts = selectedDeleteRanges(candidates, duration)
  const keep: TimeRange[] = []
  let cursor = 0
  for (const cut of cuts) {
    if (cut.start - cursor >= 0.04) keep.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (duration - cursor >= 0.04) keep.push({ start: cursor, end: duration })
  return keep
}

export function deletedDuration(
  candidates: SmartCutCandidate[],
  duration: number,
): number {
  return selectedDeleteRanges(candidates, duration).reduce(
    (total, range) => total + range.end - range.start,
    0,
  )
}

function outputTime(sourceTime: number, cuts: TimeRange[]): number {
  let removed = 0
  for (const cut of cuts) {
    if (sourceTime >= cut.end) {
      removed += cut.end - cut.start
      continue
    }
    if (sourceTime > cut.start) return cut.start - removed
    break
  }
  return Math.max(0, sourceTime - removed)
}

function cleanSubtitleText(text: string): string {
  return text
    .replace(/\s+([,.;!?，。；！？：])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function buildSmartCutSubtitleCues(
  transcription: AsrTranscriptionResult,
  candidates: SmartCutCandidate[],
  duration: number,
  segmentDrafts: Record<string, string> = {},
  vad: VadDetectionResult | null = null,
): SubtitleCue[] {
  const cuts = selectedDeleteRanges(candidates, duration)
  const wordsById = new Map(
    smartCutWords(transcription).map((word) => [word.id, word]),
  )
  const textSegments = buildSmartCutTextSegments(transcription, vad)
  const cues: SubtitleCue[] = []
  const isDeleted = (start: number, end: number) => {
    const midpoint = (start + end) / 2
    return cuts.some((cut) => midpoint >= cut.start && midpoint < cut.end)
  }
  const appendCue = (start: number, end: number, text: string) => {
    const cleaned = cleanSubtitleText(text)
    if (!cleaned) return
    const mappedStart = outputTime(start, cuts)
    const mappedEnd = outputTime(end, cuts)
    if (mappedEnd - mappedStart < 0.08) return
    cues.push({ start: mappedStart, end: mappedEnd, text: cleaned })
  }

  for (const segment of textSegments) {
    const draft = segmentDrafts[segment.id]
    if (draft !== undefined && draft.trim() !== segment.text.trim()) {
      appendCue(segment.start, segment.end, draft)
      continue
    }
    const words = segment.wordIds
      .map((wordId) => wordsById.get(wordId))
      .filter((word): word is SmartCutWord => Boolean(word))
    if (!words.length) {
      appendCue(segment.start, segment.end, segment.text)
      continue
    }
    let cueStart = -1
    let cueEnd = -1
    let cueText = ''
    const flush = () => {
      if (cueStart >= 0) appendCue(cueStart, cueEnd, cueText)
      cueStart = -1
      cueEnd = -1
      cueText = ''
    }
    for (const word of words) {
      if (isDeleted(word.start, word.end)) {
        flush()
        continue
      }
      if (cueStart < 0) cueStart = word.start
      cueEnd = word.end
      cueText = joinWordText(cueText, word.text)
    }
    flush()
  }
  return cues
}
