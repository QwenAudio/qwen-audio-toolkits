import assert from 'node:assert/strict'
import {
  agentFileCanPreview,
  agentFileExtension,
  agentFileKind,
  agentOutputAttachmentsFromText,
  agentVideoAttachmentsFromText,
  agentVideoThumbnailTime,
  uniqueAgentFiles,
} from '../src/domain/agentFiles'

const audio = { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' }
const image = { path: '/tmp/screen.png', name: 'screen.png' }
const video = { path: '/tmp/cut.mov', name: 'cut.mov' }
const document = { path: '/tmp/script.md', name: 'script.md' }
const unknown = { path: '/tmp/archive.bin', name: 'archive.bin' }

assert.equal(agentFileExtension(audio), 'wav')
assert.equal(agentFileKind(audio), 'audio')
assert.equal(agentFileCanPreview(audio), true)
assert.equal(agentFileKind(image), 'image')
assert.equal(agentFileCanPreview(image), true)
assert.equal(agentFileKind(video), 'video')
assert.equal(agentFileCanPreview(video), true)
assert.equal(agentFileKind(document), 'document')
assert.equal(agentFileKind(unknown), 'file')
assert.deepEqual(uniqueAgentFiles([audio, audio, null, document]), [audio, document])
assert.deepEqual(
  agentVideoAttachmentsFromText('完成。已生成 `/Users/binbzha/Downloads/座舱演示视频（六段去标版）/拼接演示视频.mp4`，另一个在 /tmp/preview.mov。'),
  [
    {
      path: '/Users/binbzha/Downloads/座舱演示视频（六段去标版）/拼接演示视频.mp4',
      name: '拼接演示视频.mp4',
    },
    {
      path: '/tmp/preview.mov',
      name: 'preview.mov',
    },
  ],
)
assert.deepEqual(agentVideoAttachmentsFromText('文件名是 `拼接演示视频.mp4`，绝对路径稍后给出。'), [])
assert.equal(agentVideoThumbnailTime(0.5), 0)
assert.equal(agentVideoThumbnailTime(Number.POSITIVE_INFINITY), 0)
assert.equal(agentVideoThumbnailTime(2), 0.3)
assert.equal(agentVideoThumbnailTime(20), 1.6)
assert.equal(agentVideoThumbnailTime(120), 3)
assert.deepEqual(
  agentOutputAttachmentsFromText(
    '完成！已生成两个视频文件：\n\n**拼接完整版.mp4** (16MB)\n**拼接字幕版.mp4** (15.7MB)',
    [
      {
        path: '/Users/binbzha/Downloads/qwen-audio-agent-car-video-demo/01-后台持续工作.mp4',
        name: '01-后台持续工作.mp4',
      },
    ],
  ),
  [
    {
      path: '/Users/binbzha/Downloads/qwen-audio-agent-car-video-demo/拼接完整版.mp4',
      name: '拼接完整版.mp4',
    },
    {
      path: '/Users/binbzha/Downloads/qwen-audio-agent-car-video-demo/拼接字幕版.mp4',
      name: '拼接字幕版.mp4',
    },
  ],
)
assert.deepEqual(
  agentOutputAttachmentsFromText(
    '输出：`qwen-audio-agent-car-video-demo/拼接字幕版.mp4`',
    [
      {
        path: '/Users/binbzha/Downloads/qwen-audio-agent-car-video-demo/01.mp4',
        name: '01.mp4',
      },
    ],
  ),
  [
    {
      path: '/Users/binbzha/Downloads/qwen-audio-agent-car-video-demo/拼接字幕版.mp4',
      name: '拼接字幕版.mp4',
    },
  ],
)

console.log(JSON.stringify({ status: 'passed', checks: 19 }, null, 2))
