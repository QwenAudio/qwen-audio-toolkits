export type LocalModelInstallResult<T> =
  | {
      status: 'installed'
      installed: T
      optionalFailures: readonly string[]
    }
  | {
      status: 'dependency-failed'
      installed: T
      error: unknown
    }

/**
 * Refresh after a main model is installed even when a required dependency
 * fails, so callers can render the actual installed state before reporting it.
 */
export async function installLocalModelAndRefresh<T>(actions: {
  installModel(): Promise<T>
  installDependencies(model: T): Promise<readonly string[]>
  refreshModels(): Promise<void>
}): Promise<LocalModelInstallResult<T>> {
  const installed = await actions.installModel()
  let optionalFailures: readonly string[]

  try {
    optionalFailures = await actions.installDependencies(installed)
  } catch (error) {
    try {
      await actions.refreshModels()
    } catch {
      // The dependency error remains the user-visible result.
    }
    return { status: 'dependency-failed', installed, error }
  }

  await actions.refreshModels()
  return { status: 'installed', installed, optionalFailures }
}

/** Persist cloud state only after a refresh has confirmed the new catalog. */
export async function refreshThenPersistCloudModelState(actions: {
  refreshModels(): Promise<void>
  persistCloudState(): void
}): Promise<void> {
  await actions.refreshModels()
  actions.persistCloudState()
}
