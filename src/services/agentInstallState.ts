export const installationStates = new Map<string, { id: string; status: string; error?: string; kind?: string }>()
export const installationListeners = new Set<() => void>()
export function installationChanged(id: string, status: string, error?: string, kind?: string) {
  installationStates.set(id, { id, status, error, kind })
  for (const update of installationListeners) update()
}
