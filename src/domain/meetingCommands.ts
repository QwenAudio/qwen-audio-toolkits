import type { MeetingTurn } from './editorSnapshots'
import { t } from '../i18n'

export function meetingDetailView(value: unknown): 'transcript' | 'summary' {
  if (value !== 'transcript' && value !== 'summary') throw new Error(t('请选择实时转写或会议总结。'))
  return value
}

export function assignMeetingSpeaker(
  turns: MeetingTurn[], turnId: unknown, speaker: unknown, maximumSpeaker: number,
): MeetingTurn[] {
  if (typeof turnId !== 'string' || !turns.some(turn => turn.id === turnId)) {
    throw new Error(t('未找到要校正的会议发言，请先查看当前转写。'))
  }
  if (typeof speaker !== 'number' || !Number.isInteger(speaker) || speaker < 1 || speaker > maximumSpeaker) {
    throw new Error(t('说话人编号必须在 1 到 {0} 之间。', [maximumSpeaker]))
  }
  return turns.map(turn => turn.id === turnId ? { ...turn, speaker } : turn)
}
