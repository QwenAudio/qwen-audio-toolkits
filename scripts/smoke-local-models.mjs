import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const api = process.env.QWEN_AUDIO_API ?? 'http://127.0.0.1:3847'
const appData = path.join(
  os.homedir(),
  'Library/Application Support/org.qwenaudio.toolkits',
)
const samplePath = path.join(
  appData,
  'models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav',
)
const englishSamplePath = path.join(
  appData,
  'plugins/usefulsensors.moonshine-v2-tiny-en/models/moonshine-v2-tiny-en-quantized/test_wavs/0.wav',
)
const senseVoiceEnglishSamplePath = path.join(
  appData,
  'models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/en.wav',
)

function audioInput(filePath) {
  return {
    audioDataUrl: `data:audio/wav;base64,${fs.readFileSync(filePath).toString('base64')}`,
    clipName: path.basename(filePath),
  }
}

function resolveAudioPath(candidates, label) {
  const resolved = candidates.find((candidate) => candidate && fs.existsSync(candidate))
  if (!resolved) {
    throw new Error(
      `${label} audio fixture is missing. Set QWEN_AUDIO_TOOLKITS_${label.toUpperCase()}_WAV ` +
        'or install the corresponding local model fixture.',
    )
  }
  return resolved
}

function wavSpec(bytes) {
  if (
    bytes.length < 12 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('audio artifact is not a RIFF/WAVE file')
  }
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ' && offset + 8 + chunkSize <= bytes.length) {
      if (chunkSize < 16) throw new Error('audio fmt chunk is truncated')
      return {
        format: bytes.readUInt16LE(offset + 8),
        bitsPerSample: bytes.readUInt16LE(offset + 22),
      }
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  throw new Error('audio artifact is missing a valid fmt chunk')
}

function assertWebviewSafeWav(bytes, label) {
  const spec = wavSpec(bytes)
  if (spec.format !== 1 || spec.bitsPerSample !== 16) {
    throw new Error(
      `${label} must be PCM16 WAV, received format ${spec.format} / ${spec.bitsPerSample}-bit`,
    )
  }
}

function dataUrlBytes(dataUrl) {
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error('audio data URL is malformed')
  return Buffer.from(dataUrl.slice(separator + 1), 'base64')
}

const defaultAudioPath = resolveAudioPath(
  [process.env.QWEN_AUDIO_TOOLKITS_SPEECH_WAV, samplePath],
  'speech',
)
const defaultAudioInput = audioInput(defaultAudioPath)
const englishAudioInput = audioInput(
  process.env.QWEN_AUDIO_TOOLKITS_ENGLISH_WAV &&
    fs.existsSync(process.env.QWEN_AUDIO_TOOLKITS_ENGLISH_WAV)
    ? process.env.QWEN_AUDIO_TOOLKITS_ENGLISH_WAV
    : fs.existsSync(englishSamplePath)
      ? englishSamplePath
      : fs.existsSync(senseVoiceEnglishSamplePath)
        ? senseVoiceEnglishSamplePath
        : defaultAudioPath,
)

async function jsonFetch(url, init) {
  const response = await fetch(`${api}${url}`, init)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? JSON.stringify(body))
  return body
}

function requestFor(plugin) {
  const capability = plugin.harnessCapabilities[0]
  const prefersEnglish = [
    'nemo-canary',
    'nemo-parakeet',
    'moonshine-v2',
  ].includes(plugin.adapter)
  const input = { ...(prefersEnglish ? englishAudioInput : defaultAudioInput) }
  const parameters = {}

  if (capability === 'speech.synthesize') {
    input.text = ['kitten', 'pocket-tts', 'supertonic'].includes(plugin.adapter)
      ? 'This is a local speech synthesis smoke test.'
      : '这是一次本地语音合成测试。'
    delete input.audioDataUrl
    delete input.clipName
    parameters.sid =
      plugin.adapter === 'kokoro' || plugin.id === 'k2-fsa.vits-aishell3'
        ? 3
        : 0
    parameters.speed = 1
    if (plugin.adapter === 'supertonic') parameters.language = 'en'
    if (['zipvoice', 'pocket-tts', 'cosyvoice-local'].includes(plugin.adapter)) {
      parameters.referenceAudioDataUrl = defaultAudioInput.audioDataUrl
    }
    if (['zipvoice', 'cosyvoice-local'].includes(plugin.adapter)) {
      parameters.referenceText = '开放时间早上九点至下午五点'
    }
    if (plugin.adapter === 'zipvoice') parameters.numSteps = 4
  } else if (capability === 'text.punctuate') {
    input.text = '今天上午我们讨论了语音识别下午继续测试语音合成'
    delete input.audioDataUrl
    delete input.clipName
  } else if (capability === 'text.normalize') {
    input.text = '我在2026年8月4日上午9点开会'
    delete input.audioDataUrl
    delete input.clipName
    parameters.operator = 'tn'
    parameters.language = 'zh'
  } else if (capability === 'audio.enhance') {
    parameters.operations = ['denoise']
  } else if (capability === 'speech.keyword') {
    parameters.keywords = []
  }

  return {
    capability,
    providerId: plugin.providerId,
    title: `${plugin.name} smoke`,
    input,
    parameters,
  }
}

function assertOutput(capability, response) {
  const output = response.output ?? response
  const artifacts = response.run?.artifacts ?? []
  const audioArtifacts = artifacts.filter((artifact) => artifact.kind === 'audio')
  const hasValidAudio = audioArtifacts.some(
    (artifact) =>
      artifact.filePath &&
      fs.existsSync(artifact.filePath) &&
      fs.statSync(artifact.filePath).size > 44,
  )

  for (const artifact of audioArtifacts) {
    if (artifact.filePath && fs.existsSync(artifact.filePath)) {
      assertWebviewSafeWav(
        fs.readFileSync(artifact.filePath),
        `${capability} artifact`,
      )
    }
  }
  if (typeof output.dataUrl === 'string') {
    assertWebviewSafeWav(dataUrlBytes(output.dataUrl), `${capability} output`)
  }
  if (Array.isArray(output.tracks)) {
    for (const track of output.tracks) {
      if (typeof track.dataUrl === 'string') {
        assertWebviewSafeWav(
          dataUrlBytes(track.dataUrl),
          `${capability} track ${track.id ?? track.name ?? 'unknown'}`,
        )
      }
    }
  }

  if (capability === 'speech.transcribe' && !output.text?.trim()) {
    throw new Error('transcript is empty')
  }
  if (['text.normalize', 'text.punctuate'].includes(capability) && !output.text?.trim()) {
    throw new Error('text output is empty')
  }
  if (capability === 'speech.synthesize' && !hasValidAudio) {
    throw new Error('generated audio is missing or empty')
  }
  if (capability === 'audio.enhance' && !hasValidAudio) {
    throw new Error('enhanced audio is missing or empty')
  }
  if (capability === 'audio.separate') {
    const tracks = Array.isArray(output.tracks) ? output.tracks : []
    if (tracks.length < 2) throw new Error('source separation returned fewer than 2 tracks')
  }
  if (capability === 'speech.detect' && !Array.isArray(output.segments)) {
    throw new Error('VAD segments are missing')
  }
  if (capability === 'speaker.diarize' && !Array.isArray(output.segments)) {
    throw new Error('speaker segments are missing')
  }
  if (capability === 'speaker.embed' && !Array.isArray(output.embedding)) {
    throw new Error('speaker embedding is missing')
  }
  if (capability === 'audio.classify' && !Array.isArray(output.tags)) {
    throw new Error('audio tags are missing')
  }
  if (capability === 'speech.language' && !output.language) {
    throw new Error('detected language is missing')
  }
  if (capability === 'speech.keyword' && typeof output.detected !== 'boolean') {
    throw new Error('keyword detection result is missing')
  }
}

async function runPlugin(plugin, timeoutMs = 10 * 60_000) {
  const started = Date.now()
  const run = await jsonFetch('/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestFor(plugin)),
  })
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const current = await jsonFetch(`/v1/runs/${run.id}`)
    if (!['completed', 'failed', 'canceled', 'cancelled'].includes(current.status)) continue
    if (current.status === 'completed') {
      const output = await jsonFetch(`/v1/runs/${run.id}/output`)
      assertOutput(plugin.harnessCapabilities[0], output)
    }
    return {
      id: plugin.id,
      name: plugin.name,
      status: current.status,
      elapsedMs: current.durationMs ?? Date.now() - started,
      error: current.error ?? null,
    }
  }
  await jsonFetch(`/v1/runs/${run.id}/cancel`, { method: 'POST' }).catch(() => {})
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)
}

const requestedPluginIds = new Set(
  (process.env.QWEN_AUDIO_TOOLKITS_MODEL_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
)
const plugins = (await jsonFetch('/v1/plugins')).filter(
  (plugin) =>
    plugin.installed &&
    plugin.providerId &&
    !plugin.providerId.startsWith('api.') &&
    plugin.adapter !== 'web-audio' &&
    (requestedPluginIds.size === 0 || requestedPluginIds.has(plugin.id)),
)
const results = []

for (const plugin of plugins) {
    try {
      const result = await runPlugin(plugin)
      results.push(result)
      console.log(`${result.status === 'completed' ? 'PASS' : 'FAIL'} ${plugin.name} ${result.elapsedMs}ms${result.error ? `: ${result.error}` : ''}`)
    } catch (error) {
      const result = {
        id: plugin.id,
        name: plugin.name,
        status: 'failed',
        elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error),
      }
      results.push(result)
      console.log(`FAIL ${plugin.name}: ${result.error}`)
    }
}

const failed = results.filter((result) => result.status !== 'completed')
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed }, null, 2))
process.exitCode = failed.length ? 1 : 0
