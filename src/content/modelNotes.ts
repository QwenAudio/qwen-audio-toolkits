import { getLocale } from '../i18n'

const notes = import.meta.glob('./model-notes/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const englishNotes = import.meta.glob('./model-notes/en/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function indexNotes(sources: Record<string, string>): Map<string, string> {
  const byPluginId = new Map<string, string>()
  for (const [path, markdown] of Object.entries(sources)) {
    const id = path.slice(path.lastIndexOf('/') + 1, -'.md'.length)
    if (id !== 'README') byPluginId.set(id, markdown.trim())
  }
  return byPluginId
}
const chinese = indexNotes(notes)
const english = indexNotes(englishNotes)

export function getModelNote(pluginId: string): string | undefined {
  return (getLocale() === 'en' ? english.get(pluginId) : undefined)
    ?? chinese.get(pluginId)
}
