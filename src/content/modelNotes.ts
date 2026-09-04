const notes = import.meta.glob('./model-notes/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const byPluginId = new Map<string, string>()
for (const [path, markdown] of Object.entries(notes)) {
  const id = path.slice(path.lastIndexOf('/') + 1, -'.md'.length)
  if (id === 'README') continue
  byPluginId.set(id, markdown.trim())
}

export function getModelNote(pluginId: string): string | undefined {
  return byPluginId.get(pluginId)
}
