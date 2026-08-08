import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react'
import { Upload } from 'lucide-react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  isTauriRuntime,
  readDroppedAudioFile,
} from '../services/harness'
import { isAudioFile } from '../utils/audioFiles'

interface AudioFileDropZoneProps {
  children: ReactNode
  disabled?: boolean
  onFile: (file: File) => void
  onInvalidFile?: (message: string) => void
}

const DROP_EVENT_SETTLE_MS = 400
const DUPLICATE_FILE_WINDOW_MS = 1_000

function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files.length > 0) return true
  return Array.from(dataTransfer.types).some((type) => {
    const normalized = type.toLowerCase()
    return (
      normalized === 'files' ||
      normalized === 'public.file-url' ||
      normalized === 'text/uri-list' ||
      normalized.includes('file')
    )
  })
}

function firstDataTransferFile(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer) return null
  if (dataTransfer.files[0]) return dataTransfer.files[0]
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}

export function AudioFileDropZone({
  children,
  disabled = false,
  onFile,
  onInvalidFile,
}: AudioFileDropZoneProps) {
  const dragDepthRef = useRef(0)
  const lastDropAtRef = useRef(0)
  const lastDeliveredFileRef = useRef<{ key: string; at: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const disabledRef = useRef(disabled)
  const onFileRef = useRef(onFile)
  const onInvalidFileRef = useRef(onInvalidFile)

  useEffect(() => {
    disabledRef.current = disabled
    onFileRef.current = onFile
    onInvalidFileRef.current = onInvalidFile
  }, [disabled, onFile, onInvalidFile])

  const resetDragging = useCallback(() => {
    dragDepthRef.current = 0
    setDragging(false)
  }, [])

  const markDropSettled = useCallback(() => {
    lastDropAtRef.current = Date.now()
    resetDragging()
  }, [resetDragging])

  const deliverFile = useCallback((file: File) => {
    if (disabledRef.current) return
    if (!isAudioFile(file)) {
      onInvalidFileRef.current?.('请拖入音频文件')
      return
    }
    const now = Date.now()
    const key = `${file.name}:${file.size}`
    const previous = lastDeliveredFileRef.current
    if (
      previous?.key === key &&
      now - previous.at < DUPLICATE_FILE_WINDOW_MS
    ) {
      return
    }
    lastDeliveredFileRef.current = { key, at: now }
    onFileRef.current(file)
  }, [])

  useEffect(() => {
    if (!disabled) return
    resetDragging()
  }, [disabled, resetDragging])

  useEffect(() => {
    const handleWindowDragOver = (event: DragEvent) => {
      if (!disabledRef.current && hasFilePayload(event.dataTransfer)) {
        event.preventDefault()
      }
    }
    const handleWindowDrop = (event: DragEvent) => {
      if (hasFilePayload(event.dataTransfer)) event.preventDefault()
      markDropSettled()
    }
    const handleWindowReset = () => resetDragging()
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') resetDragging()
    }
    window.addEventListener('dragover', handleWindowDragOver, true)
    window.addEventListener('drop', handleWindowDrop, true)
    window.addEventListener('dragend', handleWindowReset, true)
    window.addEventListener('blur', handleWindowReset)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver, true)
      window.removeEventListener('drop', handleWindowDrop, true)
      window.removeEventListener('dragend', handleWindowReset, true)
      window.removeEventListener('blur', handleWindowReset)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [markDropSettled, resetDragging])

  useEffect(() => {
    if (!isTauriRuntime()) return undefined
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disabledRef.current) return
        if (
          event.payload.type === 'enter' ||
          event.payload.type === 'over'
        ) {
          if (Date.now() - lastDropAtRef.current < DROP_EVENT_SETTLE_MS) {
            return
          }
          setDragging(true)
          return
        }
        if (event.payload.type === 'leave') {
          resetDragging()
          return
        }
        if (event.payload.type !== 'drop') return
        markDropSettled()
        const path = event.payload.paths[0]
        if (!path) return
        void readDroppedAudioFile(path)
          .then(deliverFile)
          .catch((error) =>
            onInvalidFileRef.current?.(
              error instanceof Error ? error.message : String(error),
            ),
          )
      })
      .then((remove) => {
        if (disposed) remove()
        else unlisten = remove
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [deliverFile, markDropSettled, resetDragging])

  const acceptsDrag = (event: ReactDragEvent<HTMLDivElement>) =>
    !disabled && hasFilePayload(event.dataTransfer)

  return (
    <div
      className={`audio-file-drop-zone${dragging ? ' dragging' : ''}`}
      onDragEnter={(event) => {
        if (!acceptsDrag(event)) return
        event.preventDefault()
        if (Date.now() - lastDropAtRef.current < DROP_EVENT_SETTLE_MS) return
        dragDepthRef.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        markDropSettled()
        if (disabled) return
        const file = firstDataTransferFile(event.dataTransfer)
        if (!file) return
        deliverFile(file)
      }}
      onDragEnd={resetDragging}
    >
      {children}
      {dragging && (
        <div className="audio-file-drop-overlay" aria-hidden="true">
          <Upload size={18} />
          <strong>松开即可上传音频</strong>
        </div>
      )}
    </div>
  )
}
