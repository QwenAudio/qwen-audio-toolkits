import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { flushWorkspace, getWorkspaceStore, writeProjectSnapshot } from '../services/workspaceStorage'

/** Cache each committed render immediately; the shared writer debounces disk I/O. */
export function useProjectAutosave(projectId: string | undefined, kind: string, state: unknown): void {
  useEffect(() => { writeProjectSnapshot(projectId, kind, state) }, [projectId, kind, state])
  useEffect(() => () => { void flushWorkspace().catch(() => {}) }, [projectId, kind])
}

export function useWorkspaceSaveStatus() {
  const store = getWorkspaceStore()
  return useSyncExternalStore(store.subscribe, store.getStatus, store.getStatus)
}

/** Flush already-cached edits when backgrounding or leaving the application. */
export function useWorkspaceCloseFlush(): void {
  useEffect(() => {
    const flush = () => { void flushWorkspace().catch(() => {}) }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [])
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let active = true
    let closing = false
    let unlisten: (() => void) | undefined
    const owner = crypto.randomUUID()
    void listen<boolean>('workspace-close-requested', async (event) => {
      if (!active || closing) return
      closing = true
      try {
        await flushWorkspace()
        if (active) await invoke('workspace_finish_close', { quit: event.payload })
      } catch {
        // A failed save keeps the window open with its error status. Another
        // close request retries the write after the user has resolved it.
      } finally {
        closing = false
      }
    }).then(async (stop) => {
      unlisten = stop
      if (!active) { stop(); return }
      await invoke('workspace_set_close_guard', { owner, enabled: true })
      if (!active) await invoke('workspace_set_close_guard', { owner, enabled: false })
    }).catch(() => {
      // If registration fails, native closing keeps its existing behavior.
      unlisten?.()
      void invoke('workspace_set_close_guard', { owner, enabled: false }).catch(() => {})
    })
    return () => {
      active = false
      unlisten?.()
      void invoke('workspace_set_close_guard', { owner, enabled: false }).catch(() => {})
    }
  }, [])
}
