import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  captionPanelHeight,
  CAPTION_LINE_HEIGHT,
  CAPTION_MAXIMUM_PANEL_HEIGHT,
  CAPTION_TOTAL_LINE_COUNT,
  captionTextWidth,
  normalizeCaptionText,
  selectCaptionLines,
  wrapCaption,
} from '../src/utils/captionLayout.ts'

const HISTORY_CAPACITY = 49
const CURRENT_CAPACITY = 39

const overlayCss = await readFile(
  new URL('../src/views/CaptionOverlay.css', import.meta.url),
  'utf8',
)
const overlaySource = await readFile(
  new URL('../src/views/CaptionOverlay.tsx', import.meta.url),
  'utf8',
)
assert.match(
  overlayCss,
  new RegExp(
    `\\.caption-badge \\{[\\s\\S]*?height: ${CAPTION_LINE_HEIGHT + 2}px;[\\s\\S]*?gap: 2px;`,
  ),
)
assert.match(
  overlayCss,
  /\.caption-lines \{[\s\S]*?overflow: visible;/,
)
assert.match(
  overlayCss,
  /\.caption-badge small \{[\s\S]*?display: none;/,
)
assert.match(overlaySource, /resizeQueueRef\.current = resizeQueueRef\.current/)
assert.match(
  overlaySource,
  /import\.meta\.env\.VITE_CAPTION_DEBUG_FIXTURE === 'stress'/,
)

assert.equal(
  normalizeCaptionText('A\r\nB\rC\nD\u0085E\u2028F\u2029G'),
  'A B C D E F G',
)

const fourFinals = selectCaptionLines(
  ['first final', 'second final', 'third final', 'fourth final'],
  '',
  HISTORY_CAPACITY,
  CURRENT_CAPACITY,
)
assert.equal(fourFinals.length, 4)
assert.deepEqual(
  fourFinals.map(({ role }) => role),
  ['history', 'history', 'history', 'history'],
)

const liveText =
  'The live caption should keep complete English words together while it grows upward and replaces older final lines.'
const liveLines = wrapCaption(liveText, 15)
assert.ok(liveLines.length >= 4)
assert.equal(liveLines.join(' '), liveText)
assert.ok(liveLines.every((line) => !/^\s|\s$/u.test(line)))
assert.ok(
  liveLines.every(
    (line) => captionTextWidth(line) <= 15 || !line.includes(' '),
  ),
)

const punctuatedEnglish = wrapCaption(
  'This is English , with odd punctuation spacing ! It should still wrap naturally .',
  18,
)
assert.ok(punctuatedEnglish.every((line) => !/^[,.;:!?%]/u.test(line)))
assert.equal(
  punctuatedEnglish.join(' '),
  'This is English, with odd punctuation spacing! It should still wrap naturally.',
)

const mixedChineseEnglish = wrapCaption(
  '能够快速的去把新出的Check Point做完评测，然后推到群里，大家去看一下指标有没有问题，然后听一下它的音有没有问题。然后第三点的话是呢对外影响力建设，主要就是支持了Technical Report.',
  HISTORY_CAPACITY,
)
assert.ok(captionTextWidth(mixedChineseEnglish[0]) > 40)
assert.ok(mixedChineseEnglish[0].includes('Check Point'))
assert.ok(!mixedChineseEnglish[1].startsWith('Point'))

for (const liveLineCount of [1, 2, 3, 4, 8]) {
  const current = Array.from(
    { length: liveLineCount },
    (_, index) => `live${index + 1}`,
  ).join(' ')
  const selected = selectCaptionLines(
    ['final one', 'final two', 'final three', 'final four'],
    current,
    HISTORY_CAPACITY,
    5,
  )
  const expectedLiveCount = Math.min(
    liveLineCount,
    CAPTION_TOTAL_LINE_COUNT,
  )
  assert.equal(selected.length, CAPTION_TOTAL_LINE_COUNT)
  assert.equal(
    selected.filter(({ role }) => role === 'current').length,
    expectedLiveCount,
  )
  assert.equal(
    selected.filter(({ role }) => role === 'history').length,
    CAPTION_TOTAL_LINE_COUNT - expectedLiveCount,
  )
  const visibleLive = selected.filter(({ role }) => role === 'current')
  assert.equal(visibleLive[0]?.showsBadge, true)
  assert.ok(visibleLive.slice(1).every(({ showsBadge }) => !showsBadge))
}

const overlong = wrapCaption(
  'normal words https://example.com/an/extremely/long/path/without/spaces tail',
  12,
)
assert.ok(overlong.length > 3)
assert.equal(
  overlong.join('').replaceAll(' ', ''),
  'normalwordshttps://example.com/an/extremely/long/path/without/spacestail',
)
assert.ok(overlong.every((line) => line.length > 0))

const chinese = selectCaptionLines(
  ['第一行字幕', '第二行字幕', '第三行字幕', '第四行字幕'],
  '这是一段会被拆成三行的实时中文字幕',
  HISTORY_CAPACITY,
  8,
)
assert.equal(chinese.length, CAPTION_TOTAL_LINE_COUNT)
assert.equal(chinese.filter(({ role }) => role === 'current').length, 3)
assert.equal(chinese.filter(({ role }) => role === 'history').length, 1)

const separatorStress = selectCaptionLines(
  ['历史一', '历史二', '历史三', '历史四'],
  '第一段\r\n第二段\r第三段\u0085第四段\u2028第五段\u2029第六段'.repeat(20),
  HISTORY_CAPACITY,
  CURRENT_CAPACITY,
)
assert.ok(separatorStress.length <= CAPTION_TOTAL_LINE_COUNT)
assert.ok(
  separatorStress.every(
    ({ text }) => !/[\r\n\u0085\u2028\u2029]/u.test(text),
  ),
)

assert.equal(captionPanelHeight(0), 54)
assert.equal(captionPanelHeight(4), CAPTION_MAXIMUM_PANEL_HEIGHT)
assert.equal(captionPanelHeight(40), CAPTION_MAXIMUM_PANEL_HEIGHT)

console.log(
  JSON.stringify({
    maxVisibleLines: CAPTION_TOTAL_LINE_COUNT,
    englishLines: liveLines,
    longTokenLines: overlong.length,
  }),
)
