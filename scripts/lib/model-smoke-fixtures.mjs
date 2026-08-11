import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const APP_DATA = path.join(
  os.homedir(),
  'Library/Application Support/org.qwenaudio.toolkits',
)
const MODEL_REPOSITORY = path.join(
  os.homedir(),
  'data/QwenAudio-Toolkits/models',
)

export function appDataPath(...segments) {
  return path.join(APP_DATA, ...segments)
}

export function modelRepositoryPath(...segments) {
  return path.join(MODEL_REPOSITORY, ...segments)
}

export function firstExistingPath(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null
}

export function resolveAudioPath(candidates, label) {
  const resolved = firstExistingPath(candidates)
  if (!resolved) {
    throw new Error(
      `${label} audio fixture is missing. Set QWEN_AUDIO_TOOLKITS_${label.toUpperCase()}_WAV ` +
        'or install the corresponding local model fixture.',
    )
  }
  return resolved
}

export function audioInput(filePath, fallbackPath) {
  const resolvedPath = firstExistingPath([filePath, fallbackPath])
  if (!resolvedPath) {
    throw new Error(`Smoke test audio is missing: ${filePath}`)
  }
  return {
    audioDataUrl: `data:audio/wav;base64,${fs.readFileSync(resolvedPath).toString('base64')}`,
    clipName: path.basename(resolvedPath),
  }
}

export function macEnglishSpeechFixture(configuredPath) {
  const configured = firstExistingPath([configuredPath])
  if (configured) return configured
  if (process.platform !== 'darwin') return null
  const generated = path.join(os.tmpdir(), 'qwen-audio-canary-smoke.wav')
  if (!fs.existsSync(generated)) {
    execFileSync('/usr/bin/say', [
      '-o', generated,
      '--file-format=WAVE',
      '--data-format=LEI16@16000',
      'The office opens at nine in the morning and closes at five in the afternoon.',
    ])
  }
  return generated
}
