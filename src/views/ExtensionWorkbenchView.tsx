import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { AiPodcastView } from './AiPodcastView'
import { MeetingNotesView } from './MeetingNotesView'
import { VideoDubbingView } from './VideoDubbingView'
import { t } from '../i18n'
import {
  extensionWorkbenchPageLabels,
  extensionWorkbenchPages,
  type ExtensionWorkbenchPage,
} from '../services/extensionWorkbenchState'
import type {
  AsrTranscriptionResult,
  AudioClip,
  AudioProcessResult,
  HarnessCapabilityId,
  HarnessCatalog,
  HarnessExecution,
  ModelPlugin,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
} from '../types'
import './ExtensionWorkbenchView.css'

type ExtensionTextCapability = Extract<
  HarnessCapabilityId,
  | 'speech.synthesize'
  | 'text.generate'
  | 'text.punctuate'
  | 'text.normalize'
>
type ExtensionAudioCapability = Extract<
  HarnessCapabilityId,
  | 'speech.transcribe'
  | 'speech.detect'
  | 'audio.enhance'
  | 'audio.classify'
  | 'speech.keyword'
  | 'speech.language'
  | 'speaker.embed'
  | 'speaker.diarize'
  | 'audio.separate'
>

export interface ExtensionExecutionContext {
  models: ModelPlugin[]
  catalog: HarnessCatalog | null
  runText: (
    text: string,
    capability: ExtensionTextCapability,
    providerId: string,
    modelId: string,
    modelParameters: Record<string, unknown>,
    dependencyRunIds?: string[],
    conversationVisible?: boolean,
  ) => Promise<
    HarnessExecution<TtsGenerateResult | TextGenerateResult | Record<string, unknown>>
  >
  runAudio: (
    clip: AudioClip,
    capability: ExtensionAudioCapability,
    providerId: string,
    modelId: string,
    modelParameters: Record<string, unknown>,
    conversationVisible?: boolean,
    dependencyRunIds?: string[],
    comparisonClip?: AudioClip,
  ) => Promise<
    HarnessExecution<
      | AsrTranscriptionResult
      | VadDetectionResult
      | AudioProcessResult
      | Record<string, unknown>
    >
  >
  openModelStore(): void
  notify(message: string): void
}

export interface ExtensionWorkbenchViewProps {
  page: ExtensionWorkbenchPage
  context: ExtensionExecutionContext
  onPageChange(page: ExtensionWorkbenchPage): void
  onClose(): void
  children: ReactNode
}

export function ExtensionWorkbenchView({
  page,
  context,
  onPageChange,
  onClose,
  children,
}: ExtensionWorkbenchViewProps) {
  const content =
    page === 'models' ? (
      children
    ) : page === 'podcast' ? (
      <AiPodcastView
        projectId="extension-ai-podcast"
        models={context.models}
        catalog={context.catalog}
        onRunText={context.runText}
        onOpenStore={context.openModelStore}
        onAction={context.notify}
      />
    ) : page === 'meeting-notes' ? (
      <MeetingNotesView
        projectId="extension-meeting-notes"
        initialInstruction=""
        models={context.models}
        onRunText={context.runText}
        onRunAudio={context.runAudio}
        onOpenStore={context.openModelStore}
        onAction={context.notify}
      />
    ) : page === 'video-dubbing' ? (
      <VideoDubbingView
        projectId="extension-video-dubbing"
        initialInstruction=""
        initialSourcePath=""
        initialLaunchId={0}
        dubbingMode="translate"
        onAction={context.notify}
      />
    ) : null

  return (
    <section className="extension-workbench" aria-label={t('扩展工作台')}>
      <header className="extension-workbench-header">
        <div>
          <p className="extension-workbench-eyebrow">{t('扩展工作台')}</p>
          <h1>{t('扩展工作台')}</h1>
        </div>
        <button
          className="extension-workbench-close"
          type="button"
          onClick={onClose}
        >
          <ArrowLeft size={16} />
          {t('返回工作区')}
        </button>
      </header>

      <nav
        className="extension-workbench-pages"
        aria-label={t('扩展工作台页面')}
      >
        {extensionWorkbenchPages(true).map((pageId) => (
          <button
            className={page === pageId ? 'active' : ''}
            type="button"
            key={pageId}
            aria-current={page === pageId ? 'page' : undefined}
            onClick={() => onPageChange(pageId)}
          >
            {t(extensionWorkbenchPageLabels[pageId])}
          </button>
        ))}
      </nav>

      <main className="extension-workbench-content">{content}</main>
    </section>
  )
}
