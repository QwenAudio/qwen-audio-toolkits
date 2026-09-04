import { emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor, PhysicalPosition } from '@tauri-apps/api/window'
import { isTauriRuntime } from './harness'

const CAPTION_WINDOW_LABEL = 'captions'
export const CAPTION_UPDATE_EVENT = 'caption-output-update'
let outputQueue: Promise<void> = Promise.resolve()
let captionPositioned = false

export interface CaptionOutputUpdate {
  text: string
  isFinal: boolean
  status?: 'listening' | 'speech' | 'stopped' | 'error'
  reset?: boolean
  metrics?: {
    rtf?: number
    vadRemainingMs?: number
    vadSilenceMs?: number
  }
}

async function captionWindow(): Promise<WebviewWindow | null> {
  if (!isTauriRuntime()) return null
  return WebviewWindow.getByLabel(CAPTION_WINDOW_LABEL)
}

function enqueueOutput(task: () => Promise<void>): Promise<void> {
  outputQueue = outputQueue.then(task, task)
  return outputQueue
}

export async function showCaptionOutput(
  status: CaptionOutputUpdate['status'] = 'listening',
): Promise<void> {
  return enqueueOutput(async () => {
    const window = await captionWindow()
    if (!window) return
    if (!captionPositioned) {
      const [monitor, size] = await Promise.all([
        currentMonitor(),
        window.outerSize(),
      ])
      if (monitor) {
        const { position, size: workSize } = monitor.workArea
        const bottomMargin = Math.round(58 * monitor.scaleFactor)
        await window.setPosition(
          new PhysicalPosition(
            Math.round(position.x + (workSize.width - size.width) / 2),
            Math.round(
              position.y + workSize.height - size.height - bottomMargin,
            ),
          ),
        )
        captionPositioned = true
      }
    }
    await window.show()
    await emitTo<CaptionOutputUpdate>(
      CAPTION_WINDOW_LABEL,
      CAPTION_UPDATE_EVENT,
      { text: '', isFinal: false, status, reset: true },
    )
  })
}

export async function updateCaptionOutputStatus(
  status: CaptionOutputUpdate['status'],
): Promise<void> {
  if (!isTauriRuntime()) return
  return enqueueOutput(() =>
    emitTo<CaptionOutputUpdate>(
      CAPTION_WINDOW_LABEL,
      CAPTION_UPDATE_EVENT,
      { text: '', isFinal: false, status },
    ),
  )
}

export async function publishCaptionOutput(
  text: string,
  isFinal: boolean,
  status: CaptionOutputUpdate['status'] = 'speech',
  metrics?: CaptionOutputUpdate['metrics'],
): Promise<void> {
  if (!text.trim() || !isTauriRuntime()) return
  return enqueueOutput(() =>
    emitTo<CaptionOutputUpdate>(
      CAPTION_WINDOW_LABEL,
      CAPTION_UPDATE_EVENT,
      { text, isFinal, status, metrics },
    ),
  )
}

export async function stopCaptionOutput(): Promise<void> {
  if (!isTauriRuntime()) return
  return enqueueOutput(() =>
    emitTo<CaptionOutputUpdate>(
      CAPTION_WINDOW_LABEL,
      CAPTION_UPDATE_EVENT,
      { text: '', isFinal: false, status: 'stopped' },
    ),
  )
}
