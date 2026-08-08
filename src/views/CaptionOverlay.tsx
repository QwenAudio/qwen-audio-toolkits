import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from '@tauri-apps/api/window'
import { X } from 'lucide-react'
import {
  CAPTION_UPDATE_EVENT,
  type CaptionOutputUpdate,
} from '../services/captionOutput'
import './CaptionOverlay.css'

const MAX_HISTORY_ITEMS = 3
const TOTAL_LINE_COUNT = 4
const MAX_FINAL_LINE_COUNT = 3
const HISTORY_LINE_CAPACITY = 49
const CURRENT_LINE_CAPACITY = 39
const PANEL_WIDTH = 760
const OUTER_PADDING = 10
const LINE_HEIGHT = 22
const LINE_SPACING = 4
const VERTICAL_PADDING = 10
const MINIMUM_PANEL_HEIGHT = 54

interface CaptionDisplayLine {
  text: string
  role: 'history' | 'current'
  groupId: number
  showsBadge: boolean
}

function overlapLength(previous: string, candidate: string): number {
  const maximum = Math.min(previous.length, candidate.length)
  for (let length = maximum; length >= 2; length -= 1) {
    if (previous.slice(-length) === candidate.slice(0, length)) return length
  }
  return 0
}

function removeCommittedPrefix(committed: string, candidate: string): string {
  const text = candidate.trim()
  if (!text) return ''
  if (committed.endsWith(text)) return ''
  if (text.startsWith(committed)) return text.slice(committed.length)
  return text.slice(overlapLength(committed, text))
}

function characterWidth(character: string): number {
  if (/\s/u.test(character)) return 0.35
  if ((character.codePointAt(0) ?? 0) <= 0x7f) {
    return '，。！？、,.!?;；:：）)]}」』》'.includes(character) ? 0.55 : 0.62
  }
  return 1
}

function wrapCaption(text: string, capacity: number): string[] {
  const normalized = text.replace(/\s*\n+\s*/gu, ' ').trim()
  if (!normalized) return []
  const lines: string[] = []
  let current = ''
  let currentWidth = 0
  let lastSpaceIndex = -1
  let lastSpaceWidth = 0

  for (const character of normalized) {
    const width = characterWidth(character)
    if (current && currentWidth + width > capacity) {
      if (lastSpaceIndex > 0) {
        const line = current.slice(0, lastSpaceIndex).trim()
        if (line) lines.push(line)
        current = current.slice(lastSpaceIndex + 1).trim()
        currentWidth = Math.max(0, currentWidth - lastSpaceWidth)
      } else {
        lines.push(current)
        current = ''
        currentWidth = 0
      }
      lastSpaceIndex = -1
      lastSpaceWidth = 0
    }
    current += character
    currentWidth += width
    if (/\s/u.test(character)) {
      lastSpaceIndex = current.length - 1
      lastSpaceWidth = currentWidth
    }
  }
  if (current.trim()) lines.push(current.trim())
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

function displayLines(
  history: string[],
  current: string,
): CaptionDisplayLine[] {
  const historyLines = history.flatMap((text, groupId) =>
    wrapCaption(text, HISTORY_LINE_CAPACITY).map((line) => ({
      text: line,
      role: 'history' as const,
      groupId,
    })),
  )
  const currentLines = wrapCaption(current, CURRENT_LINE_CAPACITY).map(
    (line) => ({
      text: line,
      role: 'current' as const,
      groupId: history.length,
    }),
  )
  if (!currentLines.length) {
    return markFirstLinePerGroup(
      historyLines.slice(-MAX_FINAL_LINE_COUNT),
    )
  }
  const visibleCurrent = currentLines.slice(-TOTAL_LINE_COUNT)
  const remaining = Math.max(0, TOTAL_LINE_COUNT - visibleCurrent.length)
  return markFirstLinePerGroup([
    ...historyLines.slice(-remaining),
    ...visibleCurrent,
  ])
}

function panelHeight(lineCount: number): number {
  const count = Math.max(1, lineCount)
  return Math.max(
    MINIMUM_PANEL_HEIGHT,
    VERTICAL_PADDING * 2 +
      count * LINE_HEIGHT +
      Math.max(0, count - 1) * LINE_SPACING,
  )
}

export function CaptionOverlay() {
  const [history, setHistory] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [status, setStatus] =
    useState<CaptionOutputUpdate['status']>('listening')
  const [liveSeconds, setLiveSeconds] = useState(0)
  const committedRef = useRef('')
  const currentRef = useRef('')
  const lines = useMemo(
    () => displayLines(history, current),
    [current, history],
  )
  const visibleLines: CaptionDisplayLine[] = lines.length
    ? lines
    : [
        {
          text: '',
          role: 'current',
          groupId: 0,
          showsBadge: false,
        },
      ]

  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    void listen<CaptionOutputUpdate>(CAPTION_UPDATE_EVENT, ({ payload }) => {
      if (disposed) return
      if (payload.status) setStatus(payload.status)
      const text = removeCommittedPrefix(committedRef.current, payload.text)
      if (!payload.text.trim()) {
        if (payload.reset) {
          committedRef.current = ''
          currentRef.current = ''
          setHistory([])
          setCurrent('')
        }
        return
      }
      if (!payload.isFinal) {
        currentRef.current = text
        setCurrent(text)
        return
      }
      // Commit the segment as FINAL. If the incoming text was already
      // consumed as a live prefix, fall back to the current live line so the
      // caption still advances to a FINAL line instead of silently clearing.
      const finalText = text || currentRef.current
      if (finalText) {
        committedRef.current += finalText
        setHistory((items) => [...items, finalText].slice(-MAX_HISTORY_ITEMS))
      }
      currentRef.current = ''
      setCurrent('')
    }).then((unlisten) => {
      if (disposed) unlisten()
      else remove = unlisten
    })
    return () => {
      disposed = true
      remove?.()
    }
  }, [])

  useEffect(() => {
    if (status !== 'speech') {
      setLiveSeconds(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const segmentMs = Date.now() - startedAt
      setLiveSeconds(Math.floor(segmentMs / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [status])

  useLayoutEffect(() => {
    const resize = async () => {
      const window = getCurrentWindow()
      const [position, size, scaleFactor] = await Promise.all([
        window.outerPosition(),
        window.outerSize(),
        window.scaleFactor(),
      ])
      const height = panelHeight(visibleLines.length) + OUTER_PADDING * 2
      const physicalHeight = Math.round(height * scaleFactor)
      await window.setSize(
        new LogicalSize(PANEL_WIDTH + OUTER_PADDING * 2, height),
      )
      await window.setPosition(
        new PhysicalPosition(
          position.x,
          position.y + size.height - physicalHeight,
        ),
      )
    }
    void resize()
  }, [visibleLines.length])

  const duration = `${Math.floor(liveSeconds / 60)
    .toString()
    .padStart(2, '0')}:${(liveSeconds % 60).toString().padStart(2, '0')}`

  return (
    <main className="caption-overlay-root">
      <section
        className="caption-panel"
        data-tauri-drag-region
        style={{ height: panelHeight(visibleLines.length) }}
      >
        <div className="caption-lines" data-tauri-drag-region>
          {visibleLines.map((line, index) => (
            <div
              className={`caption-line role-${line.role}`}
              data-tauri-drag-region
              key={`${line.groupId}-${index}-${line.text}`}
            >
              <div
                className={`caption-badge${
                  line.showsBadge && line.text ? ' visible' : ''
                }`}
              >
                <b>{line.role === 'current' ? 'LIVE' : 'FINAL'}</b>
                <span>{line.role === 'current' ? duration : '\u00a0'}</span>
                <small>{'\u00a0'}</small>
              </div>
              <p>{line.text || '\u00a0'}</p>
            </div>
          ))}
        </div>
        <button
          className="caption-close"
          type="button"
          title="关闭字幕"
          aria-label="关闭字幕"
          onClick={() => void getCurrentWindow().hide()}
        >
          <X size={9} strokeWidth={2.4} />
        </button>
      </section>
    </main>
  )
}
