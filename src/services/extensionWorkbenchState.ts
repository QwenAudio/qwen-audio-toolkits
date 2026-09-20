export const EXTENSION_WORKBENCH_STORAGE_KEY =
  'qwen-audio-toolkits.extension-workbench-v1'

export type ExtensionWorkbenchPage =
  | 'models'
  | 'podcast'
  | 'meeting-notes'
  | 'video-dubbing'

export const extensionWorkbenchPageLabels: Readonly<
  Record<ExtensionWorkbenchPage, string>
> = {
  models: '模型',
  podcast: '播客',
  'meeting-notes': '会议纪要',
  'video-dubbing': '视频配音',
}

const ENABLED_EXTENSION_WORKBENCH_PAGES: readonly ExtensionWorkbenchPage[] = [
  'models',
  'podcast',
  'meeting-notes',
  'video-dubbing',
]

const DISABLED_EXTENSION_WORKBENCH_PAGES: readonly ExtensionWorkbenchPage[] = []

export function readExtensionWorkbenchEnabled(
  storage: Pick<Storage, 'getItem'>,
): boolean {
  try {
    return storage.getItem(EXTENSION_WORKBENCH_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeExtensionWorkbenchEnabled(
  storage: Pick<Storage, 'setItem'>,
  enabled: boolean,
): void {
  storage.setItem(EXTENSION_WORKBENCH_STORAGE_KEY, enabled ? 'true' : 'false')
}

export function extensionWorkbenchPages(
  enabled: boolean,
): readonly ExtensionWorkbenchPage[] {
  return enabled
    ? ENABLED_EXTENSION_WORKBENCH_PAGES
    : DISABLED_EXTENSION_WORKBENCH_PAGES
}

export function resolveExtensionWorkbenchPage(
  enabled: boolean,
  page: string | null,
): ExtensionWorkbenchPage | null {
  if (!enabled) return null
  return ENABLED_EXTENSION_WORKBENCH_PAGES.some((candidate) => candidate === page)
    ? (page as ExtensionWorkbenchPage)
    : 'models'
}
