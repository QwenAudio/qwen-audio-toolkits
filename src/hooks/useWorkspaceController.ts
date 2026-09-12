import { useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { registerWorkspaceController, type WorkspaceController } from '../services/workspaceController'

/** Route chat operations to the latest committed state of this mounted editor. */
export function useWorkspaceController(projectId: string | undefined, controller: WorkspaceController): void {
  const latest = useRef(controller)
  useLayoutEffect(() => { latest.current = controller })
  useEffect(() => {
    if (!projectId) return
    return registerWorkspaceController(projectId, {
      getState: () => latest.current.getState(),
      execute: async command => {
        const result = await latest.current.execute(command)
        // Async handlers may finish with batched React updates. Commit those before
        // returning, so the runner can distinguish this command from later edits.
        flushSync(() => {})
        return result
      },
    })
  }, [projectId])
}
