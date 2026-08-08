import type { AsrTranscriptionResult } from '../types'

export type TranscriptExportFormat = 'srt' | 'vtt' | 'txt' | 'label-studio'

function pad(value: number, length = 2): string {
  return Math.max(0, value).toString().padStart(length, '0')
}

function timestamp(seconds: number, separator: ',' | '.'): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((milliseconds % 60_000) / 1000)
  const millis = milliseconds % 1000
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`
}

export function transcriptToSrt(result: AsrTranscriptionResult): string {
  return result.segments
    .map(
      (segment, index) =>
        `${index + 1}\n${timestamp(segment.start, ',')} --> ${timestamp(segment.end, ',')}\n${segment.text}\n`,
    )
    .join('\n')
}

export function transcriptToVtt(result: AsrTranscriptionResult): string {
  const cues = result.segments
    .map(
      (segment) =>
        `${timestamp(segment.start, '.')} --> ${timestamp(segment.end, '.')}\n${segment.text}\n`,
    )
    .join('\n')
  return `WEBVTT\n\n${cues}`
}

export function transcriptToPlainText(
  result: AsrTranscriptionResult,
): string {
  const segments = result.segments
    .map(
      (segment) =>
        `[${timestamp(segment.start, '.')} - ${timestamp(segment.end, '.')}] ${segment.text}`,
    )
    .join('\n')
  return `${result.text}\n\n---\n${segments}\n`
}

export function transcriptToLabelStudio(
  result: AsrTranscriptionResult,
  audioReference: string,
): string {
  const annotations = result.segments.flatMap((segment, segmentIndex) => {
    const regionId = `segment-${segmentIndex + 1}`
    return [
      {
        id: regionId,
        type: 'labels',
        value: {
          start: segment.start,
          end: segment.end,
          channel: 0,
          labels: ['Speech'],
        },
        from_name: 'segment_labels',
        to_name: 'audio',
      },
      {
        id: regionId,
        type: 'textarea',
        value: {
          start: segment.start,
          end: segment.end,
          channel: 0,
          text: [segment.text],
        },
        from_name: 'transcription',
        to_name: 'audio',
      },
      ...segment.tokens.map((token, tokenIndex) => ({
        id: `${regionId}-word-${tokenIndex + 1}`,
        type: 'labels',
        value: {
          start: token.start,
          end: token.end,
          channel: 0,
          text: token.text,
          labels: ['Word'],
        },
        from_name: 'word_labels',
        to_name: 'audio',
      })),
    ]
  })

  return JSON.stringify(
    [
      {
        data: { audio: audioReference },
        meta: {
          language: result.language,
          engine: result.engine,
          duration: result.duration,
        },
        annotations: [{ result: annotations }],
      },
    ],
    null,
    2,
  )
}

export function downloadTranscript(
  result: AsrTranscriptionResult,
  format: TranscriptExportFormat,
  audioReference: string,
): string {
  const baseName = result.clipName.replace(/\.[^.]+$/, '')
  const exports: Record<
    TranscriptExportFormat,
    { content: string; extension: string; mimeType: string }
  > = {
    srt: {
      content: transcriptToSrt(result),
      extension: 'srt',
      mimeType: 'application/x-subrip;charset=utf-8',
    },
    vtt: {
      content: transcriptToVtt(result),
      extension: 'vtt',
      mimeType: 'text/vtt;charset=utf-8',
    },
    txt: {
      content: transcriptToPlainText(result),
      extension: 'txt',
      mimeType: 'text/plain;charset=utf-8',
    },
    'label-studio': {
      content: transcriptToLabelStudio(result, audioReference),
      extension: 'label-studio.json',
      mimeType: 'application/json;charset=utf-8',
    },
  }
  const selected = exports[format]
  const fileName = `${baseName}.${selected.extension}`
  const url = URL.createObjectURL(
    new Blob([selected.content], { type: selected.mimeType }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return fileName
}
