import type { VideoDubbingMode, VideoDubbingStyle } from './agents'
import { t } from '../i18n'

export const VIDEO_DUBBING_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'] as const
export interface VideoDubbingSettings {
  instruction: string
  mode: VideoDubbingMode
  sourceLanguage: string
  targetLanguage: string
  style: VideoDubbingStyle
}

export function readVideoDubbingSettings(value: unknown): VideoDubbingSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  if (typeof data.instruction !== 'string' ||
    !['translate', 'rewrite', 'script'].includes(String(data.mode)) ||
    !['auto', ...VIDEO_DUBBING_LANGUAGES].includes(String(data.sourceLanguage)) ||
    !VIDEO_DUBBING_LANGUAGES.includes(data.targetLanguage as typeof VIDEO_DUBBING_LANGUAGES[number]) ||
    !['natural', 'formal', 'casual'].includes(String(data.style))) return undefined
  return {
    instruction: data.instruction,
    mode: data.mode as VideoDubbingMode,
    sourceLanguage: data.sourceLanguage as string,
    targetLanguage: data.targetLanguage as string,
    style: data.style as VideoDubbingStyle,
  }
}

/** Only fields consumed by the renderer may be configured through chat. */
export function configureVideoDubbing(
  current: VideoDubbingSettings,
  args: Record<string, unknown>,
): VideoDubbingSettings {
  const allowed = ['instruction', 'mode', 'sourceLanguage', 'targetLanguage', 'style']
  if (!Object.keys(args).length || Object.keys(args).some(key => !allowed.includes(key))) {
    throw new Error(t('请选择要修改的配音设置。'))
  }
  const result = readVideoDubbingSettings({ ...current, ...args })
  if (!result || result.instruction.length > 50000) throw new Error(t('配音设置无效，请检查文案、语言和风格。'))
  return result
}

/** The native pipeline caches by directory, so every effective setting belongs here. */
export function videoDubbingFingerprint(sourcePath: string, settings: VideoDubbingSettings): string {
  return JSON.stringify([
    sourcePath, settings.instruction.trim(), settings.mode, settings.sourceLanguage,
    settings.mode === 'translate' ? settings.targetLanguage : settings.sourceLanguage,
    settings.style,
  ])
}

export function reusableVideoDubbingDirectory(
  outputDir: string, previousFingerprint: string, currentFingerprint: string,
  status: string | undefined,
): string | undefined {
  return outputDir && previousFingerprint === currentFingerprint &&
    (status === 'failed' || status === 'canceled') ? outputDir : undefined
}
