import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const api = process.env.QWEN_AUDIO_TOOLKITS_API ?? 'http://127.0.0.1:3847/v1'
const cloudMode = process.env.VIDEO_TRANSLATION_MODE === 'bailian'
const cloudTtsModel = 'qwen-audio-3.0-tts-plus'
const rhythmPlanVersion = 1
const minimumInternalPauseSeconds = 0.32
const speechEdgeTrimVersion = 2
const speechEdgeThreshold = '-55dB'
const speechEdgeSafetySeconds = 0.08
const inputPath = path.resolve(process.argv[2] ?? '')
const outputDir = path.resolve(process.argv[3] ?? 'artifacts/video-translation-demo')
const userInstruction = String(process.env.VIDEO_TRANSLATION_PROMPT ?? '').trim()
const progressPrefix = '@@QWEN_VIDEO_TRANSLATION@@'
const textGenerationTimeoutMs = 12 * 60_000
let latestStage = 'preparing'
let latestProgress = 0

function reportProgress(stage, progress, message, extra = {}) {
  latestStage = stage
  latestProgress = progress
  process.stdout.write(`${progressPrefix}${JSON.stringify({ stage, progress, message, ...extra })}\n`)
}

function reportFatal(error) {
  const message = error instanceof Error ? error.message : String(error)
  reportProgress('failed', 100, '视频翻译失败', { status: 'failed', error: message })
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

process.on('uncaughtException', reportFatal)
process.on('unhandledRejection', reportFatal)

if (!inputPath || !fs.existsSync(inputPath)) {
  throw new Error('Usage: node scripts/video-translation-demo.mjs <video> [output-directory]')
}

fs.mkdirSync(outputDir, { recursive: true })
reportProgress('preparing', 3, '正在准备视频素材')

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`)
  return result.stdout
}

function audioInput(filePath) {
  const bytes = fs.readFileSync(filePath)
  return {
    audioDataUrl: `data:audio/wav;base64,${bytes.toString('base64')}`,
    clipName: path.basename(filePath),
  }
}

function readBailianConfig() {
  const configPath = path.join(
    os.homedir(),
    'Library/Application Support/org.qwenaudio.toolkits/providers/bailian.json',
  )
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!config.enabled || !config.apiKey?.trim()) throw new Error('Bailian provider is not configured')
  return config
}

async function createBailianVoice(reference, speaker) {
  const config = readBailianConfig()
  const prefix = `frdl${shortHash(`${speaker}:${reference.text}`).slice(0, 6)}`
  const response = await fetch(`${String(config.baseUrl).replace(/\/$/u, '')}/api/v1/services/audio/tts/customization`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: cloudTtsModel,
        prefix,
        language_hints: ['en'],
        url: audioInput(reference.filePath).audioDataUrl,
        enable_preprocess: true,
        max_prompt_audio_length: 20,
      },
    }),
  })
  const raw = await response.json()
  if (!response.ok || !raw.output?.voice_id) {
    throw new Error(`Bailian voice enrollment failed: ${raw.message ?? response.status}`)
  }
  return {
    id: raw.output.voice_id,
    targetModel: cloudTtsModel,
    speaker,
    referenceText: reference.text,
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

function retryableApiError(message) {
  return /error sending request|timed? out|connection|temporar|网络|连接|超时/iu.test(String(message))
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
      if (current.status === 'failed' && attempt < 3 && retryableApiError(message)) {
        reportProgress(
          latestStage,
          latestProgress,
          `API 网络波动，正在自动重试 ${attempt + 1}/3`,
          { retryAttempt: attempt + 1, retryLimit: 3 },
        )
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200))
        return execute(request, timeoutMs, attempt + 1)
      }
      throw new Error(message)
    }
    if (Date.now() >= nextHeartbeat) {
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1000)
      reportProgress(latestStage, latestProgress, `API 正在处理，已等待 ${waitedSeconds} 秒`)
      nextHeartbeat = Date.now() + 15_000
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await fetch(`${api}/runs/${runRecord.id}/cancel`, { method: 'POST' }).catch(() => {})
  throw new Error(`${request.title}: timeout`)
}

function saveJson(name, value) {
  fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function cachedJson(name, producer, isValid = () => true) {
  const filePath = path.join(outputDir, name)
  if (fs.existsSync(filePath)) {
    const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (isValid(cached)) return cached
  }
  const value = await producer()
  saveJson(name, value)
  return value
}

function probeDuration(filePath) {
  return Number(run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]).trim())
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 10)
}

function speakerAt(start, end, diarization) {
  let best = null
  let bestOverlap = -1
  for (const segment of diarization.segments ?? []) {
    const overlap = Math.max(0, Math.min(end, segment.end) - Math.max(start, segment.start))
    if (overlap > bestOverlap) {
      best = segment.speaker
      bestOverlap = overlap
    }
  }
  return best ?? 'SPK 1'
}

function buildRhythmSegments(tokens, turnId) {
  const groups = []
  let current = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    current.push(token)
    const next = tokens[index + 1]
    if (!next || next.start - token.end >= minimumInternalPauseSeconds) {
      groups.push(current)
      current = []
    }
  }
  return groups.map((group, index) => ({
    id: `${turnId}-phrase-${index + 1}`,
    start: group[0].start,
    end: group.at(-1).end,
    sourceText: group.map((token) => token.text).join('').trim(),
  }))
}

function buildUtterances(transcription, diarization) {
  const tokens = transcription.segments?.flatMap((segment) => segment.tokens ?? []) ?? []
  const utterances = []
  let current = []
  for (const token of tokens) {
    if (!Number.isFinite(token.start) || !Number.isFinite(token.end) || !token.text) continue
    current.push(token)
    const text = current.map((item) => item.text).join('').trim()
    const duration = token.end - current[0].start
    if ((/[.!?][”"']?$/u.test(text) && duration >= 2.2) || duration >= 12) {
      utterances.push({ start: current[0].start, end: token.end, text, tokens: current })
      current = []
    }
  }
  if (current.length) {
    utterances.push({
      start: current[0].start,
      end: current.at(-1).end,
      text: current.map((item) => item.text).join('').trim(),
      tokens: current,
    })
  }
  return utterances
    .filter((utterance) => utterance.end - utterance.start >= 0.8 && utterance.text.length > 2)
    .map((utterance, index) => {
      const id = `turn-${index + 1}`
      const { tokens: utteranceTokens, ...rest } = utterance
      return {
        id,
        speaker: speakerAt(utterance.start, utterance.end, diarization),
        ...rest,
        rhythmSegments: buildRhythmSegments(utteranceTokens, id),
      }
    })
}

function parseJsonText(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Translation model did not return JSON')
  return JSON.parse(trimmed.slice(start, end + 1))
}

function atempoChain(factor) {
  const filters = []
  let remaining = factor
  while (remaining > 2) {
    filters.push('atempo=2')
    remaining /= 2
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5')
    remaining /= 0.5
  }
  filters.push(`atempo=${remaining.toFixed(6)}`)
  return filters.join(',')
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((milliseconds % 60_000) / 1000)
  const millis = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function wrapCharacters(text, limit) {
  const characters = [...String(text)]
  const lines = []
  const forbiddenAtLineStart = /^[，。！？；：、）》】」』”’…—％%]/u
  const forbiddenAtLineEnd = /[（《【「『“‘]$/u
  while (characters.length) {
    let count = Math.min(limit, characters.length)
    while (count < characters.length && forbiddenAtLineStart.test(characters[count])) count += 1
    while (count > 1 && forbiddenAtLineEnd.test(characters[count - 1])) count -= 1
    lines.push(characters.splice(0, count).join(''))
  }
  return lines
}

function keepPunctuationWithPreviousCharacter(text) {
  return String(text).replace(/([，。！？；：、）》】」』”’…—％%])/gu, '\u2060$1')
}

function wrapWords(text, limit) {
  const lines = []
  let line = ''
  for (const word of String(text).split(/\s+/u)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && candidate.length > limit) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

function renderSubtitleImage(turn, index) {
  const zhLines = wrapCharacters(turn.text, 32)
  const enLines = wrapWords(turn.sourceText, 78)
  const lines = [
    ...zhLines.map((text) => ({ text, size: 24, family: 'PingFang SC', height: 31 })),
    ...enLines.map((text) => ({ text, size: 18, family: 'Helvetica', height: 24 })),
  ]
  const contentHeight = lines.reduce((sum, line) => sum + line.height, 0)
  const panelHeight = contentHeight + 24
  const panelY = 540 - panelHeight - 22
  let cursorY = panelY + 20
  const textElements = lines.map((line) => {
    cursorY += line.height
    return `<text x="480" y="${cursorY}" text-anchor="middle" font-family="${line.family}" font-size="${line.size}" font-weight="500" fill="white">${escapeXml(line.text)}</text>`
  }).join('\n  ')
  const svgPath = path.join(outputDir, `subtitle-cue-${String(index + 1).padStart(2, '0')}.svg`)
  const pngPath = path.join(outputDir, `subtitle-cue-${String(index + 1).padStart(2, '0')}.png`)
  fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
  <rect width="960" height="540" fill="none"/>
  <rect x="36" y="${panelY}" width="888" height="${panelHeight}" rx="13" fill="black" fill-opacity="0.62"/>
  ${textElements}
</svg>\n`)
  run('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath])
  return pngPath
}

const sourceAudioPath = path.join(outputDir, 'source-audio.wav')
run('ffmpeg', ['-y', '-i', inputPath, '-vn', '-ac', '2', '-ar', '44100', sourceAudioPath])
reportProgress('separating', 8, '正在检测是否需要分离背景声')

const vocalsPath = path.join(outputDir, 'vocals.wav')
const backgroundPath = path.join(outputDir, 'background.wav')
const analysisSamplePath = path.join(outputDir, 'background-analysis-sample.wav')
if (!fs.existsSync(analysisSamplePath)) {
  const duration = probeDuration(sourceAudioPath)
  const sampleDuration = Math.min(10, duration)
  const sampleStart = Math.max(0, (duration - sampleDuration) / 2)
  run('ffmpeg', [
    '-y', '-ss', sampleStart.toFixed(3), '-i', sourceAudioPath,
    '-t', sampleDuration.toFixed(3), '-ac', '1', '-ar', '16000',
    analysisSamplePath,
  ])
}
const backgroundAnalysis = await cachedJson('00-background-analysis.json', async () => {
  try {
    const classification = await execute({
      capability: 'audio.classify',
      providerId: 'plugin.k2-fsa.audio-tagging',
      routing: 'local',
      title: 'Video translation · detect music and background sound',
      input: audioInput(analysisSamplePath),
      parameters: {},
    })
    const tags = classification.tags ?? []
    const musicTags = tags.filter((tag) => /music|musical|song|singing|instrument|guitar|piano|drum|orchestra/iu.test(tag.label ?? ''))
    const musicScore = Math.max(0, ...musicTags.map((tag) => Number(tag.probability) || 0))
    const shouldSeparate = musicScore >= 0.18
    return {
      version: 1,
      engine: classification.engine,
      samplePath: analysisSamplePath,
      sampleDurationSeconds: probeDuration(analysisSamplePath),
      tags,
      musicTags,
      musicScore,
      decision: shouldSeparate ? 'separate_and_mix' : 'skip_separation_mix',
      reason: shouldSeparate
        ? 'Confident music or instrumental background detected.'
        : 'No confident music background detected; preserving the clean source speech avoids separation artifacts.',
    }
  } catch (error) {
    return {
      version: 1,
      engine: 'fallback',
      tags: [],
      musicTags: [],
      musicScore: 0,
      decision: 'skip_separation_mix',
      reason: `Background classifier unavailable; conservatively skipped separation: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
})
const shouldSeparate = backgroundAnalysis.decision === 'separate_and_mix'
reportProgress(
  'separating',
  12,
  shouldSeparate ? '检测到音乐背景，正在分离对白与背景声' : '未检测到明显音乐背景，保留原始音轨',
  { audioAnalysis: backgroundAnalysis },
)

let separated
if (!shouldSeparate) {
  fs.copyFileSync(sourceAudioPath, vocalsPath)
  const duration = probeDuration(sourceAudioPath)
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', duration.toFixed(6), backgroundPath])
  separated = { engine: 'skipped after real background analysis', tracks: [] }
  saveJson('01-separation.json', separated)
} else {
  separated = await cachedJson('01-separation.json', () => execute({
    capability: 'audio.separate',
    providerId: 'plugin.k2-fsa.spleeter-2stems',
    routing: 'local',
    title: 'Video translation · separate vocals and background',
    input: audioInput(sourceAudioPath),
    parameters: {},
  }))
  const vocals = separated.tracks?.find((track) => track.id === 'vocals')
  const background = separated.tracks?.find((track) => track.id === 'accompaniment')
  if (!vocals?.filePath || !background?.filePath) throw new Error('Source separation did not return both stems')
  fs.copyFileSync(vocals.filePath, vocalsPath)
  fs.copyFileSync(background.filePath, backgroundPath)
}
saveJson('09-background-analysis.json', backgroundAnalysis)

reportProgress('diarizing', 24, '正在区分说话人')
const diarization = await cachedJson('02-diarization.json', () => execute({
  capability: 'speaker.diarize',
  providerId: 'plugin.k2-fsa.speaker-diarization',
  routing: 'local',
  title: 'Video translation · diarize separated vocals',
  input: audioInput(vocalsPath),
  parameters: {},
}))

reportProgress('transcribing', 35, '正在识别原始对白')
const transcription = await cachedJson('03-transcription.json', () => execute({
  capability: 'speech.transcribe',
  providerId: cloudMode ? 'api.bailian' : 'plugin.nvidia.parakeet-tdt-0.6b-v3',
  routing: cloudMode ? 'quality' : 'local',
  title: cloudMode ? 'Video translation · Bailian file transcription' : 'Video translation · transcribe separated vocals',
  input: audioInput(vocalsPath),
  parameters: {
    ...(cloudMode ? { modelId: 'qwen-audio-3.0-asr-flash-filetrans' } : {}),
    language: 'en',
    punctuation: true,
  },
}))

const sourceTurns = buildUtterances(transcription, diarization)
if (!sourceTurns.length) throw new Error('No timestamped speech turns were produced')
saveJson('04-source-turns.json', sourceTurns)

reportProgress('translating', 48, '正在翻译并适配中文口播', {
  turns: sourceTurns.map((turn) => ({ ...turn, sourceText: turn.text, text: '' })),
})
const translated = await cachedJson('05-translated-turns.json', async () => {
  const translationPrompt = [
    '你是视频配音翻译编辑。把英文口播翻译成自然、准确、适合朗读的简体中文。',
    '保持每个 id、speaker、start、end 不变。删除无意义的口吃，但不要遗漏事实。',
    '每段必须语义完整，禁止以“并且与”“以及”“因为”等未完成连接词结尾。',
    '每段中文要尽量适配该段时长，正常语速按每秒约 3.5 至 4.5 个汉字控制。',
    userInstruction ? `用户额外要求：${userInstruction}` : '',
    '只返回 JSON：{"turns":[{"id":"...","speaker":"...","start":0,"end":1,"text":"..."}]}。',
  ].filter(Boolean).join('')
  const batches = []
  let currentBatch = []
  let currentSize = 0
  for (const turn of sourceTurns) {
    const turnSize = JSON.stringify(turn).length
    if (currentBatch.length && (currentBatch.length >= 3 || currentSize + turnSize > 2200)) {
      batches.push(currentBatch)
      currentBatch = []
      currentSize = 0
    }
    currentBatch.push(turn)
    currentSize += turnSize
  }
  if (currentBatch.length) batches.push(currentBatch)

  const translatedTurns = []
  const engines = new Set()
  for (const [batchIndex, batch] of batches.entries()) {
    const signature = shortHash(JSON.stringify({ version: 2, translationPrompt, batch }))
    const batchResult = await cachedJson(
      `05-translated-turns-batch-${batchIndex + 1}.json`,
      async () => {
        const response = await execute({
          capability: 'text.generate',
          providerId: 'api.bailian',
          routing: 'quality',
          title: `Video translation · translate batch ${batchIndex + 1}/${batches.length}`,
          input: {
            messages: [
              { role: 'system', content: translationPrompt },
              { role: 'user', content: JSON.stringify({ turns: batch }) },
            ],
          },
          parameters: {
            modelId: cloudMode ? 'qwen3.7-plus' : 'qwen3.6-plus',
            temperature: 0.1,
            maxTokens: Math.max(600, Math.min(1200, batch.length * 400)),
            enableThinking: false,
          },
        }, textGenerationTimeoutMs)
        const parsed = parseJsonText(response.text)
        const byId = new Map((parsed.turns ?? []).map((turn) => [turn.id, turn]))
        return {
          signature,
          engine: response.engine,
          turns: batch.map((sourceTurn) => {
            const translation = byId.get(sourceTurn.id)
            if (!translation?.text?.trim()) throw new Error(`Missing translation for ${sourceTurn.id}`)
            return { ...sourceTurn, text: translation.text.trim(), sourceText: sourceTurn.text }
          }),
        }
      },
      (cached) => cached?.signature === signature && cached.turns?.length === batch.length,
    )
    if (batchResult.engine) engines.add(batchResult.engine)
    translatedTurns.push(...batchResult.turns)
    reportProgress(
      'translating',
      48 + Math.round(((batchIndex + 1) / batches.length) * 8),
      `已完成翻译 ${batchIndex + 1}/${batches.length} 批`,
      { turns: translatedTurns },
    )
  }
  return {
    engine: [...engines].join(' · '),
    turns: translatedTurns,
  }
})

const sourceTurnById = new Map(sourceTurns.map((turn) => [turn.id, turn]))
for (const turn of translated.turns) {
  const sourceTurn = sourceTurnById.get(turn.id)
  if (!sourceTurn) throw new Error(`Missing source timing for ${turn.id}`)
  turn.start = sourceTurn.start
  turn.end = sourceTurn.end
  turn.speaker = sourceTurn.speaker
  turn.sourceText = sourceTurn.text
  turn.rhythmSegments = sourceTurn.rhythmSegments
}

function rhythmSignatureFor(turns) {
  return shortHash(JSON.stringify({
    version: rhythmPlanVersion,
    turns: turns.map((turn) => ({
      id: turn.id,
      text: turn.text,
      sourceText: turn.sourceText,
      rhythmSegments: turn.rhythmSegments.map(({ id, start, end, sourceText }) => ({
        id,
        start,
        end,
        sourceText,
      })),
    })),
  }))
}

const rhythmSignature = rhythmSignatureFor(translated.turns)
const turnsWithInternalPauses = translated.turns.filter((turn) => turn.rhythmSegments.length > 1)
reportProgress('aligning', 58, '正在对齐译文与原始讲话节奏', { turns: translated.turns })
const rhythmPlan = await cachedJson('05-rhythm-plan.json', async () => {
  let plannedTurns = []
  let engine = 'deterministic-single-segment'
  if (turnsWithInternalPauses.length) {
    const response = await execute({
      capability: 'text.generate',
      providerId: 'api.bailian',
      routing: 'quality',
      title: 'Video translation · align translated phrases to source pauses',
      input: {
        messages: [
          {
            role: 'system',
            content: [
              '你是视频配音节奏编辑。把整段中文译文拆成与英文节奏短语一一对应的中文短语。',
              '每个 segment id 必须原样保留且只出现一次；禁止合并、遗漏或新增 segment。',
              '各短语应分别对应 sourceText 的语义，连接起来后必须忠实覆盖完整译文。',
              '允许为自然断句做轻微改写，但不能添加事实。每个短语必须非空并适合独立合成。',
              '只返回 JSON：{"turns":[{"id":"turn-1","segments":[{"id":"turn-1-phrase-1","text":"..."}]}]}。',
            ].join(''),
          },
          {
            role: 'user',
            content: JSON.stringify({
              turns: turnsWithInternalPauses.map((turn) => ({
                id: turn.id,
                sourceText: turn.sourceText,
                translation: turn.text,
                segments: turn.rhythmSegments.map((segment) => ({
                  ...segment,
                  duration: Number((segment.end - segment.start).toFixed(2)),
                })),
              })),
            }),
          },
        ],
      },
      parameters: {
        modelId: 'qwen3.7-plus',
        temperature: 0.1,
        maxTokens: 1200,
        enableThinking: false,
      },
    }, textGenerationTimeoutMs)
    plannedTurns = parseJsonText(response.text).turns ?? []
    engine = response.engine
  }

  const plannedById = new Map(plannedTurns.map((turn) => [turn.id, turn]))
  return {
    version: rhythmPlanVersion,
    signature: rhythmSignature,
    pauseThresholdSeconds: minimumInternalPauseSeconds,
    engine,
    turns: translated.turns.map((turn) => {
      if (turn.rhythmSegments.length === 1) {
        return {
          id: turn.id,
          segments: [{ ...turn.rhythmSegments[0], text: turn.text }],
        }
      }
      const planned = plannedById.get(turn.id)
      const textById = new Map((planned?.segments ?? []).map((segment) => [segment.id, segment.text?.trim()]))
      return {
        id: turn.id,
        segments: turn.rhythmSegments.map((segment) => {
          const text = textById.get(segment.id)
          if (!text) throw new Error(`Rhythm plan did not translate ${segment.id}`)
          return { ...segment, text }
        }),
      }
    }),
  }
}, (cached) => cached.version === rhythmPlanVersion && cached.signature === rhythmSignature)

const rhythmTurnById = new Map(rhythmPlan.turns.map((turn) => [turn.id, turn]))
for (const turn of translated.turns) {
  const planned = rhythmTurnById.get(turn.id)
  if (!planned || planned.segments.length !== turn.rhythmSegments.length) {
    throw new Error(`Invalid rhythm plan for ${turn.id}`)
  }
  turn.rhythmSegments = planned.segments
}

const speakers = [...new Set(translated.turns.map((turn) => turn.speaker))]
reportProgress('voices', 66, `正在准备 ${speakers.length} 位说话人的音色`, { turns: translated.turns })
const references = new Map()
for (const speaker of speakers) {
  const candidates = sourceTurns
    .filter((turn) => turn.speaker === speaker && turn.end - turn.start >= 3)
    .sort((left, right) => Math.abs(6.5 - (left.end - left.start)) - Math.abs(6.5 - (right.end - right.start)))
  const reference = candidates[0] ?? sourceTurns.find((turn) => turn.speaker === speaker)
  if (!reference) throw new Error(`No reference speech for ${speaker}`)
  const referencePath = path.join(outputDir, `reference-${speaker.replace(/\s+/gu, '-').toLowerCase()}.wav`)
  run('ffmpeg', [
    '-y', '-i', vocalsPath,
    '-ss', String(reference.start),
    '-t', String(reference.end - reference.start),
    '-af', 'highpass=f=70,lowpass=f=7600,loudnorm=I=-23:LRA=7:TP=-2',
    '-ac', '1', '-ar', '16000',
    referencePath,
  ])
  references.set(speaker, { ...reference, filePath: referencePath })
}
saveJson('06-speaker-references.json', Object.fromEntries(references))

const cloudVoicePath = path.join(outputDir, '06-bailian-voices.json')
let cloudVoices = {}
if (cloudMode) {
  if (fs.existsSync(cloudVoicePath)) {
    cloudVoices = JSON.parse(fs.readFileSync(cloudVoicePath, 'utf8'))
  } else {
    for (const speaker of speakers) {
      cloudVoices[speaker] = await createBailianVoice(references.get(speaker), speaker)
      process.stdout.write(`Bailian voice enrolled for ${speaker}: ${cloudVoices[speaker].id}\n`)
    }
    saveJson('06-bailian-voices.json', cloudVoices)
  }
}

const speechUnits = translated.turns.flatMap((turn) =>
  turn.rhythmSegments.map((segment) => ({ turn, segment })),
)
const dubbedSegments = []
for (let index = 0; index < speechUnits.length; index += 1) {
  reportProgress(
    'dubbing',
    68 + Math.round((index / Math.max(1, speechUnits.length)) * 20),
    `正在生成中文配音 ${index + 1}/${speechUnits.length}`,
    { completedUnits: index, totalUnits: speechUnits.length },
  )
  const { turn, segment } = speechUnits[index]
  const reference = references.get(turn.speaker)
  const unitNumber = String(index + 1).padStart(2, '0')

  async function synthesize(text, speed, pass) {
    const engineName = cloudMode ? 'bailian' : 'zipvoice'
    const signature = shortHash(JSON.stringify({ text, speaker: turn.speaker, reference: reference.text }))
    const cachePath = path.join(outputDir, `${engineName}-${pass}-${unitNumber}-${signature}-${speed.toFixed(3)}.json`)
    if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    const output = await execute({
      capability: 'speech.synthesize',
      providerId: cloudMode ? 'api.bailian' : 'plugin.k2-fsa.zipvoice-zh-en',
      routing: cloudMode ? 'quality' : 'local',
      title: `Video translation · clone ${turn.speaker} · ${index + 1}/${speechUnits.length} · ${pass}`,
      input: { text },
      parameters: cloudMode
        ? {
            modelId: cloudTtsModel,
            voice: cloudVoices[turn.speaker].id,
            speed,
            instruction: '自然、清晰的中文口播，保留参考说话人的音色。',
          }
        : {
            speed,
            numSteps: 4,
            referenceAudioDataUrl: audioInput(reference.filePath).audioDataUrl,
            referenceText: reference.text,
          },
    }, 20 * 60_000)
    saveJson(path.basename(cachePath), output)
    return output
  }

  function trimSpeechEdges(output) {
    const sourcePath = output.filePath
    const stat = fs.statSync(sourcePath)
    const signature = shortHash(JSON.stringify({
      version: speechEdgeTrimVersion,
      sourcePath,
      size: stat.size,
      modified: stat.mtimeMs,
    }))
    const trimmedPath = path.join(outputDir, `trimmed-${unitNumber}-${signature}.wav`)
    if (!fs.existsSync(trimmedPath)) {
      run('ffmpeg', [
        '-y', '-i', sourcePath,
        '-af', [
          `silenceremove=start_periods=1:start_duration=0.04:start_threshold=${speechEdgeThreshold}:start_silence=${speechEdgeSafetySeconds}:detection=peak`,
          'areverse',
          `silenceremove=start_periods=1:start_duration=0.04:start_threshold=${speechEdgeThreshold}:start_silence=${speechEdgeSafetySeconds}:detection=peak`,
          'areverse',
        ].join(','),
        '-ac', '1', '-ar', '44100',
        trimmedPath,
      ])
    }
    return { filePath: trimmedPath, duration: probeDuration(trimmedPath) }
  }

  async function rewriteForDuration(text, naturalDuration, desiredDuration, attempt) {
    const signature = shortHash(JSON.stringify({ version: 2, text, naturalDuration, desiredDuration }))
    const cachePath = path.join(outputDir, `rewrite-${unitNumber}-${signature}.json`)
    if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8')).text
    const ratio = desiredDuration / naturalDuration
    const currentLength = [...text].length
    const minimumLength = desiredDuration < 1 ? 2 : desiredDuration < 1.5 ? 3 : 6
    const targetLength = Math.max(minimumLength, Math.round(currentLength * ratio))
    const response = await execute({
      capability: 'text.generate',
      providerId: 'api.bailian',
      routing: 'quality',
      title: `Video translation · fit ${segment.id} to speech window · ${attempt}`,
      input: {
        messages: [
          {
            role: 'system',
            content: [
              '你是专业视频配音译者。根据一次真实 TTS 的测量结果，重写中文译文，使它用自然语速读完时接近目标时长。',
              '必须忠实保留英文原意；过长时精简，过短时补回英文中的语气和细节，但禁止凑字、重复或添加新事实。',
              '译文必须自然；短节奏片段可以是完整短语，长片段必须是完整口语句子，不能以未完成的连接词结尾。只返回 JSON：{"text":"..."}。',
            ].join(''),
          },
          {
            role: 'user',
            content: JSON.stringify({
              source: segment.sourceText,
              currentTranslation: text,
              measuredNaturalSeconds: Number(naturalDuration.toFixed(2)),
              targetNaturalSeconds: Number(desiredDuration.toFixed(2)),
              approximateLengthRatio: Number(ratio.toFixed(2)),
              currentCharacterCount: currentLength,
              targetCharacterCount: targetLength,
              lengthRequirement: `请把标点计入长度，将结果严格控制在 ${Math.max(minimumLength, targetLength - 2)} 到 ${targetLength + 2} 个字符。`,
            }),
          },
        ],
      },
      parameters: {
        modelId: 'qwen3.7-plus',
        temperature: 0.1,
        maxTokens: 500,
        enableThinking: false,
      },
    }, textGenerationTimeoutMs)
    const rewritten = parseJsonText(response.text).text?.trim()
    if (!rewritten) throw new Error(`Duration rewrite returned no text for ${segment.id}`)
    saveJson(path.basename(cachePath), { text: rewritten })
    return rewritten
  }

  const targetDuration = segment.end - segment.start
  const isInternalRhythmSegment = segment.id !== turn.rhythmSegments.at(-1).id
  // Fill internal phrase windows up to the detected token boundary so the
  // following pause keeps its source length. The last phrase retains a small
  // natural tail before the next utterance.
  const desiredSpeechDuration = targetDuration * (isInternalRhythmSegment ? 1 : 0.94)
  let natural = await synthesize(segment.text, 1, 'natural')
  let preparedNatural = trimSpeechEdges(natural)
  let naturalDuration = preparedNatural.duration
  if (cloudMode && segment.timingFinalized !== true) {
    let best = {
      text: segment.text,
      natural,
      prepared: preparedNatural,
      duration: naturalDuration,
      error: Math.abs(Math.log(naturalDuration / desiredSpeechDuration)),
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const measuredSpeed = best.duration / desiredSpeechDuration
      if (measuredSpeed >= 0.88 && measuredSpeed <= 1.12) break
      const rewritten = await rewriteForDuration(best.text, best.duration, desiredSpeechDuration, attempt)
      if (rewritten === best.text) break
      const candidateNatural = await synthesize(rewritten, 1, 'natural')
      const candidatePrepared = trimSpeechEdges(candidateNatural)
      const candidateDuration = candidatePrepared.duration
      const candidateError = Math.abs(Math.log(candidateDuration / desiredSpeechDuration))
      if (candidateError < best.error) {
        best = {
          text: rewritten,
          natural: candidateNatural,
          prepared: candidatePrepared,
          duration: candidateDuration,
          error: candidateError,
        }
      }
    }
    segment.text = best.text
    natural = best.natural
    preparedNatural = best.prepared
    naturalDuration = best.duration
  }
  // ZipVoice duration responds approximately to the inverse square of its
  // speed control, so use a square-root correction instead of a linear one.
  let initialRequestedSpeed = clamp(
    Math.pow(naturalDuration / desiredSpeechDuration, cloudMode ? 1 : 0.5),
    cloudMode ? 0.88 : 0.5,
    cloudMode ? 1.12 : 2,
  )
  let requestedSpeed = initialRequestedSpeed
  let generated = Math.abs(requestedSpeed - 1) >= 0.04
    ? await synthesize(segment.text, requestedSpeed, 'timed')
    : natural
  let preparedGenerated = generated === natural ? preparedNatural : trimSpeechEdges(generated)
  let generatedDuration = preparedGenerated.duration
  let factor = generatedDuration / desiredSpeechDuration

  if (Math.abs(factor - 1) > 0.08 && Math.abs(initialRequestedSpeed - 1) >= 0.04) {
    const observedExponent = Math.log(generatedDuration / naturalDuration) / Math.log(1 / initialRequestedSpeed)
    if (Number.isFinite(observedExponent) && observedExponent > 0.5) {
      requestedSpeed = clamp(
        initialRequestedSpeed * Math.pow(factor, 1 / observedExponent),
        cloudMode ? 0.88 : 0.5,
        cloudMode ? 1.12 : 2,
      )
      if (Math.abs(requestedSpeed - initialRequestedSpeed) >= 0.01) {
        generated = await synthesize(segment.text, requestedSpeed, 'calibrated')
        preparedGenerated = trimSpeechEdges(generated)
        generatedDuration = preparedGenerated.duration
        factor = generatedDuration / desiredSpeechDuration
      }
    }
  }
  // The second TTS pass handles most of the timing change in the model. A
  // pitch-preserving tempo filter removes only the small residual mismatch.
  const alignedPath = path.join(outputDir, `aligned-rhythm-${unitNumber}.wav`)
  run('ffmpeg', [
    '-y', '-i', preparedGenerated.filePath,
    '-af', `${atempoChain(factor)},apad,atrim=duration=${targetDuration.toFixed(6)},adelay=${Math.round(segment.start * 1000)}:all=1`,
    '-ac', '1', '-ar', '44100',
    alignedPath,
  ])
  dubbedSegments.push({
    id: segment.id,
    turnId: turn.id,
    speaker: turn.speaker,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    sourceText: segment.sourceText,
    naturalDuration,
    generatedDuration,
    targetDuration,
    desiredSpeechDuration,
    initialRequestedSpeed,
    requestedSpeed,
    tempoFactor: factor,
    alignedPath,
  })
  segment.timingFinalized = true
  process.stdout.write(`Aligned ${segment.id} (${turn.speaker}): natural ${naturalDuration.toFixed(2)}s, TTS speed ${requestedSpeed.toFixed(2)}, residual ${factor.toFixed(2)}×, window ${targetDuration.toFixed(2)}s\n`)
}

for (const turn of translated.turns) {
  turn.text = turn.rhythmSegments.map((segment) => segment.text).join('')
}
rhythmPlan.turns = translated.turns.map((turn) => ({
  id: turn.id,
  segments: turn.rhythmSegments,
}))
rhythmPlan.signature = rhythmSignatureFor(translated.turns)
saveJson('05-translated-turns.json', translated)
saveJson('05-rhythm-plan.json', rhythmPlan)
saveJson('07-dubbed-segments.json', dubbedSegments.map(({ alignedPath: _alignedPath, ...segment }) => segment))

reportProgress('mixing', 90, '正在混合配音与背景声')
const videoDuration = probeDuration(inputPath)
const dubbedTrackPath = path.join(outputDir, 'dubbed-voice-zh.wav')
const mixInputs = dubbedSegments.flatMap((segment) => ['-i', segment.alignedPath])
const mixLabels = dubbedSegments.map((_, index) => `[${index}:a]`).join('')
run('ffmpeg', [
  '-y', ...mixInputs,
  '-filter_complex', `${mixLabels}amix=inputs=${dubbedSegments.length}:duration=longest:normalize=0,loudnorm=I=-16:LRA=11:TP=-1.5,apad,atrim=duration=${videoDuration.toFixed(6)}[a]`,
  '-map', '[a]', '-ac', '2', '-ar', '44100',
  dubbedTrackPath,
])

const subtitlePath = path.join(outputDir, 'translated-bilingual.srt')
reportProgress('subtitles', 93, '正在生成双语字幕')
fs.writeFileSync(subtitlePath, `${translated.turns.map((turn, index) => [
  index + 1,
  `${srtTimestamp(turn.start)} --> ${srtTimestamp(turn.end)}`,
  keepPunctuationWithPreviousCharacter(turn.text),
  turn.sourceText,
  '',
].join('\n')).join('\n')}\n`)

const subtitleImages = translated.turns.map(renderSubtitleImage)
const subtitleImageInputs = subtitleImages.flatMap((imagePath) => ['-loop', '1', '-framerate', '1', '-i', imagePath])
let previousVideoLabel = '[0:v]'
const videoFilters = translated.turns.map((turn, index) => {
  const outputLabel = `[video-${index + 1}]`
  const filter = `${previousVideoLabel}[${index + 4}:v]overlay=0:0:enable='between(t,${turn.start.toFixed(6)},${turn.end.toFixed(6)})'${outputLabel}`
  previousVideoLabel = outputLabel
  return filter
})

const backgroundMix = backgroundAnalysis?.decision === 'skip_separation_mix' ? 0 : 0.35

const outputVideoPath = path.join(
  outputDir,
  cloudMode
    ? `${path.basename(inputPath, path.extname(inputPath))}-zh-bailian-voice-clone.mp4`
    : `${path.basename(inputPath, path.extname(inputPath))}-zh-voice-clone.mp4`,
)
const stagingVideoPath = `${outputVideoPath}.next.mp4`
reportProgress('rendering', 96, '正在渲染最终视频')
run('ffmpeg', [
  '-y', '-i', inputPath, '-i', dubbedTrackPath, '-i', backgroundPath, '-i', subtitlePath, ...subtitleImageInputs,
  '-filter_complex', `[1:a]volume=1[dub];[2:a]volume=${backgroundMix}[bg];[dub][bg]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95,apad,atrim=duration=${videoDuration.toFixed(6)}[mix];${videoFilters.join(';')}`,
  '-map', previousVideoLabel, '-map', '[mix]', '-map', '3:0',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k',
  '-c:s', 'mov_text', '-metadata:s:s:0', 'language=zho',
  '-t', videoDuration.toFixed(6), '-shortest', '-movflags', '+faststart',
  stagingVideoPath,
])
fs.renameSync(stagingVideoPath, outputVideoPath)

saveJson('08-report.json', {
  inputPath,
  outputVideoPath,
  sourceDuration: videoDuration,
  separatedWith: separated.engine,
  diarizedWith: diarization.engine,
  speakerCount: diarization.speakerCount,
  speakers,
  transcribedWith: transcription.engine,
  translatedWith: translated.engine,
  synthesizedWith: cloudMode ? `Bailian ${cloudTtsModel} cloned voice` : 'ZipVoice Distill INT8 zh-en (4 steps)',
  turnCount: translated.turns.length,
  rhythmSegmentCount: speechUnits.length,
  preservedInternalPauseCount: speechUnits.length - translated.turns.length,
  rhythmPauseThresholdSeconds: minimumInternalPauseSeconds,
  backgroundMix,
  backgroundDecision: backgroundAnalysis?.decision ?? 'separate_and_mix',
  backgroundAnalysis,
})

reportProgress('completed', 100, '视频翻译已完成', {
  status: 'completed',
  outputDir,
  outputVideoPath,
  subtitlePath,
  reportPath: path.join(outputDir, '08-report.json'),
  turns: translated.turns,
  sourceTurnsPath: path.join(outputDir, '04-source-turns.json'),
  translatedTurnsPath: path.join(outputDir, '05-translated-turns.json'),
  rhythmPlanPath: path.join(outputDir, '05-rhythm-plan.json'),
})

process.stdout.write(`${JSON.stringify({
  outputDir,
  outputVideoPath,
  speakerCount: diarization.speakerCount,
  speakers,
  diarizationSegments: diarization.segments?.length ?? 0,
  transcriptCharacters: transcription.text?.length ?? 0,
  transcriptSegments: transcription.segments?.length ?? 0,
  translatedTurns: translated.turns.length,
  rhythmSegments: speechUnits.length,
  preservedInternalPauses: speechUnits.length - translated.turns.length,
}, null, 2)}\n`)
