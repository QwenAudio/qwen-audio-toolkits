import { useCallback, useMemo, useState } from 'react'
import type { AgentConversation } from '../domain/agents'

export function useAgentConversations() {
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  )
  const createConversation = useCallback((draft: Omit<AgentConversation, 'id'>) => {
    const conversation = { ...draft, id: crypto.randomUUID() }
    setConversations((current) => [conversation, ...current])
    setSelectedId(conversation.id)
    return conversation
  }, [])
  const startNewConversation = useCallback(() => setSelectedId(null), [])

  return {
    conversations,
    selectedId,
    selectedConversation,
    createConversation,
    selectConversation: setSelectedId,
    startNewConversation,
  }
}
