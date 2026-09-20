/* Shared content protocol for input previews, conversation messages and details. */
(() => {
  function node(tag, parent, text) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    parent.append(element);
    return element;
  }
  function content(component, value) {
    return { kind: component.kind, label: component.label || '', value,
      columns: component.columns || [], labels: component.labels || {} };
  }
  function message(role, components, values) {
    if (!['user', 'assistant'].includes(role)) throw Error('Invalid message role');
    if (components.length !== values.length) throw Error('Content count does not match components');
    return { role, content: components.map((component, i) => content(component, values[i])) };
  }
  const waveformCache = new Map();
  function waveformPeaks(channels, bins = 160) {
    const length = channels[0]?.length || 0;
    return Array.from({ length: bins }, (_, bin) => {
      const start = Math.floor(bin * length / bins);
      const end = Math.min(length, Math.max(start + 1, Math.floor((bin + 1) * length / bins)));
      let peak = 0;
      for (const channel of channels) for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(channel[i] || 0));
      return peak;
    });
  }
  async function audioBytes(url) {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0 || !url.slice(0, comma).endsWith(';base64')) throw Error('无效的音频数据');
      const binary = atob(url.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    const response = await fetch(url);
    if (!response.ok) throw Error('无法读取音频');
    return response.arrayBuffer();
  }
  async function loadWaveform(url) {
    if (!waveformCache.has(url)) {
      const pending = (async () => {
        const bytes = await audioBytes(url);
        const context = new AudioContext();
        try {
          const buffer = await context.decodeAudioData(bytes);
          return waveformPeaks(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)));
        } finally { await context.close(); }
      })();
      waveformCache.set(url, pending);
      if (waveformCache.size > 24) waveformCache.delete(waveformCache.keys().next().value);
      pending.catch(() => waveformCache.delete(url));
    }
    return waveformCache.get(url);
  }
  function spectrum(samples) {
    const n = 512, real = new Float64Array(n), imag = new Float64Array(n);
    for (let i = 0; i < n; i++) real[i] = (samples[i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [real[i], real[j]] = [real[j], real[i]];
    }
    for (let size = 2; size <= n; size <<= 1) {
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < size / 2; j++) {
          const angle = -2 * Math.PI * j / size, a = start + j, b = a + size / 2;
          const r = real[b] * Math.cos(angle) - imag[b] * Math.sin(angle);
          const im = real[b] * Math.sin(angle) + imag[b] * Math.cos(angle);
          real[b] = real[a] - r; imag[b] = imag[a] - im;
          real[a] += r; imag[a] += im;
        }
      }
    }
    return Array.from({ length: n / 2 + 1 }, (_, i) => Math.hypot(real[i], imag[i]) / (n / 4));
  }
  function addSpectrogram(parent, player) {
    const panel = node('details', parent); panel.className = 'audio-spectrogram';
    node('summary', panel, '频谱图');
    const status = node('small', panel, '正在计算频谱…');
    const canvas = node('canvas', panel); canvas.width = 320; canvas.height = 128; canvas.hidden = true;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '音频时频谱：横轴时间、纵轴频率，颜色越亮能量越强');
    let started = false;
    panel.addEventListener('toggle', async () => {
      if (!panel.open || started) return;
      started = true; status.textContent = '正在计算频谱…';
      let context;
      try {
        const bytes = await audioBytes(player.src);
        context = new AudioContext();
        const buffer = await context.decodeAudioData(bytes);
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
        const g = canvas.getContext('2d'), pixels = g.createImageData(320, 128);
        const maximumHz = Math.min(12000, buffer.sampleRate / 2);
        for (let x = 0; x < 320; x++) {
          const start = Math.floor(x / 319 * Math.max(0, buffer.length - 512));
          const magnitudes = channels.map(channel => spectrum(channel.subarray(start, start + 512)));
          for (let y = 0; y < 128; y++) {
            const bin = Math.min(256, Math.round((127 - y) / 127 * maximumHz / buffer.sampleRate * 512));
            const power = magnitudes.reduce((sum, bins) => sum + bins[bin] ** 2, 0) / magnitudes.length;
            const strength = Math.max(0, Math.min(1, (10 * Math.log10(Math.max(1e-12, power)) + 80) / 80));
            const offset = (y * 320 + x) * 4;
            pixels.data[offset] = Math.round(15 + 235 * strength ** 2);
            pixels.data[offset + 1] = Math.round(22 + 200 * strength);
            pixels.data[offset + 2] = Math.round(40 + 90 * Math.sin(strength * Math.PI));
            pixels.data[offset + 3] = 255;
          }
          if (x % 24 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        g.putImageData(pixels, 0, 0); canvas.hidden = false;
        status.textContent = `时间 0–${buffer.duration.toFixed(2)} 秒 · 频率 0–${(maximumHz / 1000).toFixed(1)} kHz（下→上）· 亮色表示较强能量`;
      } catch {
        status.textContent = '频谱生成失败，收起后可重试；不影响播放'; started = false;
      } finally { if (context) await context.close(); }
    });
    panel.open = true;
  }
  function audio(parent, value, context = 'message') {
    const player = node('audio', parent);
    player.controls = true;
    player.preload = 'metadata';
    if (value) {
      const url = value.dataUrl || `data:${value.mimeType || 'audio/wav'};base64,${value.data}`;
      if (!/^(data:audio\/|blob:|https?:\/\/|\/)/i.test(url)) throw Error('Unsupported audio URL');
      player.src = url;
    }
    {
      player.controls = false;
      player.hidden = true;
      const controls = node('div', parent); controls.className = 'audio-player'; controls.hidden = !value;
      const toggle = node('button', controls, '▶'); toggle.type = 'button'; toggle.className = 'audio-play';
      const playIcon = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6 4.5a.7.7 0 0 1 1-.6l9 5.5a.7.7 0 0 1 0 1.2l-9 5.5a.7.7 0 0 1-1-.6z"/></svg>';
      const pauseIcon = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></svg>';
      toggle.innerHTML = playIcon;
      toggle.setAttribute('aria-label', '播放音频');
      const elapsed = node('span', controls, '0:00'); elapsed.className = 'audio-time';
      const seek = node('input', controls); seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.value = '0'; seek.step = '1'; seek.disabled = true;
      seek.setAttribute('aria-label', '音频播放进度');
      const duration = node('span', controls, '—'); duration.className = 'audio-time';
      const format = seconds => Number.isFinite(seconds) ? Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0') : '—';
      const update = () => {
        controls.hidden = !player.getAttribute('src');
        elapsed.textContent = format(player.currentTime || 0);
        duration.textContent = format(player.duration);
        seek.disabled = !Number.isFinite(player.duration) || player.duration <= 0;
        seek.value = seek.disabled ? '0' : String(Math.round(player.currentTime / player.duration * 1000));
        toggle.innerHTML = player.paused ? playIcon : pauseIcon;
        toggle.setAttribute('aria-label', player.paused ? '播放音频' : '暂停音频');
      };
      toggle.onclick = async () => {
        try { if (player.paused) await player.play(); else player.pause(); }
        catch { duration.textContent = '播放失败'; toggle.setAttribute('aria-label', '重试播放'); }
      };
      seek.addEventListener('input', () => { if (!seek.disabled) player.currentTime = Number(seek.value) / 1000 * player.duration; });
      ['loadstart', 'emptied', 'loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended'].forEach(event => player.addEventListener(event, update));
      player.addEventListener('error', () => { duration.textContent = '无法播放'; });
    }
    if (context === 'detail' && value && typeof AudioContext !== 'undefined') {
      if (context === 'detail') addSpectrogram(parent, player);
      const waveform = node('div', parent); waveform.className = 'audio-waveform';
      const canvas = node('canvas', waveform); canvas.width = 640; canvas.height = 72;
      canvas.setAttribute('aria-hidden', 'true');
      const seek = node('input', waveform); seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.step = '1'; seek.value = '0'; seek.disabled = true;
      seek.setAttribute('aria-label', '波形播放进度');
      const hint = node('small', parent, '正在生成波形…'); hint.className = 'waveform-status';
      let peaks;
      const draw = () => {
        const context = canvas.getContext('2d');
        if (!context || !peaks) return;
        const fraction = Number.isFinite(player.duration) && player.duration > 0 ? player.currentTime / player.duration : 0;
        context.clearRect(0, 0, 640, 72);
        peaks.forEach((peak, i) => {
          const height = Math.max(2, peak * 64);
          context.fillStyle = i / peaks.length <= fraction ? '#4e8270' : '#c9d8d0';
          context.fillRect(i * 4, (72 - height) / 2, 2.5, height);
        });
        seek.value = String(Math.round(fraction * 1000));
        seek.disabled = !Number.isFinite(player.duration) || player.duration <= 0;
        seek.setAttribute('aria-valuetext', `${player.currentTime.toFixed(1)} 秒`);
      };
      player.addEventListener('timeupdate', draw);
      player.addEventListener('loadedmetadata', draw);
      seek.addEventListener('input', () => {
        if (Number.isFinite(player.duration)) player.currentTime = Number(seek.value) / 1000 * player.duration;
        draw();
      });
      void loadWaveform(player.src).then(values => {
        peaks = values; hint.hidden = true; draw();
      }).catch(() => {
        waveform.hidden = true; hint.textContent = '波形暂不可用，仍可使用播放器';
      });
    }
    return player;
  }
  function video(parent, value, context = 'message') {
    if (!value) {
      const empty = node('p', parent, context === 'detail' ? '当前还没有可预览的视频结果。' : '等待视频结果…');
      empty.className = 'video-empty';
      return null;
    }
    const player = node('video', parent);
    player.controls = true;
    player.preload = 'metadata';
    player.playsInline = true;
    const url = value.dataUrl || `data:${value.mimeType || 'video/mp4'};base64,${value.data}`;
    if (!/^(data:video\/|blob:|https?:\/\/|\/)/i.test(url)) throw Error('Unsupported video URL');
    player.src = url;
    player.addEventListener('error', () => {
      const message = node('small', parent, '无法在当前浏览器预览此视频格式。');
      message.className = 'video-error';
    }, {once: true});
    return player;
  }
  const renderers = {
    audio(parent, block, context) {
      if (context === 'detail' && block.value?.name) node('small', parent, block.value.name);
      audio(parent, block.value, context);
    },
    video(parent, block, context) {
      if (block.value?.name) node('small', parent, block.value.name);
      video(parent, block.value, context);
    },
    text(parent, block) { node('pre', parent, block.value ?? ''); },
    number(parent, block) { node('output', parent, block.value); },
    select(parent, block) {
      const values = Array.isArray(block.value) ? block.value : [block.value];
      node('span', parent, values.map(v => block.labels[v] ?? v ?? '').join('、'));
    },
    table(parent, block, context) {
      if (context === 'message') {
        parent.hidden = true;
        return;
      }
      const wrap = node('div', parent); wrap.className = 'table-scroll';
      const table = node('table', wrap), head = node('tr', node('thead', table));
      block.columns.forEach(name => node('th', head, name));
      const body = node('tbody', table);
      block.value.forEach(values => {
        const row = node('tr', body);
        values.forEach(value => node('td', row, value ?? ''));
      });
    },
    'audio-info'(parent, block) {
      const list = node('dl', parent); list.className = 'content-properties';
      Object.entries(block.value || {}).forEach(([key, value]) => {
        node('dt', list, key);
        node('dd', list, typeof value === 'object' ? JSON.stringify(value) : value);
      });
    },
    'video-info'(parent, block) {
      const list = node('dl', parent); list.className = 'content-properties';
      Object.entries(block.value || {}).forEach(([key, value]) => {
        node('dt', list, key);
        node('dd', list, typeof value === 'object' ? JSON.stringify(value) : value);
      });
    },
  };
  function render(parent, block, context = 'message') {
    if (context === 'parameter' && block.kind !== 'audio' && block.kind !== 'video') {
      const values = Array.isArray(block.value) ? block.value : [block.value];
      const value = values.map(v => block.labels[v] ?? v ?? '').join('、');
      const tag = node('span', parent, value ? `${block.label}：${value}` : '');
      tag.className = 'parameter';
      tag.hidden = true;
      return tag;
    }
    const section = node('section', parent); section.className = 'result';
    section.dataset.kind = block.kind;
    if (block.label) node('label', section, block.label);
    const renderer = renderers[block.kind];
    if (renderer) renderer(section, block, context);
    else node('pre', section, typeof block.value === 'string' ? block.value : JSON.stringify(block.value, null, 2));
    return section;
  }
  globalThis.ToolkitsContent = { content, message, audio, video, render, waveformPeaks, spectrum, audioBytes };
})();
