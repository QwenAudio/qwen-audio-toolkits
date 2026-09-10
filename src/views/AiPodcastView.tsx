import { useEffect, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  ArrowUp,
  Download,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  Plus,
  Radio,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { AudioAssetPreview } from '../components/AudioAssetPreview'
import {
  chunkPodcastSource,
  parsePodcastScript,
  PODCAST_NOTES_SYSTEM_PROMPT,
  PODCAST_SCRIPT_SYSTEM_PROMPT,
  podcastScriptPrompt,
  voiceParameters,
  type PodcastLength,
  type PodcastScript,
  type PodcastSpeaker,
} from '../domain/podcast'
import { modelInputProfile } from '../domain/modelInputs'
import { cloudVoiceOptions } from '../domain/voices'
import { exportAudioFile } from '../services/fileExport'
import {
  composePodcastAudio,
  localizePodcastError,
  readSourceDocument,
  type PodcastAudioResult,
  type SourceDocument,
} from '../services/podcast'
import { formatFileSize, formatTime } from '../utils/audio'
import { t, useLocale } from '../i18n'
import type {
  HarnessCatalog,
  HarnessExecution,
  ModelPlugin,
  TextGenerateResult,
  TtsGenerateResult,
} from '../types'
import './SmartCutView.css'
import './AiPodcastView.css'

type PodcastStage =
  | 'empty'
  | 'extracting'
  | 'ready'
  | 'summarizing'
  | 'scripting'
  | 'review'
  | 'synthesizing'
  | 'complete'

interface AiPodcastViewProps {
  models: ModelPlugin[]
  catalog: HarnessCatalog | null
  onRunText: (
    text: string,
    capability: 'speech.synthesize' | 'text.generate' | 'text.punctuate' | 'text.normalize',
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    dependencyRunIds?: string[],
    conversationVisible?: boolean,
  ) => Promise<HarnessExecution<TtsGenerateResult | TextGenerateResult | Record<string, unknown>>>
  onOpenStore: () => void
  onAction: (message: string) => void
}

function modelReady(model: ModelPlugin, catalog: HarnessCatalog | null): boolean {
  const provider = catalog?.providers.find((item) => item.id === model.providerId)
  return model.installed && Boolean(model.providerId) && (!provider || provider.status === 'ready')
}

function isTextResult(value: unknown): value is TextGenerateResult {
  return Boolean(value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string')
}

function isTtsResult(value: unknown): value is TtsGenerateResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { filePath?: unknown }).filePath === 'string' &&
      typeof (value as { duration?: unknown }).duration === 'number',
  )
}

function stageMessage(stage: PodcastStage, completed: number, total: number): string {
  if (stage === 'extracting') return t('正在读取文档…')
  if (stage === 'summarizing') return t('正在整理长文档 {0}/{1}…', [completed, total])
  if (stage === 'scripting') return t('正在生成双人播客脚本…')
  if (stage === 'synthesizing') return t('正在合成第 {0}/{1} 段台词…', [completed, total])
  return ''
}

export function AiPodcastView({
  models,
  catalog,
  onRunText,
  onOpenStore,
  onAction,
}: AiPodcastViewProps) {
  useLocale()
  const [stage, setStage] = useState<PodcastStage>('empty')
  const [source, setSource] = useState<SourceDocument | null>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [instruction, setInstruction] = useState('')
  const [length, setLength] = useState<PodcastLength>('brief')
  const [language, setLanguage] = useState<'auto' | 'zh-CN' | 'en'>('auto')
  const [selectedLlmId, setSelectedLlmId] = useState('')
  const [selectedTtsId, setSelectedTtsId] = useState('')
  const [voiceA, setVoiceA] = useState('')
  const [voiceB, setVoiceB] = useState('')
  const [speakerAName, setSpeakerAName] = useState(t('主持人'))
  const [speakerBName, setSpeakerBName] = useState(t('嘉宾'))
  const [speed, setSpeed] = useState(1)
  const [script, setScript] = useState<PodcastScript | null>(null)
  const [output, setOutput] = useState<PodcastAudioResult | null>(null)
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [error, setError] = useState('')

  const llmModels = useMemo(
    () => models.filter((model) => modelReady(model, catalog) && model.harnessCapabilities.includes('text.generate')),
    [catalog, models],
  )
  const ttsModels = useMemo(
    () =>
      models.filter((model) => {
        if (!modelReady(model, catalog) || !model.harnessCapabilities.includes('speech.synthesize')) return false
        const profile = modelInputProfile(model)
        return !profile.requiresTtsReferenceAudio && (profile.apiModel || profile.supportsSpeakerSelection)
      }),
    [catalog, models],
  )
  const selectedLlm = llmModels.find((model) => model.id === selectedLlmId)
  const selectedTts = ttsModels.find((model) => model.id === selectedTtsId)
  const ttsProfile = selectedTts ? modelInputProfile(selectedTts) : null
  const presetVoices = selectedTts ? cloudVoiceOptions(selectedTts) : []
  const busy = ['extracting', 'summarizing', 'scripting', 'synthesizing'].includes(stage)

  useEffect(() => {
    if (llmModels.some((model) => model.id === selectedLlmId)) return
    setSelectedLlmId(llmModels[0]?.id ?? '')
  }, [llmModels, selectedLlmId])

  useEffect(() => {
    if (ttsModels.some((model) => model.id === selectedTtsId)) return
    setSelectedTtsId(ttsModels[0]?.id ?? '')
  }, [selectedTtsId, ttsModels])

  useEffect(() => {
    if (!selectedTts || !ttsProfile) {
      setVoiceA('')
      setVoiceB('')
      return
    }
    if (ttsProfile.apiModel) {
      const first = selectedTts.defaultVoice ?? presetVoices[0]?.id ?? ''
      const second = presetVoices.find((voice) => voice.id !== first)?.id ?? ''
      setVoiceA(first)
      setVoiceB(second)
    } else {
      setVoiceA('0')
      setVoiceB(ttsProfile.speakerCount > 1 ? '1' : '0')
    }
  }, [selectedTts?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const chooseDocument = async () => {
    const selection = await open({
      title: t('选择论文或文档'),
      multiple: false,
      directory: false,
      filters: [{ name: t('文档'), extensions: ['pdf', 'docx', 'txt', 'md', 'markdown'] }],
    })
    const path = typeof selection === 'string' ? selection : null
    if (!path) return
    setStage('extracting')
    setError('')
    setScript(null)
    setOutput(null)
    try {
      const document = await readSourceDocument(path)
      setSource(document)
      setSourcePath(path)
      setStage('ready')
      if (document.truncated) onAction(t('文档很长，已读取前 30 万个字符'))
    } catch (reason) {
      setSource(null)
      setSourcePath('')
      setStage('empty')
      setError(localizePodcastError(reason))
    }
  }

  const reset = () => {
    setStage('empty')
    setSource(null)
    setSourcePath('')
    setInstruction('')
    setScript(null)
    setOutput(null)
    setProgress({ completed: 0, total: 0 })
    setError('')
  }

  const generateScript = async () => {
    if (!source || !sourcePath) {
      setError(t('请先上传论文或文档'))
      return
    }
    if (!selectedLlm?.providerId) {
      setError(t('请先安装并配置一个文本生成模型'))
      return
    }
    setError('')
    setOutput(null)
    const { chunks, truncated } = chunkPodcastSource(source.text)
    if (!chunks.length) {
      setError(t('文档中没有可用于生成播客的正文'))
      return
    }
    try {
      let material = chunks[0]
      if (chunks.length > 1) {
        const notes: string[] = []
        setStage('summarizing')
        setProgress({ completed: 0, total: chunks.length })
        for (let index = 0; index < chunks.length; index += 1) {
          const execution = await onRunText(
            `${t('文档片段')} ${index + 1}/${chunks.length}\n<source>\n${chunks[index]}\n</source>`,
            'text.generate',
            selectedLlm.providerId,
            selectedLlm.version,
            { systemPrompt: PODCAST_NOTES_SYSTEM_PROMPT, temperature: 0.1, maxTokens: 900 },
            [],
            false,
          )
          if (!isTextResult(execution.output)) throw new Error(t('文本生成模型没有返回有效内容'))
          notes.push(`${t('片段')} ${index + 1}\n${execution.output.text.trim()}`)
          setProgress({ completed: index + 1, total: chunks.length })
        }
        material = notes.join('\n\n')
      }
      setStage('scripting')
      const execution = await onRunText(
        podcastScriptPrompt(material, instruction, length, language),
        'text.generate',
        selectedLlm.providerId,
        selectedLlm.version,
        {
          systemPrompt: PODCAST_SCRIPT_SYSTEM_PROMPT,
          temperature: 0.55,
          maxTokens: length === 'deep' ? 6200 : length === 'standard' ? 4000 : 2600,
        },
        [],
        false,
      )
      if (!isTextResult(execution.output)) throw new Error(t('文本生成模型没有返回有效内容'))
      const next = parsePodcastScript(execution.output.text)
      setScript(next)
      setStage('review')
      setProgress({ completed: 0, total: 0 })
      if (truncated) onAction(t('来源超过长文档处理上限，脚本基于前 {0} 个片段生成', [chunks.length]))
      onAction(t('双人脚本已生成，请复核后再合成语音'))
    } catch (reason) {
      setStage('ready')
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message.includes('script needs two speakers') || message.includes('invalid')
        ? t('模型返回的脚本格式不完整，请重试或换一个文本生成模型')
        : localizePodcastError(reason))
    }
  }

  const updateTurn = (index: number, text: string) => {
    setScript((current) => current ? {
      ...current,
      turns: current.turns.map((turn, turnIndex) => turnIndex === index ? { ...turn, text } : turn),
    } : current)
  }

  const updateSpeaker = (index: number, speaker: PodcastSpeaker) => {
    setScript((current) => current ? {
      ...current,
      turns: current.turns.map((turn, turnIndex) => turnIndex === index ? { ...turn, speaker } : turn),
    } : current)
  }

  const removeTurn = (index: number) => {
    setScript((current) => current ? {
      ...current,
      turns: current.turns.filter((_, turnIndex) => turnIndex !== index),
    } : current)
  }

  const addTurn = () => {
    setScript((current) => current ? {
      ...current,
      turns: [...current.turns, {
        id: `podcast-turn-${crypto.randomUUID()}`,
        speaker: current.turns.at(-1)?.speaker === 'A' ? 'B' : 'A',
        text: '',
      }],
    } : current)
  }

  const synthesize = async () => {
    if (!script || !selectedTts?.providerId || !ttsProfile) {
      setError(t('请先选择可用的语音合成模型'))
      return
    }
    const turns = script.turns.filter((turn) => turn.text.trim())
    if (turns.length < 2 || !turns.some((turn) => turn.speaker === 'A') || !turns.some((turn) => turn.speaker === 'B')) {
      setError(t('脚本需要至少包含主持人和嘉宾各一段台词'))
      return
    }
    if (voiceA.trim() === voiceB.trim()) {
      setError(t('请为两位角色选择不同音色'))
      return
    }
    setStage('synthesizing')
    setOutput(null)
    setError('')
    setProgress({ completed: 0, total: turns.length })
    try {
      const audioSegments: Array<{ filePath: string; pauseAfterMs: number }> = []
      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index]
        const voice = turn.speaker === 'A' ? voiceA : voiceB
        const execution = await onRunText(
          turn.text.trim(),
          'speech.synthesize',
          selectedTts.providerId,
          selectedTts.version,
          {
            speed,
            ...voiceParameters(voice, ttsProfile.apiModel, turn.speaker === 'A' ? 0 : 1),
            ...(ttsProfile.supportsTtsLanguage
              ? { language: script.language.toLowerCase().startsWith('zh') ? 'zh' : 'en' }
              : {}),
          },
          [],
          false,
        )
        if (!isTtsResult(execution.output)) throw new Error(t('语音合成模型没有返回有效音频'))
        audioSegments.push({
          filePath: execution.output.filePath,
          pauseAfterMs: index + 1 < turns.length && turns[index + 1].speaker !== turn.speaker ? 320 : 220,
        })
        setProgress({ completed: index + 1, total: turns.length })
      }
      const mixed = await composePodcastAudio(audioSegments, script.title)
      setOutput(mixed)
      setStage('complete')
      onAction(t('播客音频已生成'))
    } catch (reason) {
      setStage('review')
      setError(localizePodcastError(reason))
    }
  }

  const exportPodcast = async () => {
    if (!output) return
    try {
      const destination = await exportAudioFile(output)
      if (destination) onAction(t('播客已导出到 {0}', [destination]))
    } catch (reason) {
      setError(localizePodcastError(reason))
    }
  }

  const renderVoiceField = (
    label: string,
    value: string,
    setValue: (value: string) => void,
  ) => (
    <label className="podcast-field podcast-voice-field">
      <span>{label}</span>
      <input
        type={ttsProfile?.apiModel ? 'text' : 'number'}
        min={ttsProfile?.apiModel ? undefined : 0}
        max={ttsProfile?.apiModel ? undefined : Math.max(0, (ttsProfile?.speakerCount ?? 1) - 1)}
        list={ttsProfile?.apiModel && presetVoices.length ? `podcast-${label}-voices` : undefined}
        value={value}
        placeholder={ttsProfile?.apiModel ? t('输入音色 ID') : t('音色 ID')}
        onChange={(event) => setValue(event.target.value)}
      />
      {ttsProfile?.apiModel && presetVoices.length > 0 && (
        <datalist id={`podcast-${label}-voices`}>
          {presetVoices.map((voice) => <option value={voice.id} key={voice.id}>{voice.name}</option>)}
        </datalist>
      )}
    </label>
  )

  if (!script) {
    const promptSuggestions = [
      '主持人与专家访谈，讲清核心结论和研究局限',
      '面向大众，用轻松中文解释文档重点',
      '保留专业细节，讨论争议与启示',
    ]
    return (
      <main className="smart-cut-view ai-podcast-view empty">
        <section className="smart-cut-hero podcast-hero">
          <div className="smart-cut-hero-icon podcast-hero-icon"><Radio size={27} strokeWidth={1.55} /></div>
          <span className="smart-cut-kicker podcast-kicker">AI PODCAST</span>
          <h1>{t('把一篇文档变成双人播客')}</h1>
          <p>{t('上传论文或文档，先生成可以复核的主持人与嘉宾对话，再用两种音色合成为完整音频。')}</p>
        </section>
        <section className="smart-cut-composer podcast-composer">
          {source && (
            <div className="smart-cut-video-attachment podcast-document-chip">
              <FileText size={18} />
              <span>
                <strong>{source.fileName}</strong>
                <small>{t('{0} 个字符', [source.characterCount.toLocaleString()])}</small>
              </span>
              <button type="button" aria-label={t('移除文档')} onClick={() => { setSource(null); setSourcePath(''); setStage('empty') }}>
                <X size={14} />
              </button>
            </div>
          )}
          <textarea
            value={instruction}
            rows={4}
            disabled={busy}
            placeholder={t('告诉 Agent 你希望的语言、受众、风格和重点，例如：用中文给非专业听众解释核心发现，也讲清研究局限。')}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <div className="smart-cut-composer-toolbar podcast-composer-options">
            <button className="smart-cut-attach-button podcast-attach" type="button" disabled={busy} onClick={() => void chooseDocument()}>
              <Paperclip size={15} /> <span>{source ? t('替换文档') : t('上传文档')}</span>
            </button>
            <label className="smart-cut-planner-model">
              <Sparkles size={13} />
              <select value={selectedLlmId} disabled={busy} onChange={(event) => setSelectedLlmId(event.target.value)}>
                {!llmModels.length && <option value="">{t('无可用 LLM')}</option>}
                {llmModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
              </select>
            </label>
            <label>
              <select value={length} disabled={busy} onChange={(event) => setLength(event.target.value as PodcastLength)}>
                <option value="brief">{t('约 3 分钟')}</option>
                <option value="standard">{t('约 6 分钟')}</option>
                <option value="deep">{t('约 10 分钟')}</option>
              </select>
            </label>
            <label>
              <select value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as 'auto' | 'zh-CN' | 'en')}>
                <option value="auto">{t('自动语言')}</option>
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <button
              className="smart-cut-send podcast-send"
              type="button"
              disabled={busy || !source || !selectedLlm}
              aria-label={t('生成播客脚本')}
              onClick={() => void generateScript()}
            >
              {busy ? <LoaderCircle className="podcast-spin" size={16} /> : <ArrowUp size={17} />}
            </button>
          </div>
        </section>
        <div className="smart-cut-prompt-suggestions" aria-label={t('示例指令')}>
          {promptSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={busy}
              onClick={() => setInstruction(suggestion)}
            >
              {t(suggestion)}
            </button>
          ))}
        </div>
        <section className="smart-cut-entry-status podcast-entry-status">
          {busy && <p className="podcast-status">{stageMessage(stage, progress.completed, progress.total)}</p>}
          {!llmModels.length && (
            <button className="podcast-store-link" type="button" onClick={onOpenStore}>{t('前往模型商店安装或配置 LLM')}</button>
          )}
          {error && <p className="podcast-error">{error}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className={`ai-podcast-view project${output ? ' has-output' : ''}`}>
      <header className="podcast-project-header">
        <div>
          <span className="podcast-kicker">AI PODCAST</span>
          <input
            className="podcast-title-input"
            value={script.title}
            disabled={busy}
            aria-label={t('播客标题')}
            onChange={(event) => setScript({ ...script, title: event.target.value })}
          />
          <p>{source?.fileName} · {t('{0} 段对话', [script.turns.length])}</p>
        </div>
        <button className="podcast-reset" type="button" disabled={busy} onClick={reset}><RotateCcw size={14} />{t('新建播客')}</button>
      </header>

      <section className="podcast-workspace">
        <aside className="podcast-settings-card">
          <div className="podcast-section-heading">
            <MessageSquareText size={16} />
            <div><strong>{t('角色与声音')}</strong><small>{t('两位角色使用同一模型的不同音色')}</small></div>
          </div>
          <label className="podcast-field">
            <span>{t('语音合成模型')}</span>
            <select value={selectedTtsId} disabled={busy} onChange={(event) => setSelectedTtsId(event.target.value)}>
              {!ttsModels.length && <option value="">{t('无可用双音色 TTS')}</option>}
              {ttsModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
            </select>
          </label>
          <div className="podcast-speaker-setting">
            <label className="podcast-field"><span>{t('角色 A')}</span><input value={speakerAName} disabled={busy} onChange={(event) => setSpeakerAName(event.target.value)} /></label>
            {renderVoiceField(t('声音 A'), voiceA, setVoiceA)}
          </div>
          <div className="podcast-speaker-setting">
            <label className="podcast-field"><span>{t('角色 B')}</span><input value={speakerBName} disabled={busy} onChange={(event) => setSpeakerBName(event.target.value)} /></label>
            {renderVoiceField(t('声音 B'), voiceB, setVoiceB)}
          </div>
          <label className="podcast-field">
            <span>{t('语速')} · {speed.toFixed(2)}×</span>
            <input type="range" min="0.75" max="1.35" step="0.05" value={speed} disabled={busy} onChange={(event) => setSpeed(Number(event.target.value))} />
          </label>
          {!ttsModels.length && <button className="podcast-store-link full" type="button" onClick={onOpenStore}>{t('前往模型商店安装或配置 TTS')}</button>}
          <button className="podcast-primary-action" type="button" disabled={busy || !selectedTts} onClick={() => void synthesize()}>
            {stage === 'synthesizing' ? <LoaderCircle className="podcast-spin" size={16} /> : <Radio size={16} />}
            {stage === 'synthesizing' ? stageMessage(stage, progress.completed, progress.total) : output ? t('重新合成') : t('生成播客音频')}
          </button>
          {error && <p className="podcast-error compact">{error}</p>}
        </aside>

        <section className="podcast-script-card">
          <div className="podcast-script-heading">
            <div><strong>{t('双人脚本')}</strong><small>{t('合成前可以修改台词、角色和顺序')}</small></div>
            <button type="button" disabled={busy} onClick={addTurn}><Plus size={14} />{t('添加一段')}</button>
          </div>
          <div className="podcast-turn-list">
            {script.turns.map((turn, index) => (
              <article className={`podcast-turn speaker-${turn.speaker.toLowerCase()}`} key={turn.id}>
                <header className="podcast-turn-header">
                  <div className="podcast-speaker-identity">
                    <span className="podcast-speaker-mark">{turn.speaker}</span>
                    <select value={turn.speaker} disabled={busy} aria-label={t('说话人')} onChange={(event) => updateSpeaker(index, event.target.value as PodcastSpeaker)}>
                      <option value="A">{speakerAName || t('主持人')}</option>
                      <option value="B">{speakerBName || t('嘉宾')}</option>
                    </select>
                  </div>
                  <span className="podcast-turn-number">#{String(index + 1).padStart(2, '0')}</span>
                  <button type="button" disabled={busy} aria-label={t('删除这段台词')} onClick={() => removeTurn(index)}><Trash2 size={13} /></button>
                </header>
                <textarea
                  value={turn.text}
                  rows={Math.min(6, Math.max(2, Math.ceil(turn.text.length / 52)))}
                  disabled={busy}
                  onChange={(event) => updateTurn(index, event.target.value)}
                />
              </article>
            ))}
          </div>
        </section>
      </section>

      {output && (
        <section className="podcast-player-bar" aria-label={t('播客音频')}>
          <div className="podcast-player-summary">
            <span><Radio size={18} /></span>
            <div>
              <strong>{t('播客音频')}</strong>
              <small>{script.title}</small>
            </div>
          </div>
          <AudioAssetPreview
            src={convertFileSrc(output.filePath)}
            peaks={output.waveform}
            duration={output.duration}
            sampleRate={output.sampleRate}
            role="output"
            size="compact"
            waveformHeight={54}
          />
          <div className="podcast-player-actions">
            <div className="podcast-output-meta">
              <span>{formatTime(output.duration, true)}</span>
              <span>{output.sampleRate / 1000} kHz</span>
              <span>{formatFileSize(output.sizeBytes)}</span>
            </div>
            <button className="podcast-export" type="button" onClick={() => void exportPodcast()}><Download size={14} />{t('导出 WAV')}</button>
          </div>
        </section>
      )}
    </main>
  )
}
