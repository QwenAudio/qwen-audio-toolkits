export const VIDEO_DUBBING_MODES = ['translate', 'rewrite', 'script']

export function normalizeDubbingMode(value) {
  return VIDEO_DUBBING_MODES.includes(value) ? value : 'translate'
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function distributeScriptAcrossTurns(script, turns) {
  const characters = [...script.replace(/\s+/gu, ' ').trim()]
  if (!characters.length) throw new Error('使用新文案模式需要填写完整配音文案')
  if (characters.length < turns.length) {
    throw new Error(`新文案过短：原视频包含 ${turns.length} 个讲话区间，请至少提供 ${turns.length} 个字符`)
  }
  const totalDuration = turns.reduce((sum, turn) => sum + Math.max(0.1, turn.end - turn.start), 0)
  let elapsed = 0
  let start = 0
  return turns.map((turn, index) => {
    if (index === turns.length - 1) {
      return { ...turn, text: characters.slice(start).join('').trim(), sourceText: turn.text }
    }
    elapsed += Math.max(0.1, turn.end - turn.start)
    const ideal = Math.round((elapsed / totalDuration) * characters.length)
    const minimum = start + 1
    const maximum = characters.length - (turns.length - index - 1)
    let boundary = clamp(ideal, minimum, maximum)
    for (let distance = 0; distance <= 14; distance += 1) {
      const forward = boundary + distance
      const backward = boundary - distance
      if (forward <= maximum && /[，。！？；,.!?;、]/u.test(characters[forward - 1] ?? '')) {
        boundary = forward
        break
      }
      if (backward >= minimum && /[，。！？；,.!?;、]/u.test(characters[backward - 1] ?? '')) {
        boundary = backward
        break
      }
    }
    const text = characters.slice(start, boundary).join('').trim()
    start = boundary
    return { ...turn, text, sourceText: turn.text }
  })
}

export function buildTransformationPrompt(dubbingMode, userInstruction = '') {
  return [
    dubbingMode === 'translate'
      ? '你是视频配音翻译编辑。把英文口播翻译成自然、准确、适合朗读的简体中文。'
      : '你是视频口播编辑。根据用户要求改写原始台词，必须保持原始语言，不要翻译成其他语言。',
    '保持每个 id、speaker、start、end 不变。可以删除无意义的口吃，但不要遗漏事实。',
    '每段必须语义完整，禁止以“并且与”“以及”“因为”等未完成连接词结尾。',
    dubbingMode === 'translate'
      ? '每段中文要尽量适配该段时长，正常语速按每秒约 3.5 至 4.5 个汉字控制。'
      : '改写结果要尽量适配原始讲话时长，不能增加原文没有的事实。',
    userInstruction ? `用户要求：${userInstruction}` : '',
    '只返回 JSON：{"turns":[{"id":"...","speaker":"...","start":0,"end":1,"text":"..."}]}。',
  ].filter(Boolean).join('')
}

export function batchTurns(turns, maximumCount = 3, maximumSize = 2200) {
  const batches = []
  let currentBatch = []
  let currentSize = 0
  for (const turn of turns) {
    const turnSize = JSON.stringify(turn).length
    if (currentBatch.length && (currentBatch.length >= maximumCount || currentSize + turnSize > maximumSize)) {
      batches.push(currentBatch)
      currentBatch = []
      currentSize = 0
    }
    currentBatch.push(turn)
    currentSize += turnSize
  }
  if (currentBatch.length) batches.push(currentBatch)
  return batches
}
