import type { VideoDubbingTurn } from './services/videoDubbing'

export function isDemoMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')
}

/** Extension pages do not inject task-gallery fixtures into the boss workspace. */
export function demoProjectSnapshot(_projectId: string | undefined): unknown {
  return null
}

export const demoVideoDubbingTurns: VideoDubbingTurn[] = []
