const defaultDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function isRetryableApiError(message) {
  return /error sending request|timed? out|connection|temporar|网络|连接|超时/iu.test(String(message))
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
    const runRecord = await requestJson(`${api}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    process.stdout.write(`${request.title}: started (${runRecord.id})\n`)
    const deadline = Date.now() + timeoutMs
    const startedAt = Date.now()
    let nextHeartbeat = startedAt + 15_000
    while (Date.now() < deadline) {
      const current = await requestJson(`${api}/runs/${runRecord.id}`)
      if (current.status === 'completed') {
        const result = await requestJson(`${api}/runs/${runRecord.id}/output`)
        process.stdout.write(`${request.title}: completed\n`)
        return result.output ?? result
      }
      if (current.status === 'failed' || current.status === 'canceled') {
        const message = current.error ?? `${request.title}: ${current.status}`
        if (current.status === 'failed' && attempt < 3 && isRetryableApiError(message)) {
          const progress = getProgress()
          reportProgress(progress.stage, progress.progress, `API 网络波动，正在自动重试 ${attempt + 1}/3`, {
            retryAttempt: attempt + 1,
            retryLimit: 3,
          })
          await delay(attempt * 1200)
          return execute(request, timeoutMs, attempt + 1)
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
