import { ArrowUpRight, FileText, FolderOpen, MessageSquareText, Sparkles } from 'lucide-react'
import type { AgentConversation } from '../domain/agents'
import { t, useLocale } from '../i18n'

export function TaskOverview({
  conversation,
  skillName,
  onOpenEditor,
  onContinuePlanning,
  returnsToConversation = false,
}: {
  conversation: AgentConversation
  skillName: string
  onOpenEditor: () => void
  onContinuePlanning: () => void
  returnsToConversation?: boolean
}) {
  useLocale()
  const fileName = conversation.sourcePath.split(/[\\/]/u).at(-1)
  return (
    <section className="task-overview" aria-labelledby="task-overview-title">
      <div className="task-overview-inner">
        <span className="task-overview-kicker"><Sparkles size={15} />{skillName}</span>
        <h1 id="task-overview-title">{t('任务概览')}</h1>
        <p className="task-overview-description">{t('在工作区查看进度、调整内容并导出结果。')}</p>
        <div className="task-overview-card">
          <h2><MessageSquareText size={15} />{t('创作要求')}</h2>
          <p>{conversation.prompt || conversation.title}</p>
        </div>
        {fileName && (
          <div className="task-overview-file" title={conversation.sourcePath}>
            <FileText size={18} />
            <div><span>{t('源文件')}</span><strong>{fileName}</strong></div>
          </div>
        )}
        <button type="button" className="task-overview-primary" onClick={onOpenEditor}>
          <FolderOpen size={16} />{t('打开编辑工作区')}<ArrowUpRight size={15} />
        </button>
        <button type="button" className="task-overview-secondary" onClick={onContinuePlanning}>
          <MessageSquareText size={15} />{returnsToConversation ? t('返回任务对话') : t('基于此任务新建对话')}
        </button>
      </div>
    </section>
  )
}
