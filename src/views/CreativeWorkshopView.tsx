import { open } from '@tauri-apps/plugin-dialog'
import { useMemo, useState } from 'react'
import {
  AudioLines,
  Captions,
  Check,
  ChevronRight,
  FileText,
  FileVideo,
  Languages,
  Mic2,
  Radio,
  Scissors,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import { t, useLocale } from '../i18n'
import { isTauriRuntime } from '../services/harness'
import type { VideoDubbingLanguages, VideoDubbingMode, VideoDubbingStyle } from '../domain/agents'
import { WORKSHOP_TEMPLATES, buildWorkshopInstruction, type WorkshopCategory, type WorkshopMode, type WorkshopTemplate, type WorkshopTemplateId } from '../domain/creativeWorkshop'
import type { ModelPlugin } from '../types'
import './CreativeWorkshopView.css'

const TOOL_ICONS = { 'smart-cut': Scissors, captions: Captions, 'video-dubbing': Languages, 'ai-podcast': Radio, 'meeting-notes': Mic2 } as const

const CATEGORY_META = {
  video: { label: '视频创作', description: '从素材到可发布的视频', Icon: FileVideo },
  audio: { label: '音频创作', description: '从内容到可聆听的声音', Icon: AudioLines },
} as const

function basename(path: string) {
  return path.split(/[\\/]/u).at(-1) ?? path
}

export interface CreativeWorkshopViewProps {
  appAgents: ModelPlugin[]
  onLaunch: (config: {
    mode: WorkshopMode
    prompt: string
    sourcePath: string
    videoDubbingMode?: VideoDubbingMode
    videoDubbingLanguages?: VideoDubbingLanguages
    videoDubbingStyle?: VideoDubbingStyle
  }) => void
  onOpenSkills: () => void
}

export function CreativeWorkshopView({ appAgents, onLaunch, onOpenSkills }: CreativeWorkshopViewProps) {
  useLocale()
  const [category, setCategory] = useState<'all' | WorkshopCategory>('all')
  const [selectedId, setSelectedId] = useState<WorkshopTemplateId | null>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [detail, setDetail] = useState('')
  const [removeSilence, setRemoveSilence] = useState(true)
  const [removeFillers, setRemoveFillers] = useState(true)
  const [captions, setCaptions] = useState(true)
  const [dubbingMode, setDubbingMode] = useState<VideoDubbingMode>('translate')
  const [targetLanguage, setTargetLanguage] = useState('中文')
  const [dubbingStyle, setDubbingStyle] = useState<VideoDubbingStyle>('natural')
  const [podcastLength, setPodcastLength] = useState('5 分钟')
  const [podcastFormat, setPodcastFormat] = useState('双人解读')
  const [meetingFocus, setMeetingFocus] = useState('决策、行动项和负责人')

  const selected = useMemo(() => WORKSHOP_TEMPLATES.find(template => template.id === selectedId) ?? null, [selectedId])
  const SelectedIcon = selected ? TOOL_ICONS[selected.id] : Scissors
  const visibleTemplates = category === 'all' ? WORKSHOP_TEMPLATES : WORKSHOP_TEMPLATES.filter(template => template.category === category)
  const installed = selected ? appAgents.some(agent => agent.workspaceEntry === selected.mode && agent.installed) : false

  const openLauncher = (template: WorkshopTemplate) => {
    setSelectedId(template.id)
    setSourcePath('')
    setDetail('')
  }
  const closeLauncher = () => setSelectedId(null)
  const selectSource = async () => {
    if (!selected?.acceptsFile) return
    if (!isTauriRuntime()) return
    const choice = await open({
      title: t(selected.inputLabel), multiple: false, directory: false,
      filters: [{ name: t(selected.category === 'video' ? '视频文件' : '文档'), extensions: selected.extensions }],
    })
    if (typeof choice === 'string') setSourcePath(choice)
  }
  const startWorkflow = () => {
    if (!selected) return
    const prompt = buildWorkshopInstruction(selected, { removeSilence, removeFillers, captions, dubbingMode, targetLanguage, dubbingStyle, podcastLength, podcastFormat, meetingFocus, detail })
    onLaunch({
      mode: selected.mode,
      prompt,
      sourcePath,
      ...(selected.id === 'video-dubbing' ? {
        videoDubbingMode: dubbingMode,
        videoDubbingLanguages: { source: 'auto', target: targetLanguage === '英文' ? 'en' : targetLanguage === '日语' ? 'ja' : 'zh' },
        videoDubbingStyle: dubbingStyle,
      } : {}),
    })
    closeLauncher()
  }

  return (
    <main className="creative-workshop" aria-labelledby="creative-workshop-title">
      <header className="creative-workshop-header">
        <div>
          <span className="creative-workshop-kicker"><Sparkles size={14} /> {t('CREATIVE WORKSHOP')}</span>
          <h1 id="creative-workshop-title">{t('创意工坊')}</h1>
          <p>{t('选择一个固定流程，导入素材后直接开始创作。')}</p>
        </div>
        <div className="creative-workshop-assurance"><Check size={15} /> {t('无需 Agent 对话即可使用')}</div>
      </header>

      <div className="creative-workshop-tabs" role="tablist" aria-label={t('创作类别')}>
        <button type="button" className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')} role="tab" aria-selected={category === 'all'}>{t('全部工具')}</button>
        {(Object.keys(CATEGORY_META) as WorkshopCategory[]).map((id) => {
          const meta = CATEGORY_META[id]
          return <button key={id} type="button" className={category === id ? 'active' : ''} onClick={() => setCategory(id)} role="tab" aria-selected={category === id}><meta.Icon size={15} /> {t(meta.label)}</button>
        })}
      </div>

      {(Object.keys(CATEGORY_META) as WorkshopCategory[]).map((id) => {
        const templates = visibleTemplates.filter(template => template.category === id)
        if (!templates.length) return null
        const meta = CATEGORY_META[id]
        return (
          <section className="creative-workshop-section" key={id} aria-labelledby={`workshop-${id}`}>
            <div className="creative-workshop-section-heading">
              <div className={`creative-workshop-category-icon ${id}`}><meta.Icon size={19} /></div>
              <div><h2 id={`workshop-${id}`}>{t(meta.label)}</h2><p>{t(meta.description)}</p></div>
            </div>
            <div className="creative-workshop-grid">
              {templates.map((template) => {
                const TemplateIcon = TOOL_ICONS[template.id]
                const toolInstalled = appAgents.some(agent => agent.workspaceEntry === template.mode && agent.installed)
                return (
                  <article className={`creative-tool-card ${template.id}`} key={template.id}>
                    <div className="creative-tool-card-top"><span className="creative-tool-icon"><TemplateIcon size={20} /></span><span className="creative-tool-eyebrow">{template.eyebrow}</span></div>
                    <h3>{t(template.title)}</h3><p>{t(template.description)}</p>
                    <div className="creative-tool-card-footer">
                      <span className={toolInstalled ? 'creative-tool-ready' : 'creative-tool-install'}>{toolInstalled ? <><Check size={14} /> {t('已就绪')}</> : <><Settings2 size={14} /> {t('需要安装')}</>}</span>
                      <button type="button" onClick={() => toolInstalled ? openLauncher(template) : onOpenSkills()}>{toolInstalled ? t('开始创作') : t('查看技能')}<ChevronRight size={16} /></button>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        )
      })}

      {selected && (
        <div className="creative-launcher-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLauncher() }}>
          <section className="creative-launcher" role="dialog" aria-modal="true" aria-labelledby="creative-launcher-title">
            <header>
              <div className="creative-launcher-heading"><span className="creative-tool-icon"><SelectedIcon size={20} /></span><div><span>{selected.eyebrow}</span><h2 id="creative-launcher-title">{t(selected.title)}</h2></div></div>
              <button className="creative-launcher-close" type="button" onClick={closeLauncher} aria-label={t('关闭')} title={t('关闭')}><X size={18} /></button>
            </header>
            <div className="creative-launcher-body">
              {selected.acceptsFile ? <div className="creative-launcher-field">
                <div className="creative-launcher-label"><label>{t(selected.inputLabel)}</label><small>{t(selected.inputHint)}</small></div>
                <button className={`creative-source-picker${sourcePath ? ' selected' : ''}`} type="button" onClick={() => void selectSource()}>
                  {selected.category === 'video' ? <FileVideo size={21} /> : <FileText size={21} />}
                  <span>{sourcePath ? basename(sourcePath) : t('选择素材')}</span><ChevronRight size={17} />
                </button>
                {!isTauriRuntime() && <small className="creative-source-unavailable">{t('素材选择仅在桌面端可用')}</small>}
              </div> : <div className="creative-launcher-field">
                <div className="creative-launcher-label"><label>{t('会议主题')}</label><small>{t(selected.inputHint)}</small></div>
                <input value={detail} onChange={event => setDetail(event.target.value)} placeholder={t('例如：产品周会')} />
              </div>}

              {selected.id === 'smart-cut' && <div className="creative-launcher-field"><div className="creative-launcher-label"><label>{t('剪辑目标')}</label><small>{t('可在编辑器中继续调整')}</small></div><div className="creative-toggle-list">
                <label><input type="checkbox" checked={removeSilence} onChange={event => setRemoveSilence(event.target.checked)} /><span>{t('删除长静音')}</span></label>
                <label><input type="checkbox" checked={removeFillers} onChange={event => setRemoveFillers(event.target.checked)} /><span>{t('删除口水词')}</span></label>
                <label><input type="checkbox" checked={captions} onChange={event => setCaptions(event.target.checked)} /><span>{t('生成内嵌字幕')}</span></label>
              </div></div>}

              {selected.id === 'video-dubbing' && <><div className="creative-launcher-field"><div className="creative-launcher-label"><label>{t('配音方式')}</label></div><div className="creative-choice-row">
                {([['translate', '翻译原声'], ['rewrite', '改写原稿'], ['script', '使用新文案']] as const).map(([value, label]) => <button key={value} type="button" className={dubbingMode === value ? 'selected' : ''} onClick={() => setDubbingMode(value)}>{t(label)}</button>)}
              </div></div><div className="creative-launcher-two-column"><label>{t('目标语言')}<select value={targetLanguage} onChange={event => setTargetLanguage(event.target.value)}><option>{t('中文')}</option><option>{t('英文')}</option><option>{t('日语')}</option></select></label><label>{t('表达风格')}<select value={dubbingStyle} onChange={event => setDubbingStyle(event.target.value as VideoDubbingStyle)}><option value="natural">{t('自然口语')}</option><option value="formal">{t('正式专业')}</option><option value="casual">{t('轻松自然')}</option></select></label></div></>}

              {selected.id === 'ai-podcast' && <div className="creative-launcher-two-column"><label>{t('节目长度')}<select value={podcastLength} onChange={event => setPodcastLength(event.target.value)}><option>{t('3 分钟')}</option><option>{t('5 分钟')}</option><option>{t('10 分钟')}</option></select></label><label>{t('节目形式')}<select value={podcastFormat} onChange={event => setPodcastFormat(event.target.value)}><option>{t('双人解读')}</option><option>{t('主持人访谈')}</option><option>{t('知识速览')}</option></select></label></div>}

              {selected.id === 'meeting-notes' && <div className="creative-launcher-field"><div className="creative-launcher-label"><label>{t('纪要重点')}</label></div><select value={meetingFocus} onChange={event => setMeetingFocus(event.target.value)}><option>{t('决策、行动项和负责人')}</option><option>{t('项目进展与风险')}</option><option>{t('客户需求与后续跟进')}</option></select></div>}

              {selected.id !== 'meeting-notes' && <div className="creative-launcher-field"><div className="creative-launcher-label"><label>{t('补充要求')}</label><small>{t('可选')}</small></div><textarea value={detail} onChange={event => setDetail(event.target.value)} placeholder={t('例如：保留开场，字幕使用简洁样式')} rows={2} /></div>}
              <p className="creative-launcher-note"><Sparkles size={15} /> {t('流程会先检查所需模型；需要文本生成时再提示配置。')}</p>
            </div>
            <footer><button className="secondary-action" type="button" onClick={closeLauncher}>{t('取消')}</button><button className="primary-action" type="button" disabled={!installed || (selected.acceptsFile && !sourcePath)} onClick={startWorkflow}>{selected.id === 'meeting-notes' ? <Mic2 size={16} /> : <Check size={16} />}{selected.id === 'meeting-notes' ? t('开始会议记录') : t('开始创作')}</button></footer>
          </section>
        </div>
      )}
    </main>
  )
}
