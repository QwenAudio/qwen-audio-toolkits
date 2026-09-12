import { voiceParameters, type PodcastScript } from './podcast'

export interface PodcastVoiceSettings {
  modelId: string
  providerId: string
  modelVersion: string
  apiModel: boolean
  supportsLanguage: boolean
  voiceA: string
  voiceB: string
  speed: number
}

export interface PodcastPlannedSegment {
  key: string
  turnId: string
  text: string
  parameters: Record<string, unknown>
  pauseAfterMs: number
}

export interface PodcastSynthesisPlan {
  fingerprint: string
  segments: PodcastPlannedSegment[]
}

export type PodcastSegmentCache = Record<string, string>
const MAX_CACHED_SEGMENTS = 400

/** Keys describe the exact speech request; order and pauses belong to the final mix. */
export function planPodcastAudio(script: PodcastScript, settings: PodcastVoiceSettings): PodcastSynthesisPlan {
  const audibleTurns = script.turns.filter((turn) => turn.text.trim())
  const segments = audibleTurns.map((turn, index) => {
    const parameters = {
      speed: settings.speed,
      ...voiceParameters(turn.speaker === 'A' ? settings.voiceA : settings.voiceB, settings.apiModel, turn.speaker === 'A' ? 0 : 1),
      ...(settings.supportsLanguage ? { language: script.language.toLowerCase().startsWith('zh') ? 'zh' : 'en' } : {}),
    }
    const text = turn.text.trim()
    return {
      key: JSON.stringify(['podcast-segment-v1', settings.modelId, settings.providerId, settings.modelVersion, text, parameters]),
      turnId: turn.id,
      text,
      parameters,
      pauseAfterMs: index + 1 === audibleTurns.length ? 0 : audibleTurns[index + 1].speaker !== turn.speaker ? 320 : 220,
    }
  })
  return {
    // Include empty rows and speaker assignments so edits cannot silently export an old script.
    fingerprint: JSON.stringify([
      'podcast-mix-v1',
      script.turns.map((turn) => [turn.id, turn.speaker, turn.text.trim()]),
      segments.map((segment) => [segment.key, segment.pauseAfterMs]),
    ]),
    segments,
  }
}

export function podcastAudioIsCurrent(outputFingerprint: string | null, plan: PodcastSynthesisPlan | null): boolean {
  return Boolean(outputFingerprint && plan && outputFingerprint === plan.fingerprint)
}

/** Keep every completed request, including those preceding a later failed request. */
export async function resolvePodcastSegments(
  plan: PodcastSynthesisPlan,
  cache: PodcastSegmentCache,
  generate: (segment: PodcastPlannedSegment) => Promise<string>,
  onCache: (cache: PodcastSegmentCache) => void,
  onProgress: (completed: number, total: number) => void,
): Promise<Array<{ turnId: string; filePath: string; pauseAfterMs: number }>> {
  const available = { ...cache }
  const result: Array<{ turnId: string; filePath: string; pauseAfterMs: number }> = []
  for (const segment of plan.segments) {
    let filePath = available[segment.key]
    if (!filePath) {
      filePath = await generate(segment)
      available[segment.key] = filePath
      // Keep several revisions without letting long-lived projects fill the workspace store.
      const keys = Object.keys(available)
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_SEGMENTS))) delete available[key]
      // Snapshots are independent, so React receives each successful segment before the next await.
      onCache({ ...available })
    }
    result.push({ turnId: segment.turnId, filePath, pauseAfterMs: segment.pauseAfterMs })
    onProgress(result.length, plan.segments.length)
  }
  return result
}
