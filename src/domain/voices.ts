import type { ModelPlugin } from '../types'

export interface VoiceOption {
  id: string
  name: string
  description: string
  custom?: boolean
}

const COSYVOICE_V2_VOICES: VoiceOption[] = [
  { id: 'longxiaochun_v2', name: '龙小淳', description: '知性积极女声 · 中英双语' },
  { id: 'longxiaocheng_v2', name: '龙小诚', description: '磁性低音男声 · 中英双语' },
  { id: 'longxiaoxia_v2', name: '龙小夏', description: '沉稳权威女声 · 中英双语' },
  { id: 'longyumi_v2', name: 'YUMI', description: '活力青年女声 · 中英双语' },
  { id: 'longyue_v2', name: '龙悦', description: '温暖磁性女声 · 中英双语' },
  { id: 'longmiao_v2', name: '龙妙', description: '抑扬顿挫女声 · 中英双语' },
  { id: 'longxiu_v2', name: '龙修', description: '博才说书男声 · 中英双语' },
  { id: 'longhua_v2', name: '龙华', description: '元气甜美女声 · 中英双语' },
]

const COSYVOICE_V3_PLUS_VOICES: VoiceOption[] = [
  { id: 'longanyang', name: '龙安扬', description: '阳光青年男声 · 中英双语' },
]

const QWEN_AUDIO_FLASH_VOICES: VoiceOption[] = [
  { id: 'longanhuan_v3.6', name: '龙安欢', description: '精品中文女声 · 中英双语' },
  { id: 'longjielidou_v3.6', name: '龙杰力豆', description: '天真男童 · 中英双语' },
  { id: 'loongeva_v3.6', name: 'Eva', description: '高智感美式女声 · 英语' },
  { id: 'loongjohn', name: 'John', description: '沉稳亲切美式男声 · 英语' },
]

const QWEN_AUDIO_PLUS_VOICES: VoiceOption[] = [
  { id: 'longanlingxin', name: '龙安聆心', description: '温暖共情女声 · 中英双语' },
  { id: 'longanlufeng', name: '龙安鹿枫', description: '明亮开朗男声 · 中英双语' },
]

const NO_PRESET_VOICES: VoiceOption[] = []

export function cloudVoiceOptions(plugin: ModelPlugin): VoiceOption[] {
  if (plugin.version === 'cosyvoice-v2') return COSYVOICE_V2_VOICES
  if (plugin.version === 'cosyvoice-v3-plus') return COSYVOICE_V3_PLUS_VOICES
  if (plugin.version === 'qwen-audio-3.0-tts-flash') return QWEN_AUDIO_FLASH_VOICES
  if (plugin.version === 'qwen-audio-3.0-tts-plus') return QWEN_AUDIO_PLUS_VOICES
  return NO_PRESET_VOICES
}
