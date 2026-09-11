const defaultDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function isRetryableApiError(message) {
  return /error sending request|timed? out|connection|temporar|fetch failed|econn|enotfound|eai_again|socket|网络|连接|超时/iu.test(String(message))
}

function retryMessageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createHarnessClient({
  api,
  reportProgress,
  getProgress = () => ({ stage: 'preparing', progress: 0 }),
  fetchImpl = fetch,
  delay = defaultDelay,
}) {
  async function requestJson(url, options) {
    const response = await fetchImpl(url, options)
    if (!response.ok) throw new Error(await response.text())
    return response.json()
  }

  async function execute(request, timeoutMs = 10 * 60_000, attempt = 1) {
    async function retryLater() {
      const progress = getProgress()
      reportProgress(progress.stage, progress.progress, `API 网络波动，正在自动重试 ${attempt + 1}/3`, {
        retryAttempt: attempt + 1,
        retryLimit: 3,
      })
      await delay(attempt * 8000)
      return execute(request, timeoutMs, attempt + 1)
    }
    let runRecord
    try {
      runRecord = await requestJson(`${api}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
    } catch (error) {
      if (attempt < 3 && isRetryableApiError(retryMessageOf(error))) return retryLater()
      throw error
    }
    process.stdout.write(`${request.title}: started (${runRecord.id})\n`)
    const deadline = Date.now() + timeoutMs
    const startedAt = Date.now()
    let nextHeartbeat = startedAt + 15_000
    while (Date.now() < deadline) {
      let current
      try {
        current = await requestJson(`${api}/runs/${runRecord.id}`)
      } catch (error) {
        // Transient poll failures ride out until the deadline instead of
        // discarding an in-flight harness run.
        if (isRetryableApiError(retryMessageOf(error))) {
          await delay(800)
          continue
        }
        throw error
      }
      if (current.status === 'completed') {
        try {
          const result = await requestJson(`${api}/runs/${runRecord.id}/output`)
          process.stdout.write(`${request.title}: completed\n`)
          return result.output ?? result
        } catch (error) {
          if (isRetryableApiError(retryMessageOf(error))) {
            await delay(800)
            continue
          }
          throw error
        }
      }
      if (current.status === 'failed' || current.status === 'canceled') {
        const message = current.error ?? `${request.title}: ${current.status}`
        if (current.status === 'failed' && attempt < 3 && isRetryableApiError(message)) {
          return retryLater()
        }
        throw new Error(message)
      }
      if (Date.now() >= nextHeartbeat) {
        const waitedSeconds = Math.round((Date.now() - startedAt) / 1000)
        const progress = getProgress()
        reportProgress(progress.stage, progress.progress, `API 正在处理，已等待 ${waitedSeconds} 秒`)
        nextHeartbeat = Date.now() + 15_000
      }
      await delay(250)
    }
    await fetchImpl(`${api}/runs/${runRecord.id}/cancel`, { method: 'POST' }).catch(() => {})
    throw new Error(`${request.title}: timeout`)
  }

  return { execute, requestJson }
}
