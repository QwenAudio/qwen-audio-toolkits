export const CAPTION_TOTAL_LINE_COUNT = 4
export const CAPTION_MAX_HISTORY_ITEMS = CAPTION_TOTAL_LINE_COUNT
export const CAPTION_HISTORY_LINE_CAPACITY = 49
export const CAPTION_CURRENT_LINE_CAPACITY = 39
export const CAPTION_PANEL_WIDTH = 760
export const CAPTION_OUTER_PADDING = 10
const CAPTION_LINE_HEIGHT = 22
const CAPTION_LINE_SPACING = 4
const CAPTION_VERTICAL_PADDING = 10
const CAPTION_MINIMUM_PANEL_HEIGHT = 54
const CAPTION_MAXIMUM_PANEL_HEIGHT =
  CAPTION_VERTICAL_PADDING * 2 +
  CAPTION_TOTAL_LINE_COUNT * CAPTION_LINE_HEIGHT +
  (CAPTION_TOTAL_LINE_COUNT - 1) * CAPTION_LINE_SPACING

export interface CaptionDisplayLine {
  text: string
  role: 'history' | 'current'
  groupId: number
  showsBadge: boolean
}

const CLOSING_PUNCTUATION = '，。！？、,.!?;；:：）)]}」』》〉】〕〗〙〛’”'

function characterWidth(character: string): number {
  if (/\s/u.test(character)) return 0.35
  if ((character.codePointAt(0) ?? 0) <= 0x7f) {
    return CLOSING_PUNCTUATION.includes(character) ? 0.55 : 0.62
  }
  return 1
}

function captionTextWidth(text: string): number {
  return Array.from(text).reduce(
    (width, character) => width + characterWidth(character),
    0,
  )
}

function normalizeCaptionText(text: string): string {
  // Streaming providers may return CR, NEL, or Unicode line/paragraph
  // separators in addition to LF. Collapse all of them before wrapping so
  // the layout calculation and WebView rendering share the same line model.
  return text.replace(/[\s\u0085\u2028\u2029]+/gu, ' ').trim()
}

function takeTokenPrefix(
  token: string,
  capacity: number,
): [prefix: string, remainder: string] {
  let prefix = ''
  let prefixWidth = 0
  let consumedLength = 0
  for (const character of token) {
    const width = characterWidth(character)
    if (
      prefix &&
      prefixWidth + width > capacity &&
      !CLOSING_PUNCTUATION.includes(character)
    ) {
      break
    }
    if (!prefix && width > capacity) break
    prefix += character
    prefixWidth += width
    consumedLength += character.length
  }
  return [prefix, token.slice(consumedLength)]
}

function splitLongToken(token: string, capacity: number): string[] {
  const chunks: string[] = []
  let remainder = token
  while (remainder) {
    const [chunk, next] = takeTokenPrefix(remainder, capacity)
    if (!chunk) {
      const [character] = Array.from(remainder)
      chunks.push(character)
      remainder = remainder.slice(character.length)
      continue
    }
    chunks.push(chunk)
    remainder = next
  }
  return chunks
}

/**
 * Wrap caption copy into deterministic visual lines. Whitespace-delimited
 * words stay intact whenever they fit on an empty line; only an individual
 * overlong token (for example a URL) is split inside the token. CJK text,
 * which normally has no spaces, falls back to character wrapping.
 */
function wrapCaption(text: string, capacity: number): string[] {
  const normalized = normalizeCaptionText(text)
    .replace(/\s+([,.;:!?%，。；：！？、…）)\]}>」』》〉】〕〗〙〛’”])/gu, '$1')
    .replace(/([(【〔〖〘〚「『《〈‘“<[{])\s+/gu, '$1')
  if (!normalized || capacity <= 0) return []

  const lines: string[] = []
  let current = ''
  let currentWidth = 0
  const spaceWidth = characterWidth(' ')

  for (const token of normalized.split(' ')) {
    const tokenWidth = captionTextWidth(token)
    if (tokenWidth <= capacity) {
      if (!current) {
        current = token
        currentWidth = tokenWidth
      } else if (currentWidth + spaceWidth + tokenWidth <= capacity) {
        current += ` ${token}`
        currentWidth += spaceWidth + tokenWidth
      } else {
        lines.push(current)
        current = token
        currentWidth = tokenWidth
      }
      continue
    }

    let remainder = token
    if (current) {
      const available = capacity - currentWidth - spaceWidth
      const [prefix, next] = takeTokenPrefix(remainder, available)
      if (prefix) {
        current += ` ${prefix}`
        remainder = next
      }
      lines.push(current)
      current = ''
      currentWidth = 0
    }
    const chunks = splitLongToken(remainder, capacity)
    lines.push(...chunks.slice(0, -1))
    current = chunks.at(-1) ?? ''
    currentWidth = captionTextWidth(current)
  }

  if (current) lines.push(current)
  return lines
}

function markFirstLinePerGroup(
  lines: Omit<CaptionDisplayLine, 'showsBadge'>[],
): CaptionDisplayLine[] {
  const seen = new Set<number>()
  return lines.map((line) => ({
    ...line,
    showsBadge: !seen.has(line.groupId) && Boolean(seen.add(line.groupId)),
  }))
}

/**
 * Select at most four lines in total. LIVE lines have priority and grow
 * upward, evicting the oldest FINAL lines until LIVE occupies all four.
 */
export function selectCaptionLines(
  history: string[],
  current: string,
  historyCapacity: number,
  currentCapacity: number,
): CaptionDisplayLine[] {
  const historyLines = history.flatMap((text, groupId) =>
    wrapCaption(text, historyCapacity).map((line) => ({
      text: line,
      role: 'history' as const,
      groupId,
    })),
  )
  const currentLines = wrapCaption(current, currentCapacity).map((line) => ({
    text: line,
    role: 'current' as const,
    groupId: history.length,
  }))
  const visibleCurrent = currentLines.slice(-CAPTION_TOTAL_LINE_COUNT)
  const historySlots = CAPTION_TOTAL_LINE_COUNT - visibleCurrent.length
  const visibleHistory = historySlots
    ? historyLines.slice(-historySlots)
    : []

  return markFirstLinePerGroup([
    ...visibleHistory,
    ...visibleCurrent,
  ])
}

export function captionPanelHeight(lineCount: number): number {
  const count = Math.min(
    CAPTION_TOTAL_LINE_COUNT,
    Math.max(1, Math.floor(lineCount)),
  )
  return Math.min(
    CAPTION_MAXIMUM_PANEL_HEIGHT,
    Math.max(
      CAPTION_MINIMUM_PANEL_HEIGHT,
      CAPTION_VERTICAL_PADDING * 2 +
        count * CAPTION_LINE_HEIGHT +
        Math.max(0, count - 1) * CAPTION_LINE_SPACING,
    ),
  )
}
