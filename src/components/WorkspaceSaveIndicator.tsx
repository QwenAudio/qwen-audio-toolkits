import { AlertCircle, Check, LoaderCircle, RotateCcw } from 'lucide-react'
import { useWorkspaceSaveStatus } from '../hooks/useProjectAutosave'
import { flushWorkspace } from '../services/workspaceStorage'
import { t, useLocale } from '../i18n'

export function WorkspaceSaveIndicator() {
  useLocale()
  const { status, error, savedAt, canRetry } = useWorkspaceSaveStatus()
  if (status === 'disabled') return null
  if (status === 'error') {
    if (!canRetry) return <span className="workspace-save-state failed" role="alert"
      title={`${error ?? t('自动保存失败')} ${t('请备份并检查工作区文件后重启应用。')}`}>
      <AlertCircle size={13} /><span>{t('自动保存已暂停')}</span>
    </span>
    return <button type="button" className="workspace-save-state failed" title={error ?? t('自动保存失败')}
      onClick={() => { void flushWorkspace().catch(() => undefined) }}>
      <RotateCcw size={13} /><span>{t('保存失败，重试')}</span>
    </button>
  }
  const saving = status === 'saving' || status === 'loading'
  const label = saving ? t('正在保存…') : t('已保存')
  return <span className="workspace-save-state" role="status" aria-live="polite"
    title={savedAt ? t('上次保存：{0}', [new Date(savedAt).toLocaleTimeString()]) : label}>
    {saving ? <LoaderCircle size={12} className="model-spin" /> : <Check size={13} />}
    <span>{label}</span>
  </span>
}
