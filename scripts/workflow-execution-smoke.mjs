import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const api = process.env.QWEN_AUDIO_TOOLKITS_API ?? 'http://127.0.0.1:3847/v1'
const appData = path.join(
  os.homedir(),
  'Library/Application Support/org.qwenaudio.toolkits',
)
const defaultSpeechPath = path.join(
  appData,
  'recordings/smoke-speech.wav',
)
const defaultNoisyPath = path.join(
  appData,
  'recordings/test_with_noise_48k-1785405269614.wav',
)

function resolveExistingPath(candidates, label) {
  const resolved = candidates.find((candidate) => candidate && fs.existsSync(candidate))
  if (!resolved) {
    throw new Error(
      `${label} is missing. Set QWEN_AUDIO_TOOLKITS_${label.toUpperCase()}_WAV ` +
        'or install the corresponding local model fixture.',
    )
  }
  return resolved
}

function audioInput(filePath) {
  return {
    audioDataUrl: `data:audio/wav;base64,${fs.readFileSync(filePath).toString('base64')}`,
    clipName: path.basename(filePath),
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

async function run(request) {
  const created = await requestJson(`${api}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const current = await requestJson(`${api}/runs/${created.id}`)
    if (current.status === 'completed') {
      const artifact = await requestJson(`${api}/runs/${created.id}/output`)
      return artifact.output ?? artifact
    }
    if (['failed', 'canceled'].includes(current.status)) {
      throw new Error(current.error ?? current.status)
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`workflow step timeout: ${request.title}`)
}

class SkipSmoke extends Error {}

function skipSmoke(message) {
  throw new SkipSmoke(message)
}

const speechPath = resolveExistingPath(
  [process.env.QWEN_AUDIO_TOOLKITS_SPEECH_WAV, defaultSpeechPath],
  'speech',
)
const noisyPath =
  [process.env.QWEN_AUDIO_TOOLKITS_NOISY_WAV, defaultNoisyPath].find(
    (candidate) => candidate && fs.existsSync(candidate),
  ) ?? speechPath
const speech = audioInput(speechPath)
const noisy = audioInput(noisyPath)
const results = []
const harnessCatalog = await requestJson(`${api}/harness/catalog`)
const providerStatus = new Map(
  harnessCatalog.providers.map((provider) => [provider.id, provider.status]),
)
const installedProviderIds = new Set(
  (await requestJson(`${api}/plugins`))
    .filter((plugin) => plugin.installed && plugin.providerId)
    .map((plugin) => plugin.providerId),
)
const localEnhancerProvider = [
  'plugin.k2-fsa.gtcrn-simple',
  'plugin.rikorose.deepfilternet3',
].find((providerId) => installedProviderIds.has(providerId))

async function smoke(name, execute) {
  const startedAt = Date.now()
  try {
    const detail = await execute()
    results.push({
      name,
      status: 'passed',
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      ...detail,
    })
    process.stderr.write(`PASS ${name}\n`)
  } catch (error) {
    if (error instanceof SkipSmoke) {
      results.push({
        name,
        status: 'skipped',
        elapsedSeconds: (Date.now() - startedAt) / 1000,
        reason: error.message,
      })
      process.stderr.write(`SKIP ${name}: ${error.message}\n`)
      return
    }
    results.push({
      name,
      status: 'failed',
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      error: error instanceof Error ? error.message : String(error),
    })
    process.stderr.write(`FAIL ${name}\n`)
  }
}

await smoke('本地字幕后处理链', async () => {
  if (!localEnhancerProvider) {
    skipSmoke('缺少可用的本地音频增强模型')
  }
  for (const providerId of [
    'local.silero-vad',
    'plugin.funaudiollm.sensevoice-small-gguf',
    'plugin.k2-fsa.punctuation-zh-en',
    'plugin.wetext.text-normalization',
  ]) {
    if (!installedProviderIds.has(providerId)) {
      skipSmoke(`缺少本地工作流依赖 ${providerId}`)
    }
  }
  const enhanced = await run({
    capability: 'audio.enhance',
    providerId: localEnhancerProvider,
    routing: 'local',
    title: `Workflow · ${localEnhancerProvider}`,
    input: noisy,
    parameters: { operations: ['denoise'], denoiseStrength: 0.7 },
  })
  const enhancedInput = {
    audioDataUrl: enhanced.dataUrl,
    clipName: enhanced.fileName,
  }
  const vad = await run({
    capability: 'speech.detect',
    providerId: 'local.silero-vad',
    routing: 'local',
    title: 'Workflow · VAD',
    input: enhancedInput,
    parameters: {},
  })
  const asr = await run({
    capability: 'speech.transcribe',
    providerId: 'plugin.funaudiollm.sensevoice-small-gguf',
    routing: 'local',
    title: 'Workflow · ASR',
    input: { ...enhancedInput, speechSegments: vad.segments },
    parameters: {},
  })
  const punctuation = await run({
    capability: 'text.punctuate',
    providerId: 'plugin.k2-fsa.punctuation-zh-en',
    routing: 'local',
    title: 'Workflow · Punctuation',
    input: { text: asr.text },
    parameters: {},
  })
  const itn = await run({
    capability: 'text.normalize',
    providerId: 'plugin.wetext.text-normalization',
    routing: 'local',
    title: 'Workflow · ITN',
    input: { text: punctuation.text },
    parameters: { operator: 'itn', language: 'auto' },
  })
  if (!itn.text?.trim()) throw new Error('后处理链没有文本输出')
  return {
    speechSegments: vad.segments.length,
    textLength: itn.text.length,
  }
})

await smoke('云端实时助手模型链', async () => {
  if (providerStatus.get('api.bailian') !== 'ready') {
    skipSmoke('阿里云百炼 API 尚未配置')
  }
  const asr = await run({
    capability: 'speech.transcribe',
    providerId: 'api.bailian',
    routing: 'quality',
    title: 'Workflow · Qwen Audio Streaming ASR',
    input: speech,
    parameters: { modelId: 'qwen-audio-3.0-asr-flash-streaming' },
  })
  const llm = await run({
    capability: 'text.generate',
    providerId: 'api.bailian',
    routing: 'quality',
    title: 'Workflow · Qwen3.7',
    input: {
      messages: [
        { role: 'system', content: '用一句简短中文回答。' },
        { role: 'user', content: asr.text },
      ],
    },
    parameters: { modelId: 'qwen3.7-plus', maxTokens: 64 },
  })
  const tts = await run({
    capability: 'speech.synthesize',
    providerId: 'api.bailian',
    routing: 'quality',
    title: 'Workflow · CosyVoice',
    input: { text: llm.text },
    parameters: {
      modelId: 'cosyvoice-v2',
      voice: 'longxiaochun_v2',
      speed: 1,
    },
  })
  if (!tts.dataUrl || !tts.duration) throw new Error('TTS 没有音频输出')
  return { replyLength: llm.text.length, audioDuration: tts.duration }
})

await smoke('音频标签输出链', async () => {
  const output = await run({
    capability: 'audio.classify',
    providerId: 'plugin.k2-fsa.audio-tagging',
    routing: 'local',
    title: 'Workflow · Audio Tagging',
    input: speech,
    parameters: {},
  })
  if (!output.tags?.length) throw new Error('标签节点没有输出')
  return { tagCount: output.tags.length }
})

await smoke('本地双音轨分离链', async () => {
  if (!installedProviderIds.has('plugin.k2-fsa.spleeter-2stems')) {
    skipSmoke('缺少本地工作流依赖 plugin.k2-fsa.spleeter-2stems')
  }
  const output = await run({
    capability: 'audio.separate',
    providerId: 'plugin.k2-fsa.spleeter-2stems',
    routing: 'local',
    title: 'Workflow · Spleeter',
    input: speech,
    parameters: {},
  })
  if (output.tracks?.length !== 2) throw new Error('分离结果不是两条音轨')
  return { trackCount: output.tracks.length }
})
console.log(JSON.stringify(results, null, 2))
if (results.some((result) => result.status === 'failed')) process.exitCode = 1
