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
import {
  captionPanelHeight,
  CAPTION_CURRENT_LINE_CAPACITY,
  CAPTION_HISTORY_LINE_CAPACITY,
  CAPTION_MAX_HISTORY_ITEMS,
  CAPTION_OUTER_PADDING,
  CAPTION_PANEL_WIDTH,
  CAPTION_TOTAL_LINE_COUNT,
  selectCaptionLines,
  type CaptionDisplayLine,
} from '../utils/captionLayout'
import './CaptionOverlay.css'

const DEBUG_STRESS_FIXTURE =
  import.meta.env.DEV &&
  import.meta.env.VITE_CAPTION_DEBUG_FIXTURE === 'stress'

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

export function CaptionOverlay() {
  const [history, setHistory] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [status, setStatus] =
    useState<CaptionOutputUpdate['status']>('listening')
  const [liveSeconds, setLiveSeconds] = useState(0)
  const committedRef = useRef('')
  const currentRef = useRef('')
  const resizeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const lines = useMemo(
    () =>
      selectCaptionLines(
        history,
        current,
        CAPTION_HISTORY_LINE_CAPACITY,
        CAPTION_CURRENT_LINE_CAPACITY,
      ),
    [current, history],
  )
  const boundedLines = lines.slice(-CAPTION_TOTAL_LINE_COUNT)
  const visibleLines: CaptionDisplayLine[] = boundedLines.length
    ? boundedLines
    : [
        {
          text: '',
          role: 'current',
          groupId: 0,
          showsBadge: false,
        },
      ]
  const visibleFinalLineCount = visibleLines.filter(
    ({ role }) => role === 'history',
  ).length
  const visibleLiveLineCount = visibleLines.length - visibleFinalLineCount
  const visiblePanelHeight = captionPanelHeight(visibleLines.length)

  useEffect(() => {
    if (!DEBUG_STRESS_FIXTURE) return
    const debugCurrent = [
      '这是一段用于验证字幕小行上限的超长实时内容'.repeat(4),
      '换行符压力测试',
      '当前内容应该顶掉全部历史并且只保留最后四个小行'.repeat(3),
    ].join('\r\n\u0085\u2028\u2029')
    currentRef.current = debugCurrent
    setHistory(['历史一', '历史二', '历史三', '历史四'])
    setCurrent(debugCurrent)
    setStatus('speech')
    void getCurrentWindow().show().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.debug('[caption-layout]', {
      historyItems: history.length,
      currentCharacters: current.length,
      visibleFinalLines: visibleFinalLineCount,
      visibleLiveLines: visibleLiveLineCount,
      panelHeight: visiblePanelHeight,
    })
  }, [
    current.length,
    history.length,
    visibleFinalLineCount,
    visibleLiveLineCount,
    visiblePanelHeight,
  ])

  useEffect(() => {
    if (DEBUG_STRESS_FIXTURE) return
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
        setHistory((items) =>
          [...items, finalText].slice(-CAPTION_MAX_HISTORY_ITEMS),
        )
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
    const height = visiblePanelHeight + CAPTION_OUTER_PADDING * 2
    // Caption events can change the row count while a previous native resize
    // is still in flight. Serialize updates so an older one-row resize can
    // never finish after and overwrite the latest four-row height.
    resizeQueueRef.current = resizeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const window = getCurrentWindow()
        const [position, size, scaleFactor] = await Promise.all([
          window.outerPosition(),
          window.outerSize(),
          window.scaleFactor(),
        ])
        const physicalHeight = Math.round(height * scaleFactor)
        await window.setSize(
          new LogicalSize(
            CAPTION_PANEL_WIDTH + CAPTION_OUTER_PADDING * 2,
            height,
          ),
        )
        await window.setPosition(
          new PhysicalPosition(
            position.x,
            position.y + size.height - physicalHeight,
          ),
        )
      })
  }, [visiblePanelHeight])

  const duration = `${Math.floor(liveSeconds / 60)
    .toString()
    .padStart(2, '0')}:${(liveSeconds % 60).toString().padStart(2, '0')}`

  return (
    <main className="caption-overlay-root">
      <section
        className="caption-panel"
        data-tauri-drag-region
        style={{ height: visiblePanelHeight }}
      >
        <div
          className="caption-lines"
          data-tauri-drag-region
          data-visible-line-count={visibleLines.length}
        >
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
