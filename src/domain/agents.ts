export type AgentCreationMode = 'smart-cut' | 'ai-podcast' | 'video-dubbing' | 'meeting-notes'
export type VideoDubbingMode = 'translate' | 'rewrite' | 'script'

export interface AgentConversation {
  id: string
  mode: AgentCreationMode
  title: string
  prompt: string
  sourcePath: string
  videoDubbingMode?: VideoDubbingMode
}
