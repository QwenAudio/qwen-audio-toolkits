import {
  Activity,
  AudioLines,
  AudioWaveform,
  BrainCircuit,
  Captions,
  Fingerprint,
  Languages,
  ListFilter,
  Pilcrow,
  ScanSearch,
  Sparkles,
  Split,
  Tags,
  Users,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react'
import type { HarnessCapabilityId } from '../types'

const CAPABILITY_ICONS: Record<HarnessCapabilityId, LucideIcon> = {
  'audio.enhance': WandSparkles,
  'audio.live': AudioWaveform,
  'audio.classify': Tags,
  'audio.separate': Split,
  'speech.detect': Activity,
  'speech.transcribe': Captions,
  'speech.keyword': ScanSearch,
  'speech.language': Languages,
  'speaker.embed': Fingerprint,
  'speaker.diarize': Users,
  'text.punctuate': Pilcrow,
  'text.normalize': ListFilter,
  'text.generate': BrainCircuit,
  'speech.synthesize': AudioLines,
}

interface ModelCapabilityIconProps {
  capability: HarnessCapabilityId
  size?: number
}

export function ModelCapabilityIcon({
  capability,
  size = 17,
}: ModelCapabilityIconProps) {
  const Icon = CAPABILITY_ICONS[capability] ?? Sparkles
  return <Icon size={size} strokeWidth={1.8} />
}
