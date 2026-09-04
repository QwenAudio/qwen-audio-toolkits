import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

interface ExportableAudioFile {
  fileName: string
  filePath: string
  dataUrl: string
}

function isTauriRuntime(): boolean {
  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  )
}

function fileExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.trim().toLowerCase()
  return extension && /^[a-z0-9]+$/.test(extension) ? extension : 'wav'
}

export async function exportAudioFile(
  audio: ExportableAudioFile,
): Promise<string | null> {
  if (!isTauriRuntime()) {
    const anchor = document.createElement('a')
    anchor.href = audio.dataUrl
    anchor.download = audio.fileName
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    return audio.fileName
  }

  const extension = fileExtension(audio.fileName)
  const destinationPath = await save({
    title: '导出音频',
    defaultPath: audio.fileName,
    canCreateDirectories: true,
    filters: [{ name: '音频文件', extensions: [extension] }],
  })
  if (!destinationPath) return null

  await invoke<number>('export_audio_file', {
    sourcePath: audio.filePath,
    destinationPath,
  })
  return destinationPath
}
