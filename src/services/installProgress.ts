export type InstallProgressScope = 'model' | 'dependency' | 'package'

const MODEL_PROGRESS_LIMIT = 84
const DEPENDENCY_PROGRESS_BASE = MODEL_PROGRESS_LIMIT
const DEPENDENCY_PROGRESS_LIMIT = 99
const PACKAGE_PROGRESS_LIMIT = 99

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)))
}

/**
 * Maps backend progress for one install operation into the overall install
 * progress shown by the UI. Model installation owns the first 84%, dependency
 * installation owns 84–99%, and the final successful command completion is
 * represented by 100% in the caller.
 */
export function mapInstallProgress(
  progress: number,
  scope: InstallProgressScope,
): number {
  const normalized = clampProgress(progress)
  if (scope === 'dependency') {
    return (
      DEPENDENCY_PROGRESS_BASE +
      Math.round(
        (normalized * (DEPENDENCY_PROGRESS_LIMIT - DEPENDENCY_PROGRESS_BASE)) /
          100,
      )
    )
  }
  if (scope === 'package') {
    return Math.round((normalized * PACKAGE_PROGRESS_LIMIT) / 100)
  }
  return Math.round((normalized * MODEL_PROGRESS_LIMIT) / 100)
}

export function advanceInstallProgress(
  current: number,
  progress: number,
  scope: InstallProgressScope,
): number {
  return Math.max(current, mapInstallProgress(progress, scope))
}

export function parseInstallSpeed(detail: string): string | undefined {
  return detail
    .match(/·\s*([^·]+\/s)$/)?.[1]
    ?.replace(/\s+/g, '')
}
