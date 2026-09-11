export const VIDEO_DUBBING_MODES = ['translate', 'rewrite', 'script']

export function normalizeDubbingMode(value) {
  return VIDEO_DUBBING_MODES.includes(value) ? value : 'translate'
}

export const DUBBING_LANGUAGE_CODES = ['zh', 'en', 'ja', 'ko']
export const DUBBING_LANGUAGE_NAMES = {
  zh: '简体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
}

export function normalizeDubbingLanguage(value, fallback = 'zh') {
  const code = String(value ?? '').trim().toLowerCase()
  if (code === 'auto') return 'auto'
  return DUBBING_LANGUAGE_CODES.includes(code) ? code : fallback
}

export function dubbingLanguageName(code) {
  return DUBBING_LANGUAGE_NAMES[code] ?? String(code ?? '')
}

const SPEECH_RATE_GUIDANCE = {
  zh: '每秒约 3.5 至 4.5 个汉字',
  en: '每秒约 2 至 2.5 个单词',
  ja: '每秒约 5 至 7 个字符',
  ko: '每秒约 5 至 7 个字符',
}

export function speechRateGuidance(code) {
  return SPEECH_RATE_GUIDANCE[code] ?? SPEECH_RATE_GUIDANCE.zh
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

export function buildTransformationPrompt(dubbingMode, userInstruction = '', languages = {}) {
  const targetLanguage = normalizeDubbingLanguage(languages.target, 'zh')
  const sourceLanguage = normalizeDubbingLanguage(languages.source, 'auto')
  const sourceName = sourceLanguage === 'auto' ? '原始语言' : dubbingLanguageName(sourceLanguage)
  const targetName = dubbingLanguageName(targetLanguage)
  return [
    dubbingMode === 'translate'
      ? `你是视频配音翻译编辑。把${sourceName}口播翻译成自然、准确、适合朗读的${targetName}。`
      : '你是视频口播编辑。根据用户要求改写原始台词，必须保持原始语言，不要翻译成其他语言。',
    '保持每个 id、speaker、start、end 不变。可以删除无意义的口吃，但不要遗漏事实。',
    '每段必须语义完整，禁止以“并且与”“以及”“因为”等未完成连接词结尾，也禁止以省略号或“的”“了”等悬挂成分结尾。',
    '输入可能附带 contextPrevious/contextNext，是相邻段的原文（只读、禁止翻译输出）。若某段原文恰在句中截断，允许参照相邻段把它译成完整自然的口语：可与相邻段共享少量承接信息（例如点出横跨两段的那个宾语），但不得整句复制相邻段内容。',
    dubbingMode === 'translate'
      ? `每段译文要尽量适配该段时长，正常语速按${speechRateGuidance(targetLanguage)}控制。`
      : '改写结果要尽量适配原始讲话时长，不能增加原文没有的事实。',
    userInstruction ? `用户要求：${userInstruction}` : '',
    '只返回 JSON：{"turns":[{"id":"...","speaker":"...","start":0,"end":1,"text":"..."}]}。',
  ].filter(Boolean).join('')
}

export function buildTranslationContextPrompt(targetLanguage) {
  const targetName = dubbingLanguageName(normalizeDubbingLanguage(targetLanguage, 'zh'))
  return [
    '你是视频配音翻译主编。通读完整口播转写稿，为后续分批翻译制定统一的上下文约定。',
    `只返回 JSON：{"summary":"一到三句内容梗概，含话题与说话人关系","tone":"语气、人称与句式风格约定","glossary":[{"source":"原文术语","target":"${targetName}译法","note":"可选备注"}]}。`,
    `glossary 收录人名、品牌、地名、专名和需要统一译法的术语，全部给出${targetName}译法，不超过 30 条；译名采用通行译法，不要音译常见词汇。`,
  ].join('')
}

export function formatTranslationContext(context) {
  if (!context || typeof context !== 'object') return ''
  const lines = []
  if (context.summary) lines.push(`内容梗概：${context.summary}`)
  if (context.tone) lines.push(`语气风格：${context.tone}`)
  const glossary = Array.isArray(context.glossary) ? context.glossary : []
  const validGlossary = glossary.filter((entry) => entry?.source && entry?.target).slice(0, 30)
  if (validGlossary.length) {
    lines.push('术语表（同一术语全片必须使用相同译法）：')
    for (const entry of validGlossary) {
      lines.push(`- ${entry.source} => ${entry.target}${entry.note ? `（${entry.note}）` : ''}`)
    }
  }
  return lines.length ? `以下是全片统一的翻译上下文约定，必须严格遵守：\n${lines.join('\n')}` : ''
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
