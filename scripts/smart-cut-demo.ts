import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  buildSmartCutCandidates,
  buildSmartCutSubtitleCues,
  keepRangesFromCuts,
  type SmartCutCandidate,
} from '../src/domain/smartCut'
import type {
  AsrTranscriptionResult,
  VadDetectionResult,
} from '../src/types'

const api = process.env.QWEN_AUDIO_DEMO_API ?? 'http://127.0.0.1:3847/v1'
const transcribeOnly = process.argv.includes('--transcribe-only')
const reusePlan = process.argv.includes('--reuse-plan')
const source = resolve(process.argv[2] ?? '')
const outputDirectory = resolve(process.argv[3] ?? 'artifacts/smart-cut-demo')
const audioPath = join(outputDirectory, 'friedel-interview-16k.wav')
const outputPath = join(outputDirectory, 'friedel-interview-smart-cut.mp4')
const planPath = join(outputDirectory, 'friedel-interview-edit-plan.json')
const reportPath = join(outputDirectory, 'README.md')
const subtitlePath = join(outputDirectory, 'friedel-interview-smart-cut.srt')
const subtitlePayloadPath = join(outputDirectory, 'subtitle-overlays.json')
const subtitleOverlayDirectory = join(outputDirectory, '.subtitle-overlays')
const subtitleTimelinePath = join(subtitleOverlayDirectory, 'timeline.ffconcat')

if (!process.argv[2]) throw new Error('Usage: smart-cut-demo.ts <video> [output-directory]')

function run(command: string, args: string[], binary = false): Buffer | string {
  const result = spawnSync(command, args, {
    encoding: binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `${command} exited with ${result.status}`))
  }
  return result.stdout ?? (binary ? Buffer.alloc(0) : '')
}

async function jsonRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(payload))
  return payload
}

async function execute<T>(request: Record<string, unknown>): Promise<T> {
  const submitted = await jsonRequest('/runs', {
    method: 'POST',
    body: JSON.stringify({ ...request, conversationVisible: false }),
  })
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const current = await jsonRequest(`/runs/${submitted.id}`)
    if (current.status === 'completed') {
      const execution = await jsonRequest(`/runs/${submitted.id}/output`)
      return execution.output as T
    }
    if (current.status === 'failed' || current.status === 'canceled') {
      throw new Error(current.error ?? `Run ${current.status}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Model run timed out')
}

function frame(timestamp: number): Buffer | null {
  try {
    return run(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', Math.max(0, timestamp).toFixed(3), '-i', source,
        '-frames:v', '1', '-vf', 'scale=64:36,format=gray',
        '-f', 'rawvideo', 'pipe:1',
      ],
      true,
    ) as Buffer
  } catch {
    return null
  }
}

function visualSimilarity(candidate: SmartCutCandidate): number | null {
  const before = frame(candidate.start - 0.05)
  const after = frame(candidate.end + 0.05)
  if (!before || !after || before.length < 2304 || after.length < 2304) return null
  let difference = 0
  for (let index = 0; index < 2304; index += 1) {
    difference += Math.abs(before[index] - after[index])
  }
  return Math.max(0, Math.min(1, 1 - difference / 2304 / 255))
}

function srtTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((milliseconds % 60_000) / 1000)
  const millis = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

function concatFile(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

const probe = JSON.parse(
  run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', source,
  ]) as string,
)
const duration = Number(probe.format?.duration)
if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration')

run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source,
  '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath,
])
const audioDataUrl = `data:audio/wav;base64,${readFileSync(audioPath).toString('base64')}`
const input = { audioDataUrl, clipName: basename(source), duration }

if (transcribeOnly) {
  const verified = await execute<AsrTranscriptionResult>({
    capability: 'speech.transcribe',
    providerId: 'plugin.nvidia.parakeet-tdt-0.6b-v3',
    title: 'Smart Cut demo · verification',
    input,
    parameters: { modelId: 'parakeet-tdt-0.6b-v3-int8', language: 'en' },
  })
  console.log(JSON.stringify({ duration, transcript: verified.text }, null, 2))
  process.exit(0)
}

let transcription: AsrTranscriptionResult
let vad: VadDetectionResult
if (reusePlan) {
  const previous = JSON.parse(readFileSync(planPath, 'utf8')) as {
    transcription: AsrTranscriptionResult
    vad: VadDetectionResult
  }
  transcription = previous.transcription
  vad = previous.vad
} else {
  [transcription, vad] = await Promise.all([
    execute<AsrTranscriptionResult>({
      capability: 'speech.transcribe',
      providerId: 'plugin.nvidia.parakeet-tdt-0.6b-v3',
      title: 'Smart Cut demo · transcription',
      input,
      parameters: { modelId: 'parakeet-tdt-0.6b-v3-int8', language: 'en' },
    }),
    execute<VadDetectionResult>({
      capability: 'speech.detect',
      providerId: 'local.silero-vad',
      title: 'Smart Cut demo · VAD',
      input,
      parameters: {
        modelId: 'silero-vad', threshold: 0.25,
        minSpeechDuration: 0.18, minSilenceDuration: 0.2,
      },
    }),
  ])
}

const candidates = buildSmartCutCandidates(transcription, vad, duration, {
  minimumSilence: 0.65,
  edgePadding: 0.12,
}).map((candidate) => {
  if (candidate.reason !== 'silence') return candidate
  const similarity = visualSimilarity(candidate)
  const stable = similarity !== null && similarity >= 0.9
  return {
    ...candidate,
    visualSimilarity: similarity ?? undefined,
    visualAvailable: similarity !== null,
    visualStable: stable,
    selected: stable && candidate.confidence === 'high',
  }
})
const keepRanges = keepRangesFromCuts(candidates, duration)
const selected = candidates.filter((candidate) => candidate.selected)
if (!selected.length) throw new Error('No conservative cuts found in demo video')
const subtitleCues = buildSmartCutSubtitleCues(transcription, candidates, duration, {}, vad)
const outputDuration = keepRanges.reduce((sum, range) => sum + range.end - range.start, 0)

writeFileSync(
  subtitlePath,
  subtitleCues.map((cue, index) =>
    `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`,
  ).join('\n'),
)
rmSync(subtitleOverlayDirectory, { recursive: true, force: true })
mkdirSync(subtitleOverlayDirectory, { recursive: true })
writeFileSync(subtitlePayloadPath, JSON.stringify({
  width: Number(probe.streams?.find((stream: { codec_type?: string }) => stream.codec_type === 'video')?.width) || 960,
  height: Number(probe.streams?.find((stream: { codec_type?: string }) => stream.codec_type === 'video')?.height) || 540,
  cues: subtitleCues,
}, null, 2))
run('/usr/bin/swift', [
  resolve('scripts/render-subtitle-overlays.swift'),
  subtitlePayloadPath,
  subtitleOverlayDirectory,
])

const timeline: string[] = ['ffconcat version 1.0']
let subtitleCursor = 0
const appendTimelineImage = (path: string, imageDuration: number) => {
  if (imageDuration <= 0.001) return
  timeline.push(`file ${concatFile(path)}`)
  timeline.push(`duration ${imageDuration.toFixed(6)}`)
}
for (const [index, cue] of subtitleCues.entries()) {
  appendTimelineImage(join(subtitleOverlayDirectory, 'blank.png'), cue.start - subtitleCursor)
  appendTimelineImage(
    join(subtitleOverlayDirectory, `cue-${String(index + 1).padStart(3, '0')}.png`),
    cue.end - Math.max(cue.start, subtitleCursor),
  )
  subtitleCursor = Math.max(subtitleCursor, cue.end)
}
appendTimelineImage(join(subtitleOverlayDirectory, 'blank.png'), outputDuration - subtitleCursor)
timeline.push(`file ${concatFile(join(subtitleOverlayDirectory, 'blank.png'))}`)
writeFileSync(subtitleTimelinePath, `${timeline.join('\n')}\n`)

let filter = ''
let concatInputs = ''
for (const [index, range] of keepRanges.entries()) {
  filter += `[0:v]trim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2[v${index}];`
  filter += `[0:a]atrim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},asetpts=PTS-STARTPTS,apad,atrim=duration=${(range.end - range.start).toFixed(3)}[a${index}];`
  concatInputs += `[v${index}][a${index}]`
}
filter += `${concatInputs}concat=n=${keepRanges.length}:v=1:a=1[vbase][aout];`
filter += '[1:v]format=rgba[subtitles];[vbase][subtitles]overlay=0:0:eof_action=pass[vout]'
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source,
  '-f', 'concat', '-safe', '0', '-i', subtitleTimelinePath,
  '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
  '-c:v', 'h264_videotoolbox', '-q:v', '60',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
])
rmSync(subtitleOverlayDirectory, { recursive: true, force: true })
rmSync(subtitlePayloadPath, { force: true })

writeFileSync(planPath, JSON.stringify({
  source,
  duration,
  transcription,
  vad,
  candidates,
  keepRanges,
  subtitleCues,
}, null, 2))
writeFileSync(reportPath, `# Smart Cut demo

- Source: [Friedel Wikipedia Public Policy Initiative interview clip](https://commons.wikimedia.org/wiki/File:Friedel_Wikipedia_Public_Policy_Initiative_interview_clip.webm)
- Author: Pongr
- License: CC BY-SA 3.0
- Modification: silence/filler rough cut created with QwenAudio Toolkits
- Subtitles: remapped after cuts and burned into the sample; SRT is included alongside it
- Original duration: ${duration.toFixed(2)} s
- Output duration: ${outputDuration.toFixed(2)} s
- Selected cuts: ${selected.length}

## Transcript

${transcription.text}

## Applied cuts

${selected.map((candidate) => `- ${candidate.start.toFixed(2)}–${candidate.end.toFixed(2)} s · ${candidate.label}${candidate.visualSimilarity === undefined ? '' : ` · visual similarity ${(candidate.visualSimilarity * 100).toFixed(1)}%`}`).join('\n')}
`)

console.log(JSON.stringify({
  source,
  outputPath,
  planPath,
  reportPath,
  subtitlePath,
  originalDuration: duration,
  outputDuration,
  candidateCount: candidates.length,
  selectedCount: selected.length,
  transcript: transcription.text,
}, null, 2))
