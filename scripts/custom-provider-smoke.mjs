import assert from 'node:assert/strict'
import http from 'node:http'

const appApi = process.env.QWEN_AUDIO_TOOLKITS_API ?? 'http://127.0.0.1:3847/v1'
const mockPort = 3859
const mockBaseUrl = `http://127.0.0.1:${mockPort}`
const requests = []

function wavBytes(sampleRate = 24_000, durationSeconds = 0.12) {
  const sampleCount = Math.floor(sampleRate * durationSeconds)
  const dataSize = sampleCount * 2
  const output = Buffer.alloc(44 + dataSize)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + dataSize, 4)
  output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(dataSize, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((index / sampleRate) * Math.PI * 440) * 4_000)
    output.writeInt16LE(sample, 44 + index * 2)
  }
  return output
}

async function json(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

async function execute(request) {
  const run = await json(`${appApi}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const current = await json(`${appApi}/runs/${run.id}`)
    if (current.status === 'completed') {
      return {
        runId: run.id,
        output: await json(`${appApi}/runs/${run.id}/output`),
      }
    }
    if (current.status === 'failed' || current.status === 'canceled') {
      throw new Error(current.error ?? current.status)
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`run timeout: ${request.capability}`)
}

const audio = wavBytes()
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks)
    requests.push({
      path: request.url,
      auth: request.headers.authorization ?? request.headers['x-client-key'] ?? request.headers['x-api-key'],
      headers: request.headers,
      contentType: request.headers['content-type'],
      body,
    })
    response.setHeader('content-type', 'application/json')
    if (request.url === '/chat/completions') {
      response.end(JSON.stringify({
        choices: [{ message: { content: 'provider smoke passed' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }))
      return
    }
    if (request.url === '/speech-to-text') {
      response.end(JSON.stringify({
        result: { text: 'transcription passed' },
        language_code: 'en',
        duration: 0.12,
      }))
      return
    }
    if (request.url === '/t2a_v2') {
      response.end(JSON.stringify({ data: { audio: audio.toString('hex') } }))
      return
    }
    if (request.url === '/listen?model=asr-model') {
      response.end(JSON.stringify({
        results: { channels: [{ alternatives: [{ transcript: 'binary transcription passed' }] }] },
      }))
      return
    }
    if (request.url === '/speak?model=tts-model&encoding=linear16') {
      response.setHeader('content-type', 'application/octet-stream')
      response.end(audio.subarray(44))
      return
    }
    if (request.url === '/text-to-speech/voice-1?output_format=pcm_24000') {
      response.setHeader('content-type', 'application/octet-stream')
      response.end(audio.subarray(44))
      return
    }
    if (request.url === '/flash-asr') {
      response.end(JSON.stringify({
        audio_info: { duration: 120 },
        result: { text: 'template transcription passed' },
      }))
      return
    }
    if (request.url === '/tts-stream') {
      response.setHeader('content-type', 'text/event-stream')
      const pcm = audio.subarray(44)
      const middle = Math.floor(pcm.length / 2)
      response.end([
        `event: 352\ndata: ${JSON.stringify({ code: 0, data: pcm.subarray(0, middle).toString('base64') })}\n`,
        `event: 352\ndata: ${JSON.stringify({ code: 0, data: pcm.subarray(middle).toString('base64') })}\n`,
        `event: 152\ndata: ${JSON.stringify({ code: 20_000_000, data: null })}\n`,
      ].join('\n'))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'unexpected path' }))
  })
})

await new Promise((resolve) => server.listen(mockPort, '127.0.0.1', resolve))
let providerId
const runIds = []
try {
  const provider = await json(`${appApi}/providers/openai-compatible`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Protocol Smoke',
      baseUrl: mockBaseUrl,
      apiKey: 'test-key',
      enabled: true,
      llmEnabled: true,
      asrEnabled: true,
      ttsEnabled: true,
      authType: 'bearer',
      authHeader: 'x-client-key',
      llmPath: '/chat/completions',
      asrMode: 'multipart',
      asrPath: '/speech-to-text',
      asrModelField: 'model_id',
      asrLanguageField: 'language_code',
      asrPromptField: 'prompt',
      asrTextPointer: '/result/text',
      ttsMode: 'nested-voice-json',
      ttsPath: '/t2a_v2',
      ttsResponseEncoding: 'hex',
      ttsAudioPointer: '/data/audio',
      ttsAudioFormat: 'wav',
      ttsSampleRate: 24000,
    }),
  })
  providerId = provider.id
  assert.match(providerId, /^api\.custom\./)

  const llm = await execute({
    capability: 'text.generate',
    providerId,
    input: { messages: [{ role: 'user', content: 'hello' }] },
    parameters: { modelId: 'chat-model' },
  })
  runIds.push(llm.runId)
  assert.equal(llm.output.output.text, 'provider smoke passed')

  const asr = await execute({
    capability: 'speech.transcribe',
    providerId,
    input: {
      audioDataUrl: `data:audio/wav;base64,${audio.toString('base64')}`,
      clipName: 'provider-smoke.wav',
    },
    parameters: {
      modelId: 'asr-model',
      language: 'en',
      context: 'smoke prompt',
    },
  })
  runIds.push(asr.runId)
  assert.equal(asr.output.output.text, 'transcription passed')

  const tts = await execute({
    capability: 'speech.synthesize',
    providerId,
    input: { text: 'hello from custom speech' },
    parameters: { modelId: 'tts-model', voice: 'voice-1', speed: 1.2 },
  })
  runIds.push(tts.runId)
  assert.equal(tts.output.output.sampleRate, 24000)
  assert.ok(tts.output.output.dataUrl.startsWith('data:audio/wav;base64,'))

  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map(({ path }) => path), [
    '/chat/completions',
    '/speech-to-text',
    '/t2a_v2',
  ])
  assert.ok(requests.every(({ auth }) => auth === 'Bearer test-key'))
  assert.match(requests[1].contentType, /^multipart\/form-data; boundary=/)
  const asrBody = requests[1].body.toString('latin1')
  assert.match(asrBody, /name="model_id"\r\n\r\nasr-model/)
  assert.match(asrBody, /name="language_code"\r\n\r\nen/)
  assert.match(asrBody, /name="prompt"\r\n\r\nsmoke prompt/)
  const ttsBody = JSON.parse(requests[2].body.toString('utf8'))
  assert.equal(ttsBody.model, 'tts-model')
  assert.equal(ttsBody.voice_setting.voice_id, 'voice-1')
  assert.equal(ttsBody.audio_setting.format, 'wav')
  assert.equal(ttsBody.output_format, 'hex')

  await json(`${appApi}/providers/openai-compatible`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...provider,
      id: providerId,
      apiKey: 'test-key',
      authType: 'token',
      asrMode: 'binary',
      asrPath: '/listen?model={model}',
      asrTextPointer: '/results/channels/0/alternatives/0/transcript',
      ttsMode: 'query-model-json',
      ttsPath: '/speak?model={model}&encoding=linear16',
      ttsResponseEncoding: 'raw',
      ttsAudioFormat: 'pcm16',
    }),
  })
  const binaryAsr = await execute({
    capability: 'speech.transcribe',
    providerId,
    input: {
      audioDataUrl: `data:audio/wav;base64,${audio.toString('base64')}`,
      clipName: 'binary-smoke.wav',
    },
    parameters: { modelId: 'asr-model' },
  })
  runIds.push(binaryAsr.runId)
  assert.equal(binaryAsr.output.output.text, 'binary transcription passed')
  const pcmTts = await execute({
    capability: 'speech.synthesize',
    providerId,
    input: { text: 'raw pcm smoke' },
    parameters: { modelId: 'tts-model', voice: 'voice-1' },
  })
  runIds.push(pcmTts.runId)
  assert.equal(pcmTts.output.output.sampleRate, 24000)

  await json(`${appApi}/providers/openai-compatible`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...provider,
      id: providerId,
      apiKey: 'test-key',
      authType: 'custom-header',
      authHeader: 'x-client-key',
      ttsMode: 'voice-path-json',
      ttsPath: '/text-to-speech/{voice}?output_format=pcm_24000',
      ttsResponseEncoding: 'raw',
      ttsAudioFormat: 'pcm16',
    }),
  })
  const voicePathTts = await execute({
    capability: 'speech.synthesize',
    providerId,
    input: { text: 'voice path smoke' },
    parameters: { modelId: 'tts-model', voice: 'voice-1', speed: 1.1 },
  })
  runIds.push(voicePathTts.runId)
  assert.equal(voicePathTts.output.output.sampleRate, 24000)

  assert.deepEqual(requests.map(({ path }) => path), [
    '/chat/completions',
    '/speech-to-text',
    '/t2a_v2',
    '/listen?model=asr-model',
    '/speak?model=tts-model&encoding=linear16',
    '/text-to-speech/voice-1?output_format=pcm_24000',
  ])
  assert.equal(requests[3].auth, 'Token test-key')
  assert.equal(requests[3].contentType, 'audio/wav')
  assert.equal(requests[4].auth, 'Token test-key')
  assert.equal(requests[5].auth, 'test-key')
  const voicePathBody = JSON.parse(requests[5].body.toString('utf8'))
  assert.equal(voicePathBody.model_id, 'tts-model')
  assert.equal(voicePathBody.voice_settings.speed, 1.1)

  await json(`${appApi}/providers/openai-compatible`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...provider,
      id: providerId,
      apiKey: 'test-key',
      authType: 'custom-header',
      authHeader: 'x-api-key',
      extraHeaders: {
        'x-resource-id': '{model}',
        'x-request-id': '{uuid}',
        'x-sequence': '-1',
      },
      asrMode: 'template-json-base64',
      asrPath: '/flash-asr',
      asrBodyTemplate: JSON.stringify({
        audio: { data: '{audioBase64}' },
        request: { model_name: 'bigmodel' },
      }),
      asrTextPointer: '/result/text',
      ttsMode: 'template-json',
      ttsPath: '/tts-stream',
      ttsBodyTemplate: JSON.stringify({
        user: { uid: 'desktop-client' },
        req_params: {
          text: '{text}',
          speaker: '{voice}',
          audio_params: {
            format: '{audioFormat}',
            sample_rate: '{sampleRate}',
            speech_rate: '{speechRate}',
          },
        },
      }),
      ttsResponseEncoding: 'stream-base64',
      ttsAudioPointer: '/data',
      ttsAudioFormat: 'pcm16',
      ttsSampleRate: 24000,
    }),
  })
  const templateAsr = await execute({
    capability: 'speech.transcribe',
    providerId,
    input: {
      audioDataUrl: `data:audio/wav;base64,${audio.toString('base64')}`,
      clipName: 'template-smoke.wav',
    },
    parameters: { modelId: 'asr-resource' },
  })
  runIds.push(templateAsr.runId)
  assert.equal(templateAsr.output.output.text, 'template transcription passed')
  const streamTts = await execute({
    capability: 'speech.synthesize',
    providerId,
    input: { text: 'stream template smoke' },
    parameters: { modelId: 'tts-resource', voice: 'voice-2', speed: 1.5 },
  })
  runIds.push(streamTts.runId)
  assert.equal(streamTts.output.output.sampleRate, 24000)

  const templateAsrRequest = requests[6]
  const streamTtsRequest = requests[7]
  assert.equal(templateAsrRequest.auth, 'test-key')
  assert.equal(templateAsrRequest.headers['x-resource-id'], 'asr-resource')
  assert.match(templateAsrRequest.headers['x-request-id'], /^[0-9a-f-]{36}$/)
  assert.equal(templateAsrRequest.headers['x-sequence'], '-1')
  const templateAsrBody = JSON.parse(templateAsrRequest.body.toString('utf8'))
  assert.equal(templateAsrBody.request.model_name, 'bigmodel')
  assert.equal(Buffer.from(templateAsrBody.audio.data, 'base64').subarray(0, 4).toString(), 'RIFF')
  assert.equal(streamTtsRequest.headers['x-resource-id'], 'tts-resource')
  const streamTtsBody = JSON.parse(streamTtsRequest.body.toString('utf8'))
  assert.equal(streamTtsBody.req_params.speaker, 'voice-2')
  assert.equal(streamTtsBody.req_params.audio_params.format, 'pcm')
  assert.equal(streamTtsBody.req_params.audio_params.sample_rate, 24000)
  assert.equal(streamTtsBody.req_params.audio_params.speech_rate, 50)

  process.stdout.write(JSON.stringify({
    providerId,
    paths: requests.map(({ path }) => path),
    auth: ['bearer', 'token', 'custom-header'],
    asr: ['multipart', 'binary', 'template-json+base64'],
    tts: ['nested-json+hex', 'query-json+pcm16', 'voice-path-json+pcm16', 'template-json+sse'],
    status: 'passed',
  }))
} finally {
  for (const runId of runIds) {
    await fetch(`${appApi}/runs/${runId}`, { method: 'DELETE' }).catch(() => {})
  }
  if (providerId) {
    await fetch(
      `${appApi}/providers/openai-compatible/${encodeURIComponent(providerId)}`,
      { method: 'DELETE' },
    ).catch(() => {})
  }
  await new Promise((resolve) => server.close(resolve))
}
