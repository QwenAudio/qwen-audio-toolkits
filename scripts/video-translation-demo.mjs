import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJsonCache, readJsonIfValid } from './lib/video-dubbing/cache.mjs'
import { createHarnessClient } from './lib/video-dubbing/harness-client.mjs'
import {
  batchTurns,
  buildTransformationPrompt,
  buildTranslationContextPrompt,
  distributeScriptAcrossTurns,
  dubbingLanguageName,
  formatTranslationContext,
  normalizeDubbingLanguage,
  normalizeDubbingMode,
} from './lib/video-dubbing/script-planner.mjs'

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
const dubbingMode = normalizeDubbingMode(String(process.env.VIDEO_DUBBING_MODE ?? 'translate'))
const sourceLanguage = normalizeDubbingLanguage(process.env.VIDEO_SOURCE_LANGUAGE, 'auto')
const targetLanguage = dubbingMode === 'translate'
  ? normalizeDubbingLanguage(process.env.VIDEO_TARGET_LANGUAGE, 'zh')
  : sourceLanguage
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
  reportProgress('failed', 100, '视频配音失败', { status: 'failed', error: message })
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

process.on('uncaughtException', reportFatal)
process.on('unhandledRejection', reportFatal)

if (!inputPath || !fs.existsSync(inputPath)) {
  throw new Error('Usage: node scripts/video-translation-demo.mjs <video> [output-directory]')
}
if (!cloudMode && sourceLanguage !== 'auto' && sourceLanguage !== 'en') {
  throw new Error('本地配音流水线仅支持英文源视频；其他语言源视频请使用云端模式')
}
if (!cloudMode && dubbingMode === 'translate' && targetLanguage !== 'zh') {
  throw new Error('本地配音流水线的翻译目标语言仅支持中文；其他目标语言请使用云端模式')
}

fs.mkdirSync(outputDir, { recursive: true })
const { cachedJson, saveJson } = createJsonCache(outputDir)
const { execute } = createHarnessClient({
  api,
  reportProgress,
  getProgress: () => ({ stage: latestStage, progress: latestProgress }),
})
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
        language_hints: sourceLanguage === 'auto' ? ['zh', 'en'] : [sourceLanguage],
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

const minimumRhythmPhraseSeconds = 0.6

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
  // Fold micro phrases into their neighbours. Forcing a sub-half-second TTS
  // clip into its own window only yields rushed, speed-skewed audio, and the
  // engine's natural punctuation pause covers the merged source pause well.
  const merged = []
  let carry = []
  groups.forEach((group, index) => {
    carry.push(...group)
    const start = carry[0].start
    const end = group.at(-1).end
    if (end - start < minimumRhythmPhraseSeconds && index < groups.length - 1) return
    merged.push(carry)
    carry = []
  })
  if (merged.length >= 2) {
    const last = merged.at(-1)
    if (last.at(-1).end - last[0].start < minimumRhythmPhraseSeconds) {
      merged.at(-2).push(...last)
      merged.pop()
    }
  }
  return merged.map((group, index) => ({
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

function isCjkText(text) {
  return /[぀-ヿ㐀-䶿一-鿿가-힯]/u.test(String(text ?? ''))
}

function wrapSubtitleLines(text, role, videoSize) {
  // Column budget follows the rendered panel width, so portrait and square
  // videos do not overflow their subtitle panel (portrait wraps narrower).
  const { width, height, scale } = videoSize
  const panelTextWidth = (width - 72 * scale) * 0.88
  const fontSize = (role === 'primary' ? 24 : 18) * (height / 540)
  const limit = isCjkText(text)
    ? Math.max(6, Math.floor(panelTextWidth / fontSize))
    : Math.max(12, Math.floor(panelTextWidth / (fontSize * 0.52)))
  if (isCjkText(text)) return wrapCharacters(text, limit)
  return wrapWords(text, limit)
}

function subtitleFontFor(text) {
  const value = String(text ?? '')
  if (/[぀-ヿ]/u.test(value) && !/[一-鿿]/u.test(value)) return 'Hiragino Sans'
  if (/[가-힯]/u.test(value) && !/[一-鿿]/u.test(value)) return 'Apple SD Gothic Neo'
  if (/[㐀-䶿一-鿿]/u.test(value)) return 'PingFang SC'
  return 'Helvetica'
}

function probeVideoResolution(filePath) {
  const output = run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    filePath,
  ])
  const stream = JSON.parse(output).streams?.[0] ?? {}
  const width = Number(stream.width) || 960
  const height = Number(stream.height) || 540
  return { width, height, scale: height / 540 }
}

function assTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100))
  const hours = Math.floor(centiseconds / 360_000)
  const minutes = Math.floor((centiseconds % 360_000) / 6000)
  const secs = Math.floor((centiseconds % 6000) / 100)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}

function escapeAssText(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}')
}

function buildAssDocument(turns, videoSize) {
  const { width, height, scale } = videoSize
  const primarySize = Math.round(24 * scale)
  const secondarySize = Math.round(18 * scale)
  const marginV = Math.round(22 * scale)
  const padding = Math.round(12 * scale)
  const primaryFont = subtitleFontFor(turns.map((turn) => turn.text).join(''))
  const styleLine = (name, fontname, fontsize) =>
    `Style: ${name},${fontname},${fontsize},&H00FFFFFF,&H00FFFFFF,&H61000000,&H61000000,-1,0,0,0,100,100,0,0,3,${padding},${Math.round(2 * scale)},2,${Math.round(20 * scale)},${Math.round(20 * scale)},${marginV},1`
  const events = turns.map((turn) => {
    const primary = wrapSubtitleLines(turn.text, 'primary', videoSize).map(escapeAssText).join('\\N')
    const secondary = wrapSubtitleLines(turn.sourceText, 'secondary', videoSize).map(escapeAssText).join('\\N')
    return `Dialogue: 0,${assTimestamp(turn.start)},${assTimestamp(turn.end)},Target,,0,0,0,,${primary}\\N{\\rSource}${secondary}`
  })
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine('Target', primaryFont, primarySize),
    styleLine('Source', 'Helvetica', secondarySize),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}

function detectFilterSupport(name) {
  try {
    return new RegExp(`\\b${name}\\b`, 'u').test(run('ffmpeg', ['-hide_banner', '-filters']))
  } catch {
    return false
  }
}

function escapeFfmpegFilterPath(value) {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'")
}

function renderSubtitleImage(turn, index, videoSize) {
  const { width, height, scale } = videoSize
  const lines = [
    ...wrapSubtitleLines(turn.text, 'primary', videoSize).map((text) => ({
      text, size: 24 * scale, family: subtitleFontFor(turn.text), height: 31 * scale,
    })),
    ...wrapSubtitleLines(turn.sourceText, 'secondary', videoSize).map((text) => ({
      text, size: 18 * scale, family: subtitleFontFor(turn.sourceText), height: 24 * scale,
    })),
  ]
  const contentHeight = lines.reduce((sum, line) => sum + line.height, 0)
  const panelHeight = contentHeight + 24 * scale
  const panelWidth = width - 72 * scale
  const panelY = height - panelHeight - 22 * scale
  let cursorY = panelY + 20 * scale
  const textElements = lines.map((line) => {
    cursorY += line.height
    return `<text x="${width / 2}" y="${cursorY}" text-anchor="middle" font-family="${line.family}" font-size="${line.size}" font-weight="500" fill="white">${escapeXml(line.text)}</text>`
  }).join('\n  ')
  const svgPath = path.join(outputDir, `subtitle-cue-${String(index + 1).padStart(2, '0')}.svg`)
  const pngPath = path.join(outputDir, `subtitle-cue-${String(index + 1).padStart(2, '0')}.png`)
  fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="none"/>
  <rect x="${36 * scale}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="${13 * scale}" fill="black" fill-opacity="0.62"/>
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
      title: 'Video dubbing · detect music and background sound',
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
let vocalsEnhanced = null
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
    title: 'Video dubbing · separate vocals and background',
    input: audioInput(sourceAudioPath),
    parameters: {},
  }))
  const vocals = separated.tracks?.find((track) => track.id === 'vocals')
  const background = separated.tracks?.find((track) => track.id === 'accompaniment')
  if (!vocals?.filePath || !background?.filePath) throw new Error('Source separation did not return both stems')
  if (cloudMode) {
    // Cloud mode uses the denoiser only for speaker diarization and the clone
    // reference, where spleeter's metallic bleed misleads embeddings and
    // timbre. ASR consumes the untouched source mix: cloud ASR is robust to
    // music, and any preprocessing risks hurting recognition. The local
    // spleeter accompaniment is only used for the mixback bed.
    vocalsEnhanced = await cachedJson('01-cloud-vocals-enhance.json', () => execute({
      capability: 'audio.enhance',
      providerId: 'api.bailian',
      routing: 'quality',
      title: 'Video dubbing · cloud clean voice reference track',
      input: audioInput(sourceAudioPath),
      parameters: { modelId: 'fun-audio-denoising', sampleRate: 44100 },
    }, 20 * 60_000))
    if (!vocalsEnhanced?.filePath || !fs.existsSync(vocalsEnhanced.filePath)) {
      throw new Error('云端人声净化没有返回音频')
    }
    run('ffmpeg', ['-y', '-i', vocalsEnhanced.filePath, '-ac', '2', '-ar', '44100', vocalsPath])
  } else {
    fs.copyFileSync(vocals.filePath, vocalsPath)
  }
  // Tame the metallic spleeter residue that becomes audible whenever the
  // ducker reopens the bed between sentences, then pin the stem duration.
  run('ffmpeg', [
    '-y', '-i', background.filePath,
    '-af', `afftdn=nf=-28:tn=1,apad,atrim=duration=${probeDuration(background.filePath).toFixed(6)}`,
    '-ac', '2', '-ar', '44100',
    backgroundPath,
  ])
}
saveJson('09-background-analysis.json', backgroundAnalysis)

reportProgress('diarizing', 24, '正在区分说话人')
const diarization = await cachedJson('02-diarization.json', () => execute({
  capability: 'speaker.diarize',
  providerId: 'plugin.k2-fsa.speaker-diarization',
  routing: 'local',
  title: 'Video dubbing · diarize separated vocals',
  input: audioInput(vocalsPath),
  parameters: {},
}))

reportProgress('transcribing', 35, '正在识别原始对白')
const transcriptionInput = cloudMode && shouldSeparate ? sourceAudioPath : vocalsPath
const transcription = await cachedJson('03-transcription.json', () => execute({
  capability: 'speech.transcribe',
  providerId: cloudMode ? 'api.bailian' : 'plugin.nvidia.parakeet-tdt-0.6b-v3',
  routing: cloudMode ? 'quality' : 'local',
  title: cloudMode ? 'Video dubbing · Bailian file transcription' : 'Video dubbing · transcribe separated vocals',
  input: audioInput(transcriptionInput),
  parameters: {
    ...(cloudMode ? { modelId: 'qwen-audio-3.0-asr-flash-filetrans' } : {}),
    ...(sourceLanguage !== 'auto' ? { language: sourceLanguage } : {}),
    punctuation: true,
  },
}))
const detectedLanguage = normalizeDubbingLanguage(transcription.language, sourceLanguage)
const speechLanguage = detectedLanguage === 'auto' ? 'zh' : detectedLanguage

const sourceTurns = buildUtterances(transcription, diarization)
if (!sourceTurns.length) {
  throw new Error(
    dubbingMode === 'script'
      ? '没有检测到可用于对齐和克隆音色的原始人声；当前版本暂不支持无对白视频自动配音'
      : '没有识别到带时间信息的原始对白',
  )
}
saveJson('04-source-turns.json', sourceTurns)

const transformationSignature = shortHash(JSON.stringify({
  version: 5,
  dubbingMode,
  userInstruction,
  sourceLanguage,
  targetLanguage,
  sourceTurns,
}))
const transformationLabel = dubbingMode === 'translate'
  ? `翻译并适配${dubbingLanguageName(targetLanguage)}口播`
  : dubbingMode === 'rewrite'
    ? '改写并适配原始口播'
    : '分配新文案并适配讲话区间'
reportProgress('translating', 48, `正在${transformationLabel}`, {
  turns: sourceTurns.map((turn) => ({ ...turn, sourceText: turn.text, text: '' })),
})

// Build a shared translation context (summary + tone + glossary) from the full
// transcript so independently batched segments stay consistent across the video.
const translationContext = dubbingMode !== 'translate'
  ? null
  : await cachedJson('05-translation-context.json', async () => {
      const transcriptDigest = sourceTurns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n')
      const signature = shortHash(JSON.stringify({ version: 1, targetLanguage, transcriptDigest }))
      try {
        const response = await execute({
          capability: 'text.generate',
          providerId: 'api.bailian',
          routing: 'quality',
          title: 'Video dubbing · build shared translation context',
          input: {
            messages: [
              { role: 'system', content: buildTranslationContextPrompt(targetLanguage) },
              { role: 'user', content: JSON.stringify({ transcript: transcriptDigest.slice(0, 12_000) }) },
            ],
          },
          parameters: {
            modelId: cloudMode ? 'qwen3.7-plus' : 'qwen3.6-plus',
            temperature: 0.1,
            maxTokens: 1200,
            enableThinking: false,
          },
        }, textGenerationTimeoutMs)
        return { version: 1, signature, engine: response.engine, context: parseJsonText(response.text) }
      } catch (error) {
        return {
          version: 1,
          signature,
          engine: 'fallback',
          context: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }, (cached) => cached?.version === 1 && cached?.signature === shortHash(
      JSON.stringify({ version: 1, targetLanguage, transcriptDigest: sourceTurns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n') }),
    ))
const translationContextBlock = formatTranslationContext(translationContext?.context)

const translated = await cachedJson('05-translated-turns.json', async () => {
  if (dubbingMode === 'script') {
    const turns = distributeScriptAcrossTurns(userInstruction, sourceTurns)
    reportProgress('translating', 56, '新文案已分配到原始讲话区间', { turns })
    return {
      mode: dubbingMode,
      signature: transformationSignature,
      engine: 'user-provided script · deterministic timing allocation',
      turns,
    }
  }
  const translationPrompt = [
    buildTransformationPrompt(dubbingMode, userInstruction, { source: sourceLanguage, target: targetLanguage }),
    translationContextBlock,
  ].filter(Boolean).join('\n\n')
  const batches = batchTurns(sourceTurns)

  const translatedTurns = []
  const engines = new Set()
  for (const [batchIndex, batch] of batches.entries()) {
    const signature = shortHash(JSON.stringify({ version: 3, dubbingMode, translationPrompt, batch }))
    const batchResult = await cachedJson(
      `05-translated-turns-batch-${batchIndex + 1}.json`,
      async () => {
        const response = await execute({
          capability: 'text.generate',
          providerId: 'api.bailian',
          routing: 'quality',
          title: `Video dubbing · ${dubbingMode} batch ${batchIndex + 1}/${batches.length}`,
          input: {
            messages: [
              { role: 'system', content: translationPrompt },
              {
                role: 'user',
                content: JSON.stringify({
                  turns: batch,
                  // Read-only neighbour transcripts so sentences cut mid-way
                  // by ASR segmentation can still be rendered coherently.
                  contextPrevious: sourceTurns[sourceTurns.findIndex((turn) => turn.id === batch[0].id) - 1]?.text,
                  contextNext: sourceTurns[sourceTurns.findIndex((turn) => turn.id === batch.at(-1).id) + 1]?.text,
                }),
              },
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
            const transformed = byId.get(sourceTurn.id)
            if (!transformed?.text?.trim()) throw new Error(`配音文案缺少 ${sourceTurn.id}`)
            return { ...sourceTurn, text: transformed.text.trim(), sourceText: sourceTurn.text }
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
      `已完成配音文案 ${batchIndex + 1}/${batches.length} 批`,
      { turns: translatedTurns },
    )
  }
  return {
    mode: dubbingMode,
    signature: transformationSignature,
    engine: [...engines].join(' · '),
    turns: translatedTurns,
  }
}, (cached) => cached?.mode === dubbingMode && cached?.signature === transformationSignature)

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
reportProgress('aligning', 58, '正在对齐配音稿与原始讲话节奏', { turns: translated.turns })
const rhythmPlan = await cachedJson('05-rhythm-plan.json', async () => {
  let plannedTurns = []
  let engine = 'deterministic-single-segment'
  if (turnsWithInternalPauses.length) {
    const response = await execute({
      capability: 'text.generate',
      providerId: 'api.bailian',
      routing: 'quality',
      title: 'Video dubbing · align script phrases to source pauses',
      input: {
        messages: [
          {
            role: 'system',
            content: [
              '你是视频配音节奏编辑。把整段配音稿拆成与原始节奏短语一一对应的短语，并保持配音稿的语言。',
              '每个 segment id 必须原样保留且只出现一次；禁止合并、遗漏或新增 segment。',
              '各短语应分别对应 sourceText 的节奏，连接起来后必须忠实覆盖完整配音稿。',
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
  const cachedVoices = readJsonIfValid(cloudVoicePath)
  if (cachedVoices) {
    cloudVoices = cachedVoices
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
    `正在生成视频配音 ${index + 1}/${speechUnits.length}`,
    { completedUnits: index, totalUnits: speechUnits.length },
  )
  const { turn, segment } = speechUnits[index]
  const reference = references.get(turn.speaker)
  const unitNumber = String(index + 1).padStart(2, '0')

  async function synthesize(text, speed, pass) {
    const engineName = cloudMode ? 'bailian' : 'zipvoice'
    const signature = shortHash(JSON.stringify({ text, speaker: turn.speaker, reference: reference.text }))
    const cachePath = path.join(outputDir, `${engineName}-${pass}-${unitNumber}-${signature}-${speed.toFixed(3)}.json`)
    const cachedOutput = readJsonIfValid(cachePath)
    if (cachedOutput) return cachedOutput
    const output = await execute({
      capability: 'speech.synthesize',
      providerId: cloudMode ? 'api.bailian' : 'plugin.k2-fsa.zipvoice-zh-en',
      routing: cloudMode ? 'quality' : 'local',
      title: `Video dubbing · clone ${turn.speaker} · ${index + 1}/${speechUnits.length} · ${pass}`,
      input: { text },
      parameters: cloudMode
        ? {
            modelId: cloudTtsModel,
            voice: cloudVoices[turn.speaker].id,
            speed,
            instruction: dubbingMode === 'translate'
              ? `自然、清晰的${dubbingLanguageName(targetLanguage)}口播，保留参考说话人的音色。`
              : `自然、清晰的${dubbingLanguageName(speechLanguage)}视频口播，保持文案语言并保留参考说话人的音色。`,
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
    const cachedRewrite = readJsonIfValid(cachePath, (value) => Boolean(value?.text))
    if (cachedRewrite) return cachedRewrite.text
    const ratio = desiredDuration / naturalDuration
    const currentLength = [...text].length
    const minimumLength = desiredDuration < 1 ? 2 : desiredDuration < 1.5 ? 3 : 6
    const targetLength = Math.max(minimumLength, Math.round(currentLength * ratio))
    const response = await execute({
      capability: 'text.generate',
      providerId: 'api.bailian',
      routing: 'quality',
      title: `Video dubbing · fit ${segment.id} to speech window · ${attempt}`,
      input: {
        messages: [
          {
            role: 'system',
            content: [
              '你是专业视频配音编辑。根据一次真实 TTS 的测量结果，重写配音稿，使它用自然语速读完时接近目标时长，并保持原语言。',
              dubbingMode === 'script'
                ? '必须忠实保留 currentScript 的原意；过长时精简，过短时只能补充自然表达，禁止改回 referenceText 的内容或添加新事实。'
                : '必须忠实保留 referenceText 的原意；过长时精简，过短时补回原文中的语气和细节，但禁止凑字、重复或添加新事实。',
              '结果必须自然；短节奏片段可以是完整短语，长片段必须是完整口语句子，不能以未完成的连接词结尾，也禁止以省略号或“的”等悬挂成分结尾。只返回 JSON：{"text":"..."}。',
            ].join(''),
          },
          {
            role: 'user',
            content: JSON.stringify({
              referenceText: segment.sourceText,
              currentScript: text,
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
    // Rewrite until natural speech lands within ±5% of the window (up to 4
    // rounds): a faithful re-write in the speaker's own cadence always
    // sounds better than speed-skewing the voice itself.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const measuredSpeed = best.duration / desiredSpeechDuration
      if (measuredSpeed >= 0.95 && measuredSpeed <= 1.05) break
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
  // Cloud TTS speed is kept within ±8%: the rewrite loop already did the
  // heavy lifting, and larger speed offsets tint the cloned voice.
  let initialRequestedSpeed = clamp(
    Math.pow(naturalDuration / desiredSpeechDuration, cloudMode ? 1 : 0.5),
    cloudMode ? 0.92 : 0.5,
    cloudMode ? 1.08 : 2,
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
        cloudMode ? 0.92 : 0.5,
        cloudMode ? 1.08 : 2,
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
  // Slowing down below 0.9× sounds worse than a slightly longer pause, so
  // underfull speech keeps its pace and the window tail simply stays silent.
  const alignedPath = path.join(outputDir, `aligned-rhythm-${unitNumber}.wav`)
  run('ffmpeg', [
    '-y', '-i', preparedGenerated.filePath,
    '-af', `${atempoChain(Math.max(factor, 0.9))},apad,atrim=duration=${targetDuration.toFixed(6)},adelay=${Math.round(segment.start * 1000)}:all=1`,
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
    tempoFactor: Math.max(factor, 0.9),
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
const dubbedTrackPath = path.join(outputDir, 'dubbed-voice.wav')
const mixInputs = dubbedSegments.flatMap((segment) => ['-i', segment.alignedPath])
const mixLabels = dubbedSegments.map((_, index) => `[${index}:a]`).join('')
run('ffmpeg', [
  '-y', ...mixInputs,
  '-filter_complex', `${mixLabels}amix=inputs=${dubbedSegments.length}:duration=longest:normalize=0,loudnorm=I=-16:LRA=11:TP=-1.5,apad,atrim=duration=${videoDuration.toFixed(6)}[a]`,
  '-map', '[a]', '-ac', '2', '-ar', '44100',
  dubbedTrackPath,
])

const subtitlePath = path.join(outputDir, 'dubbing-script.srt')
const assPath = path.join(outputDir, 'dubbing-script.ass')
reportProgress('subtitles', 93, '正在生成配音字幕')
fs.writeFileSync(subtitlePath, `${translated.turns.map((turn, index) => [
  index + 1,
  `${srtTimestamp(turn.start)} --> ${srtTimestamp(turn.end)}`,
  isCjkText(turn.text) ? keepPunctuationWithPreviousCharacter(turn.text) : turn.text,
  turn.sourceText,
  '',
].join('\n')).join('\n')}\n`)

const videoSize = probeVideoResolution(inputPath)
fs.writeFileSync(assPath, buildAssDocument(translated.turns, videoSize))

// Prefer libass (cross-platform, styled, resolution-accurate). Fall back to the
// macOS sips overlay pipeline, then to a subtitle-track-only render.
let subtitleRenderer = detectFilterSupport('subtitles') ? 'libass' : null
if (!subtitleRenderer) {
  try {
    run('sips', ['--version'])
    subtitleRenderer = 'sips-overlay'
  } catch {
    subtitleRenderer = 'mov_text-only'
  }
}

const subtitleImages = subtitleRenderer === 'sips-overlay'
  ? translated.turns.map((turn, index) => renderSubtitleImage(turn, index, videoSize))
  : []
const subtitleImageInputs = subtitleImages.flatMap((imagePath) => ['-loop', '1', '-framerate', '1', '-i', imagePath])
let previousVideoLabel = '[0:v]'
let videoFilters = []
if (subtitleRenderer === 'libass') {
  videoFilters = [`[0:v]ass=filename='${escapeFfmpegFilterPath(assPath)}'[video-out]`]
  previousVideoLabel = '[video-out]'
} else if (subtitleRenderer === 'sips-overlay') {
  videoFilters = translated.turns.map((turn, index) => {
    const outputLabel = `[video-${index + 1}]`
    const filter = `${previousVideoLabel}[${index + 4}:v]overlay=0:0:enable='between(t,${turn.start.toFixed(6)},${turn.end.toFixed(6)})'${outputLabel}`
    previousVideoLabel = outputLabel
    return filter
  })
}

const videoMapLabel = subtitleRenderer === 'mov_text-only' ? '0:v' : previousVideoLabel

const includeBackground = backgroundAnalysis?.decision !== 'skip_separation_mix'
// Duck the background under the dubbed voice instead of a fixed low volume, so
// music stays present in speech gaps and recedes while someone talks.
const audioMixFilter = includeBackground
  ? `[1:a]asplit=2[dub][duckkey];[2:a]volume=0.55[bgraw];[bgraw][duckkey]sidechaincompress=threshold=0.03:ratio=12:attack=12:release=600[bg];[dub][bg]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95,apad,atrim=duration=${videoDuration.toFixed(6)}[mix]`
  : `[1:a]alimiter=limit=0.95,apad,atrim=duration=${videoDuration.toFixed(6)}[mix]`

const outputVideoPath = path.join(
  outputDir,
  `${path.basename(inputPath, path.extname(inputPath))}-${
    dubbingMode === 'translate' ? `${targetLanguage}-translated` : dubbingMode === 'rewrite' ? 'rewritten' : 'new-script'
  }-voice-clone.mp4`,
)
const SUBTITLE_ISO_639_2 = { zh: 'zho', en: 'eng', ja: 'jpn', ko: 'kor' }
const subtitleLanguage = dubbingMode === 'translate' ? (SUBTITLE_ISO_639_2[targetLanguage] ?? 'und') : 'und'
const stagingVideoPath = `${outputVideoPath}.next.mp4`
reportProgress('rendering', 96, '正在渲染最终视频')
run('ffmpeg', [
  '-y', '-i', inputPath, '-i', dubbedTrackPath, '-i', backgroundPath, '-i', subtitlePath, ...subtitleImageInputs,
  '-filter_complex', [audioMixFilter, ...videoFilters].join(';'),
  '-map', videoMapLabel, '-map', '[mix]', '-map', '3:0',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k',
  '-c:s', 'mov_text', '-metadata:s:s:0', `language=${subtitleLanguage}`,
  '-t', videoDuration.toFixed(6), '-shortest', '-movflags', '+faststart',
  stagingVideoPath,
])
fs.renameSync(stagingVideoPath, outputVideoPath)

saveJson('08-report.json', {
  inputPath,
  outputVideoPath,
  dubbingMode,
  sourceLanguage,
  targetLanguage: dubbingMode === 'translate' ? targetLanguage : undefined,
  detectedLanguage: speechLanguage,
  sourceDuration: videoDuration,
  separatedWith: separated.engine,
  vocalsEnhancedWith: vocalsEnhanced?.engine,
  diarizedWith: diarization.engine,
  speakerCount: diarization.speakerCount,
  speakers,
  transcribedWith: transcription.engine,
  translationContextWith: translationContext?.engine,
  translationGlossarySize: translationContext?.context?.glossary?.length ?? 0,
  translatedWith: translated.engine,
  synthesizedWith: cloudMode ? `Bailian ${cloudTtsModel} cloned voice` : 'ZipVoice Distill INT8 zh-en (4 steps)',
  turnCount: translated.turns.length,
  rhythmSegmentCount: speechUnits.length,
  preservedInternalPauseCount: speechUnits.length - translated.turns.length,
  rhythmPauseThresholdSeconds: minimumInternalPauseSeconds,
  backgroundDucking: includeBackground,
  backgroundDecision: backgroundAnalysis?.decision ?? 'separate_and_mix',
  backgroundAnalysis,
  subtitleRenderer,
  subtitlePath,
  assPath,
})

reportProgress('completed', 100, '视频配音已完成', {
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
