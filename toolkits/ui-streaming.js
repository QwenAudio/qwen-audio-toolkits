/* Transport and capture for StreamingAudio. The visual components stay shared. */
(() => {
  class Resampler {
    constructor(rate) { this.ratio = rate / 16000; this.samples = []; this.position = 0; }
    push(values) {
      this.samples.push(...values);
      const result = [];
      while (this.position + 1 < this.samples.length) {
        const i = Math.floor(this.position), fraction = this.position - i;
        result.push(this.samples[i] * (1 - fraction) + this.samples[i + 1] * fraction);
        this.position += this.ratio;
      }
      const consumed = Math.min(Math.floor(this.position), this.samples.length);
      this.samples.splice(0, consumed); this.position -= consumed;
      return new Float32Array(result);
    }
  }
  async function request(action, body) {
    const response = await fetch('stream/' + action, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '实时识别请求失败');
    return data;
  }
  function base64(bytes) {
    let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }
  async function capture({source, systemAudio, onStart, onUpdate, onFinish, onError}) {
    let id, media, context, node, input, native = false, timer, pollTimer, ending = false, closed = false;
    let sequence = 0, queue = Promise.resolve(), pending = 0, samples = 0, resampler, lastVersion = -1;
    const chunks = [];
    let latest;
    const cleanup = async () => {
      clearTimeout(timer); clearTimeout(pollTimer);
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', abandon);
      node?.disconnect(); input?.disconnect();
      media?.getTracks().forEach(track => track.stop());
      if (context) await context.close().catch(() => {});
      if (native) { native = false; await systemAudio('stop').catch(() => {}); }
    };
    const snapshot = () => ({chunks, sampleRate:16000, outputs:latest});
    const fail = async error => {
      if (closed) return;
      closed = true;
      await cleanup();
      if (id) void request('cancel', {id}).catch(() => {});
      onError(error, snapshot());
    };
    const accept = (values, rate) => {
      if (ending || closed) return;
      if (!resampler) resampler = new Resampler(rate);
      const data = resampler.push(values);
      if (!data.length) return;
      chunks.push(data); samples += data.length;
      const bytes = new Uint8Array(data.length * 2), view = new DataView(bytes.buffer);
      data.forEach((sample, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
      // Keep request bodies bounded, preserve exact ordering, never silently drop audio.
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        if (++pending > 64) { void fail(Error('网络发送过慢，请重试')); return; }
        const body = {id, sequence:sequence++, data:base64(bytes.subarray(offset, offset + 8192))};
        queue = queue.then(() => { if (!closed) return request('chunk', body); }).finally(() => { pending--; });
        queue.catch(error => void fail(error));
      }
      if (samples >= 16000 * 299) void stop();
    };
    function receive(event) {
      if (event.source !== window.parent || event.data?.type !== 'toolkits-system-audio-chunk' || !native) return;
      const raw = atob(event.data.data), view = new DataView(Uint8Array.from(raw, c => c.charCodeAt(0)).buffer);
      const values = new Float32Array(raw.length / 2);
      values.forEach((_, i) => { values[i] = view.getInt16(i * 2, true) / 32768; });
      accept(values, event.data.sampleRate);
    }
    function abandon() {
      closed = true; void cleanup();
      if (id) navigator.sendBeacon('stream/cancel', new Blob([JSON.stringify({id})], {type:'application/json'}));
    }
    const update = result => {
      if (result.outputs && result.version !== lastVersion) {
        latest = result.outputs; lastVersion = result.version; onUpdate(latest);
      }
      if (result.state === 'failed') throw Error(result.error || '实时识别失败');
    };
    const poll = async () => {
      if (closed || ending) return;
      try {
        const result = await request('poll', {id}); update(result);
        if (result.state === 'completed') { await stop(); return; }
        if (!ending && !closed) pollTimer = setTimeout(poll, 250);
      } catch (error) { await fail(error); }
    };
    const stop = async () => {
      if (ending || closed) return;
      ending = true;
      await cleanup();
      try {
        await queue;
        if (closed) return;
        let result = await request('finish', {id}); update(result);
        const deadline = Date.now() + 25000;
        while (!['completed', 'cancelled'].includes(result.state)) {
          if (Date.now() > deadline) throw Error('等待最终识别结果超时');
          await new Promise(resolve => setTimeout(resolve, 150));
          result = await request('poll', {id}); update(result);
        }
        closed = true;
        await onFinish(snapshot());
      } catch (error) { await fail(error); }
    };
    try {
      if (source === 'system' && window.parent !== window) {
        native = true;
      } else {
        media = source === 'system'
          ? await navigator.mediaDevices.getDisplayMedia({video:true, audio:true})
          : await navigator.mediaDevices.getUserMedia({audio:true});
        if (!media.getAudioTracks().length) throw Error('未共享音频');
        context = new AudioContext(); await context.resume();
      }
      ({id} = await request('start', {}));
      onStart();
      window.addEventListener('pagehide', abandon);
      window.addEventListener('message', receive);
      if (native) await systemAudio('start', true);
      else {
        input = context.createMediaStreamSource(media);
        node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = event => accept(event.inputBuffer.getChannelData(0), context.sampleRate);
        input.connect(node); node.connect(context.destination);
        media.getAudioTracks()[0].addEventListener('ended', () => void stop());
      }
      timer = setTimeout(() => void stop(), 299000);
      void poll();
      return {stop};
    } catch (error) { await fail(error); throw error; }
  }
  globalThis.ToolkitsStreaming = {capture, Resampler};
})();
