import { createWaveSamples } from '../data'
import type { AudioClip } from '../types'

function readPeaks(buffer: AudioBuffer, peakCount: number): number[] {
  const channel = buffer.getChannelData(0)
  const blockSize = Math.max(1, Math.floor(channel.length / peakCount))
  const stride = Math.max(1, Math.floor(blockSize / 2048))

  return Array.from({ length: peakCount }, (_, peakIndex) => {
    const start = peakIndex * blockSize
    const end = Math.min(channel.length, start + blockSize)
    let peak = 0

    for (let index = start; index < end; index += stride) {
      peak = Math.max(peak, Math.abs(channel[index] ?? 0))
    }

    return Math.max(0.035, Math.min(1, peak))
  })
}

function encodePcm16WavDataUrl(
  channels: Float32Array[],
  sampleRate: number,
): string {
  const channelCount = Math.max(1, channels.length)
  const frameCount = Math.min(...channels.map((channel) => channel.length))
  const dataSize = frameCount * channelCount * 2
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(
        -1,
        Math.min(1, channels[channel]?.[frame] ?? 0),
      )
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true,
      )
      offset += 2
    }
  }

  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    )
  }
  return `data:audio/wav;base64,${btoa(binary)}`
}

function createProcessingAudioUrl(decoded: AudioBuffer): string {
  return encodePcm16WavDataUrl(
    Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
      decoded.getChannelData(channel),
    ),
    decoded.sampleRate,
  )
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('无法读取音频文件')),
    )
    reader.readAsDataURL(file)
  })
}

export function pcm16ChunksToWavFile(
  chunks: string[],
  sampleRate: number,
  fileName: string,
): File {
  const decoded = chunks.map((chunk) => {
    const binary = atob(chunk)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  })
  const dataSize = decoded.reduce((size, chunk) => size + chunk.length, 0)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)
  return new File([header, ...decoded], fileName, { type: 'audio/wav' })
}

export async function audioFileToClip(file: File): Promise<AudioClip> {
  const url = URL.createObjectURL(file)
  const fallback: AudioClip = {
    id: `import-${crypto.randomUUID()}`,
    name: file.name,
    duration: 30,
    sampleRate: 48000,
    channels: 2,
    kind: 'recording',
    samples: createWaveSamples(file.size || 4, 280, 0.8),
    color: '#827df8',
    sizeLabel: formatFileSize(file.size),
    sourceLabel: '本地文件',
    url,
  }

  const context = new AudioContext()
  try {
    const arrayBuffer = await file.arrayBuffer()
    const decoded = await context.decodeAudioData(arrayBuffer)
    const wavInput =
      file.type === 'audio/wav' || /\.wav$/i.test(file.name)
        ? await fileToDataUrl(file)
        : createProcessingAudioUrl(decoded)
    const clip: AudioClip = {
      ...fallback,
      duration: decoded.duration,
      sampleRate: decoded.sampleRate,
      channels: decoded.numberOfChannels,
      samples: readPeaks(decoded, 320),
      processingAudioUrl: wavInput,
      transcriptionAudioUrl: wavInput,
    }
    return clip
  } catch {
    return fallback
  } finally {
    if (context.state !== 'closed') {
      await context.close().catch(() => undefined)
    }
  }
}

export function formatTime(seconds: number, precise = false): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const remaining = safeSeconds - minutes * 60

  return precise
    ? `${minutes}:${remaining.toFixed(1).padStart(4, '0')}`
    : `${minutes}:${Math.floor(remaining).toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
