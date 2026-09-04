import { cancelHarnessRun, isTerminalRun } from './harness'
import type { HarnessRun } from '../types'

type RealtimeSessionEvent =
  | { type: 'turn.started'; generation: number }
  | {
      type: 'response.canceled'
      generation: number
      reason: 'new-turn' | 'user' | 'dispose'
    }

type RealtimeSessionListener = (event: RealtimeSessionEvent) => void

export class RealtimeSessionController {
  private generation = 0
  private readonly runs = new Map<string, number>()
  private readonly audioSources = new Map<AudioBufferSourceNode, number>()
  private readonly listeners = new Set<RealtimeSessionListener>()

  currentGeneration(): number {
    return this.generation
  }

  beginTurn(): number {
    this.cancelResources('new-turn')
    this.generation += 1
    this.emit({ type: 'turn.started', generation: this.generation })
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  trackRun(run: HarnessRun, generation: number): void {
    if (!this.isCurrent(generation)) {
      if (!isTerminalRun(run)) void cancelHarnessRun(run.id).catch(() => undefined)
      return
    }
    if (isTerminalRun(run)) this.runs.delete(run.id)
    else this.runs.set(run.id, generation)
  }

  trackAudioSource(source: AudioBufferSourceNode, generation: number): boolean {
    if (!this.isCurrent(generation)) {
      try {
        source.stop()
      } catch {
        // The source may not have been started yet.
      }
      return false
    }
    this.audioSources.set(source, generation)
    source.addEventListener(
      'ended',
      () => {
        this.audioSources.delete(source)
      },
      { once: true },
    )
    return true
  }

  cancel(reason: 'user' | 'dispose' = 'user'): void {
    this.cancelResources(reason)
    this.generation += 1
  }

  subscribe(listener: RealtimeSessionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private cancelResources(
    reason: 'new-turn' | 'user' | 'dispose',
  ): void {
    const canceledGeneration = this.generation
    for (const [source, generation] of this.audioSources) {
      if (generation !== canceledGeneration) continue
      try {
        source.stop()
      } catch {
        // Already stopped sources are harmless.
      }
      this.audioSources.delete(source)
    }
    for (const [runId, generation] of this.runs) {
      if (generation !== canceledGeneration) continue
      void cancelHarnessRun(runId).catch(() => undefined)
      this.runs.delete(runId)
    }
    if (canceledGeneration > 0) {
      this.emit({
        type: 'response.canceled',
        generation: canceledGeneration,
        reason,
      })
    }
  }

  private emit(event: RealtimeSessionEvent): void {
    this.listeners.forEach((listener) => listener(event))
  }
}
