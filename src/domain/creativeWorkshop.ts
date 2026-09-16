import type { AgentCreationMode, VideoDubbingMode, VideoDubbingStyle } from './agents'

export type WorkshopMode = Exclude<AgentCreationMode, 'agent-chat'>
export type WorkshopCategory = 'video' | 'audio'
export type WorkshopTemplateId = 'smart-cut' | 'captions' | 'video-dubbing' | 'ai-podcast' | 'meeting-notes'

export type WorkshopTemplate = {
  id: WorkshopTemplateId
  mode: WorkshopMode
  category: WorkshopCategory
  title: string
  description: string
  eyebrow: string
  inputLabel: string
  inputHint: string
  acceptsFile: boolean
  extensions: string[]
}

export const WORKSHOP_TEMPLATES: WorkshopTemplate[] = [
  {
    id: 'smart-cut', mode: 'smart-cut', category: 'video', title: '智能剪辑',
    description: '清理静音、口水词和重复表达，保留可复核的剪辑建议。',
    eyebrow: 'TALKING-HEAD EDITOR', inputLabel: '选择口播视频', inputHint: '支持 MP4、MOV、M4V、WebM、MKV',
    acceptsFile: true, extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'],
  },
  {
    id: 'captions', mode: 'smart-cut', category: 'video', title: '字幕成片',
    description: '识别视频对白，生成可编辑字幕并导出内嵌字幕视频。',
    eyebrow: 'CAPTION STUDIO', inputLabel: '选择视频素材', inputHint: '支持 MP4、MOV、M4V、WebM、MKV',
    acceptsFile: true, extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'],
  },
  {
    id: 'video-dubbing', mode: 'video-dubbing', category: 'video', title: '视频配音',
    description: '翻译、改写或替换对白，输出节奏对齐的视频、音轨与字幕。',
    eyebrow: 'DUBBING DIRECTOR', inputLabel: '选择要配音的视频', inputHint: '支持 MP4、MOV、M4V、WebM、MKV',
    acceptsFile: true, extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'],
  },
  {
    id: 'ai-podcast', mode: 'ai-podcast', category: 'audio', title: 'AI 播客',
    description: '把文档变成可编辑的对话脚本，并合成为完整播客音频。',
    eyebrow: 'PODCAST STUDIO', inputLabel: '选择论文或文档', inputHint: '支持 PDF、DOCX、TXT、Markdown',
    acceptsFile: true, extensions: ['pdf', 'docx', 'txt', 'md', 'markdown'],
  },
  {
    id: 'meeting-notes', mode: 'meeting-notes', category: 'audio', title: '会议纪要',
    description: '采集会议声音，滚动转写并沉淀结论、风险和行动项。',
    eyebrow: 'MEETING CAPTURE', inputLabel: '会议主题', inputHint: '进入后选择麦克风或系统音频来源',
    acceptsFile: false, extensions: [],
  },
]

export function buildWorkshopInstruction(
  template: WorkshopTemplate,
  options: {
    removeSilence: boolean
    removeFillers: boolean
    captions: boolean
    dubbingMode: VideoDubbingMode
    targetLanguage: string
    dubbingStyle: VideoDubbingStyle
    podcastLength: string
    podcastFormat: string
    meetingFocus: string
    detail: string
  },
) {
  const detail = options.detail.trim()
  if (template.id === 'smart-cut') {
    const goals = [
      options.removeSilence && '删除长静音',
      options.removeFillers && '删除口水词',
      options.captions && '生成内嵌字幕',
    ].filter(Boolean).join('、') || '生成可复核的剪辑建议'
    return `${goals}，保留自然的口播节奏。${detail ? ` 补充要求：${detail}` : ''}`
  }
  if (template.id === 'captions') {
    return `识别完整对白并生成可编辑的中文内嵌字幕，不主动删除画面或口播内容。${detail ? ` 补充要求：${detail}` : ''}`
  }
  if (template.id === 'video-dubbing') {
    const action = options.dubbingMode === 'translate' ? `翻译为${options.targetLanguage}配音` : options.dubbingMode === 'rewrite' ? '在保留原意的前提下改写配音文案' : '使用新的配音文案'
    const style = options.dubbingStyle === 'formal' ? '正式专业' : options.dubbingStyle === 'casual' ? '轻松自然' : '自然口语'
    return `${action}，使用${style}的表达，保留原视频的节奏与说话人区分。${detail ? ` 补充要求：${detail}` : ''}`
  }
  if (template.id === 'ai-podcast') {
    return `将文档制作成约${options.podcastLength}的${options.podcastFormat}播客，先生成可审阅的中文双人对话脚本，再合成音频。${detail ? ` 补充要求：${detail}` : ''}`
  }
  return `记录本次会议，重点关注${options.meetingFocus}，生成结构化转写、结论和行动项。${detail ? ` 补充要求：${detail}` : ''}`
}
