import { relaunch } from '@tauri-apps/plugin-process'
import {
  check,
  type DownloadEvent,
  type Update,
} from '@tauri-apps/plugin-updater'
import { isTauriRuntime } from './harness'

export interface AppUpdateInfo {
  currentVersion: string
  version: string
  date?: string
  notes?: string
}

export type AppUpdateCheck =
  | { status: 'current' }
  | { status: 'available'; update: AppUpdateInfo }
  | { status: 'unavailable'; message: string }

let pendingUpdate: Update | null = null

export async function checkForAppUpdate(): Promise<AppUpdateCheck> {
  if (!isTauriRuntime()) {
    return { status: 'unavailable', message: '仅桌面版支持软件更新' }
  }
  if (import.meta.env.DEV) {
    return { status: 'unavailable', message: '开发版本不检查软件更新' }
  }

  await pendingUpdate?.close()
  pendingUpdate = await check({ timeout: 15_000 })
  if (!pendingUpdate) return { status: 'current' }
  return {
    status: 'available',
    update: {
      currentVersion: pendingUpdate.currentVersion,
      version: pendingUpdate.version,
      date: pendingUpdate.date,
      notes: pendingUpdate.body,
    },
  }
}

export async function installAppUpdate(
  onProgress: (downloaded: number, total?: number) => void,
): Promise<void> {
  if (!pendingUpdate) throw new Error('没有可安装的软件更新')
  let downloaded = 0
  let total: number | undefined
  const handleEvent = (event: DownloadEvent) => {
    if (event.event === 'Started') {
      total = event.data.contentLength
      onProgress(0, total)
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress(downloaded, total)
    } else {
      onProgress(total ?? downloaded, total)
    }
  }
  await pendingUpdate.downloadAndInstall(handleEvent, { timeout: 10 * 60_000 })
  await relaunch()
}
