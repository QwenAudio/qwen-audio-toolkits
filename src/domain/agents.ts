export type AgentCreationMode =
  | 'ai-podcast'
  | 'video-dubbing'
  | 'meeting-notes'

export type VideoDubbingMode = 'translate' | 'rewrite' | 'script'
export type VideoDubbingStyle = 'natural' | 'formal' | 'casual'

export interface VideoDubbingLanguages {
  source: string
  target: string
}
