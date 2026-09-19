const $ = (id) => document.getElementById(id),
  pillUpdates = new Map(),
  inputValues = new Proxy([], {
    set(target, key, value) {
      target[key] = value;
      pillUpdates.get(Number(key))?.(value);
      return true;
    },
  });
let running = false;
let leaving = false;
const toolkitsHost = (() => {
  let origin;
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "toolkits-host-ready" || !event.origin || event.origin === "null") return;
    origin = event.origin;
  });
  return {
    isHostEvent: event => event.source === window.parent && event.origin === origin,
    post: message => {
      if (!origin) throw Error("Toolkits 宿主尚未准备好");
      window.parent.postMessage(message, origin);
    },
  };
})();
window.ToolkitsHost = toolkitsHost;
window.addEventListener("pagehide", () => { leaving = true; });
const status = (message) => {
  $("status").textContent = message;
};
function element(tag, parent, text) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}
function section(parent, label) {
  const s = element("section", parent);
  element("label", s, label);
  return s;
}
function wav(chunks, rate) {
  const samples = chunks.reduce((n, c) => n + c.length, 0),
    buffer = new ArrayBuffer(44 + samples * 2),
    v = new DataView(buffer);
  function str(offset, s) {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  }
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const c of chunks)
    for (const sample of c) {
      v.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 32767, true);
      offset += 2;
    }
  return new File([buffer], "recording.wav", { type: "audio/wav" });
}
function systemAudio(action, streaming = false) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { window.removeEventListener("message", receive); reject(Error("电脑音频请求超时，请在 Toolkits 中打开此 Agent")); }, 60000);
    function receive(event) {
      if (!toolkitsHost.isHostEvent(event) || event.data?.type !== "toolkits-system-audio-result" || event.data.requestId !== requestId) return;
      clearTimeout(timeout); window.removeEventListener("message", receive);
      event.data.error ? reject(Error(event.data.error)) : resolve(event.data);
    }
    window.addEventListener("message", receive);
    toolkitsHost.post({ type: "toolkits-system-audio", action, requestId, streaming });
  });
}
async function setup() {
  const response = await fetch("schema");
  if (!response.ok) throw Error("无法读取 UI 定义");
  const schema = await response.json();
  document.title = schema.title;
  $("title").textContent = schema.title;
  $("description").textContent = schema.description;
  const components = [],
    mounts = [];
  const audioResets = new Map();
  schema.inputs.forEach((group, index) => {
    const container = element("div", $("inputs"));
    container.className = "input-group";
    container.setAttribute("role", "group");
    container.setAttribute(
      "aria-label",
      group.main.label || `输入 ${index + 1}`,
    );
    let additional;
    if (group.additional.length) {
      additional = element("div", container);
      additional.className = "additional-inputs";
      additional.setAttribute("role", "group");
      additional.setAttribute(
        "aria-label",
        (group.main.label || `输入 ${index + 1}`) + "的附加输入",
      );
    }
    const main = element("div", container);
    main.className = "main-input";
    components.push(group.main);
    mounts.push(main);
    for (const c of group.additional) {
      const i = components.length,
        chip = element("button", additional);
      chip.type = "button";
      chip.className =
        c.kind === "audio" ? "input-pill audio-pill" : "input-pill";
      if (c.kind === "audio")
        element("span", chip, "▂▅▇▅▂").className = "audio-pill-icon";
      const name = element(
        "span",
        chip,
        (c.label || "选项").replace(/（.*?）/g, ""),
      );
      name.className = "pill-label";
      const value = element("span", chip);
      value.className = "pill-value";
      element("span", chip, "⌄").className = "pill-chevron";
      const panel = element("div", additional);
      panel.className =
        c.kind === "audio" ? "pill-editor audio-editor" : "pill-editor";
      panel.id = `input-option-${i}`;
      panel.setAttribute("popover", "auto");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", c.label || "编辑选项");
      chip.setAttribute("aria-haspopup", "dialog");
      chip.setAttribute("aria-controls", panel.id);
      chip.setAttribute("aria-expanded", "false");
      const update = (v) => {
        const text =
          v == null || v === ""
            ? (c.kind === "select" && !c.choices.length ? "暂无选项" : "未设置")
            : Array.isArray(v)
              ? `${v.length} 项`
              : typeof v === "object"
                ? v.name || "已添加"
                : (c.labels?.[v] ?? String(v));
        if (c.kind === "audio") {
          name.textContent = v?.name
            ? c.label || "音频"
            : "添加" + (c.label || "音频");
          chip.classList.toggle("has-audio", !!v?.name);
          value.hidden = !v?.name;
        }
        value.textContent = text;
        chip.title = (c.label || "选项") + "：" + text;
      };
      pillUpdates.set(i, update);
      update(c.value);
      chip.onclick = () => {
        if (panel.matches(":popover-open")) {
          panel.hidePopover();
          return;
        }
        panel.showPopover();
        const rect = chip.getBoundingClientRect();
        panel.style.left =
          Math.max(
            12,
            Math.min(rect.left, innerWidth - panel.offsetWidth - 12),
          ) + "px";
        panel.style.top =
          Math.max(12, rect.top - panel.offsetHeight - 10) + "px";
        (panel.querySelector('[aria-selected="true"]') || panel.querySelector("input,textarea,select,button"))?.focus({ preventScroll: true });
      };
      panel.addEventListener("toggle", () =>
        chip.setAttribute(
          "aria-expanded",
          String(panel.matches(":popover-open")),
        ),
      );
      components.push(c);
      mounts.push(panel);
    }
  });
  if (
    schema.inputs.length > 1 &&
    schema.inputs.every((g) => g.main.kind === "audio" && !g.additional.length)
  )
    document
      .querySelector(".composer-shell")
      .classList.add("audio-primary-grid");
  function pack(values) {
    if (schema.input_mode === "legacy") return values;
    let offset = 0;
    return schema.inputs.map((group) => {
      const main = values[offset++],
        additional = values.slice(offset, offset + group.additional.length);
      offset += group.additional.length;
      return { main, additional };
    });
  }
  components.forEach((c, i) => {
    const s = section(mounts[i], c.label || "输入");
    if (c.kind === "text") {
      const t = element("textarea", s);
      t.setAttribute("aria-label", c.label || "文本输入");
      t.placeholder = c.placeholder || (c.label || "输入消息") + "…";
      inputValues[i] = c.value ?? "";
      t.value = inputValues[i];
      const mainInput = mounts[i].classList.contains("main-input");
      const resize = () => {
        if (!mainInput) return;
        t.style.height = "auto";
        const height = Math.min(180, Math.max(44, t.scrollHeight));
        t.style.height = height + "px";
        t.style.overflowY = t.scrollHeight > 180 ? "auto" : "hidden";
      };
      t.oninput = () => { inputValues[i] = t.value; resize(); };
      if (mainInput) {
        mounts[i].classList.add("text-main-input");
        mounts[i].addEventListener("click", event => {
          if (event.target === mounts[i] || event.target === s) t.focus();
        });
        requestAnimationFrame(resize);
      }
      return;
    }
    if (c.kind === "number") {
      const field = element("input", s);
      field.type = "number";
      field.step = "any";
      field.setAttribute("aria-label", c.label);
      if (c.minimum !== null) field.min = c.minimum;
      if (c.maximum !== null) field.max = c.maximum;
      field.value = c.value ?? "";
      inputValues[i] = c.value;
      field.oninput = () =>
        (inputValues[i] = field.value === "" ? null : field.valueAsNumber);
      return;
    }
    if (c.kind === "select" && mounts[i].classList.contains("pill-editor")) {
      const panel = mounts[i];
      panel.classList.add("select-editor");
      inputValues[i] = c.value;
      const renderOptions = () => {
      s.replaceChildren();
      element("label", s, c.label);
      if (c.refreshable) {
        const reload = element("button", s, "刷新音色 / 选项");
        reload.type = "button";
        reload.className = "select-refresh";
        reload.onclick = async () => {
          reload.disabled = true; reload.textContent = "正在刷新…";
          try {
            const response = await fetch("refresh", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({index: i})});
            const updated = await response.json();
            if (!response.ok) throw Error(updated.error || "刷新失败");
            Object.assign(c, updated);
            inputValues[i] = c.value;
            renderOptions();
          } catch (error) {
            reload.disabled = false; reload.textContent = "重试刷新";
            const message = s.querySelector(".select-refresh-error") || element("p", s);
            message.className = "select-refresh-error"; message.textContent = error.message;
          }
        };
      }
      if (!c.choices.length) {
        element("p", s, c.placeholder || "暂无可选项，请先配置可用选项").className = "select-empty";
        return;
      }
      const list = element("div", s);
      list.className = "select-options";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", c.label || "选项");
      if (c.multiple) list.setAttribute("aria-multiselectable", "true");
      const options = [];
      const refresh = () => options.forEach((button, n) => {
        const chosen = c.multiple ? inputValues[i].includes(c.choices[n]) : inputValues[i] === c.choices[n];
        button.setAttribute("aria-selected", String(chosen));
        button.lastChild.textContent = chosen ? "✓" : "";
      });
      c.choices.forEach(choice => {
        const button = element("button", list);
        button.type = "button";
        button.className = "select-option";
        button.setAttribute("role", "option");
        element("span", button, c.labels?.[choice] ?? choice);
        element("span", button).setAttribute("aria-hidden", "true");
        options.push(button);
        button.onclick = () => {
          inputValues[i] = c.multiple
            ? (inputValues[i].includes(choice) ? inputValues[i].filter(v => v !== choice) : [...inputValues[i], choice])
            : choice;
          refresh();
          if (!c.multiple) {
            panel.hidePopover();
            document.querySelector(`[aria-controls="${panel.id}"]`)?.focus();
          }
        };
        button.onkeydown = event => {
          const n = options.indexOf(button);
          let next;
          if (event.key === "ArrowDown") next = (n + 1) % options.length;
          if (event.key === "ArrowUp") next = (n - 1 + options.length) % options.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = options.length - 1;
          if (next !== undefined) { event.preventDefault(); options[next].focus(); }
        };
      });
      refresh();
      };
      renderOptions();
      return;
    }
    if (c.kind === "select") {
      const field = element("select", s);
      field.multiple = c.multiple;
      if (!c.choices.length) {
        element("option", field, c.placeholder || "暂无可选项");
        field.disabled = true;
        element("small", s, c.placeholder || "请先配置可用选项");
      }
      field.setAttribute("aria-label", c.label);
      for (const choice of c.choices) {
        const option = element("option", field, c.labels?.[choice] ?? choice);
        option.value = choice;
        option.selected = c.multiple
          ? c.value.includes(choice)
          : c.value === choice;
      }
      inputValues[i] = c.value;
      field.onchange = () =>
        (inputValues[i] = c.multiple
          ? Array.from(field.selectedOptions, (o) => o.value)
          : field.value);
      return;
    }
    if (c.kind === "table") {
      inputValues[i] = [];
      const wrap = element("div", s);
      wrap.className = "table-scroll";
      const table = element("table", wrap),
        header = element("tr", element("thead", table));
      for (const name of c.columns) element("th", header, name);
      element("th", header, "操作");
      const body = element("tbody", table);
      function draw() {
        body.replaceChildren();
        inputValues[i].forEach((row, index) => {
          const tr = element("tr", body);
          row.forEach((value, j) => {
            const input = element("input", element("td", tr));
            input.value = value;
            input.setAttribute("aria-label", c.columns[j] + " " + (index + 1));
            input.oninput = () => (row[j] = input.value);
          });
          const remove = element("button", element("td", tr), "删除");
          remove.onclick = () => {
            inputValues[i].splice(index, 1);
            pillUpdates.get(i)?.(inputValues[i]);
            draw();
          };
        });
      }
      const append = element("button", s, "添加一行");
      append.onclick = () => {
        inputValues[i].push(c.columns.map(() => ""));
        pillUpdates.get(i)?.(inputValues[i]);
        draw();
      };
      return;
    }
    inputValues[i] = null;
    const player = ToolkitsContent.audio(s);
    player.hidden = true;
    s.classList.add("audio-input-card");
    const hint = element("p", s, "上传音频文件，或直接录制一段声音。");
    hint.className = "audio-empty-hint";
    const actions = element("div", s);
    actions.className = "audio-actions";
    const compact = mounts[i].classList.contains("main-input");
    const autoSubmit = compact && schema.inputs.length === 1 && schema.submit === "audio";
    if (compact) s.classList.add("compact-audio-input");
    if (compact && schema.inputs.length > 1) s.classList.add("multiple-audio-input");
    const menuTrigger = element("button", actions, "☰");
    menuTrigger.className = "audio-source-trigger";
    menuTrigger.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></svg>';
    menuTrigger.setAttribute("aria-label", "选择音频输入");
    const menu = element("div", actions);
    menu.className = "audio-source-menu";
    menu.setAttribute("popover", "auto");
    menuTrigger.onclick = () => {
      menu.showPopover();
      const rect = menuTrigger.getBoundingClientRect();
      menu.style.left = rect.left + "px";
      menu.style.top = Math.max(8, rect.top - menu.offsetHeight - 8) + "px";
    };
    menu.addEventListener("toggle", () => menuTrigger.setAttribute("aria-expanded", String(menu.matches(":popover-open"))));
    const currentSource = element("span", actions, c.sources.includes("microphone") ? "麦克风" : "上传音频");
    currentSource.className = "audio-current-source";
    let audioSource = c.sources.includes("microphone") ? "microphone" : "system";

    const info = element("small", s),
      canvas = element("canvas", s);
    canvas.hidden = true;
    canvas.width = 800;
    canvas.height = 64;
    let transcriptField;
    if (c.transcript) {
      const wrap = section(s, "参考文本");
      wrap.className = "audio-transcript";
      transcriptField = element("textarea", wrap);
      transcriptField.placeholder = "填写音频中实际说出的内容，可在这里校正";
      transcriptField.setAttribute(
        "aria-label",
        (c.label || "音频") + "的参考文本",
      );
      transcriptField.disabled = true;
      element("small", wrap, "尚未接入自动识别，请填写与录音对应的文本。");
      transcriptField.oninput = () => {
        if (inputValues[i]) inputValues[i].transcript = transcriptField.value;
      };
    }
    const remove = element("button", s, "移除音频");
    remove.className = "audio-remove";
    remove.hidden = true;
    remove.onclick = () => {
      generation++;
      player.pause();
      player.removeAttribute("src");
      player.load();
      player.hidden = true;
      canvas.hidden = true;
      hint.hidden = false;
      info.textContent = "";
      remove.hidden = true;
      inputValues[i] = null;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      if (transcriptField) {
        transcriptField.value = "";
        transcriptField.disabled = true;
      }
    };
    audioResets.set(i, () => remove.onclick());
    let objectUrl,
      generation = 0;
    async function accept(file) {
      const current = ++generation;
      if (transcriptField) {
        transcriptField.value = "";
        transcriptField.disabled = true;
      }
      inputValues[i] = null;
      try {
        if (file.size > 32 * 1024 * 1024) throw Error("音频不能超过 32 MiB");
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        if (current !== generation) return;
        inputValues[i] = {
          name: file.name,
          mimeType: file.type,
          data: data.split(",")[1],
        };
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(file);
        if (transcriptField) {
          inputValues[i].transcript = "";
          transcriptField.disabled = false;
        }
        player.src = objectUrl;
        player.hidden = false;
        canvas.hidden = false;
        hint.hidden = true;
        remove.hidden = false;
        info.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KiB`;
        const context = new AudioContext();
        try {
          const decoded = await context.decodeAudioData(
            await file.arrayBuffer(),
          );
          if (current !== generation) return;
          info.textContent += ` · ${decoded.duration.toFixed(2)} 秒 · ${decoded.sampleRate} Hz（浏览器解码） · ${decoded.numberOfChannels} 声道`;
          const values = decoded.getChannelData(0),
            g = canvas.getContext("2d");
          g.clearRect(0, 0, 800, 64);
          g.strokeStyle = "#19714d";
          g.beginPath();
          for (let x = 0; x < 800; x++) {
            const start = Math.floor((x * values.length) / 800),
              end = Math.max(
                start + 1,
                Math.floor(((x + 1) * values.length) / 800),
              );
            let peak = 0;
            for (let j = start; j < end; j++)
              peak = Math.max(peak, Math.abs(values[j] || 0));
            g.moveTo(x, 32 - peak * 30);
            g.lineTo(x, 32 + peak * 30);
          }
          g.stroke();
        } finally {
          await context.close();
        }
        if (autoSubmit && !leaving && current === generation) void submit(structuredClone(Array.from(inputValues)));
      } catch (e) {
        status(e.message);
      }
    }
    if (c.sources.includes("upload")) {
      const upload = element("input", actions);
      upload.hidden = true;
      const pick = element("button", menu, "上传音频");
      pick.className = "audio-upload-button";
      pick.onclick = () => { menu.hidePopover(); upload.click(); };
      upload.type = "file";
      upload.accept = "audio/*";
      upload.setAttribute("aria-label", c.label || "上传音频");
      upload.onchange = () => {
        if (upload.files[0]) void accept(upload.files[0]);
      };
    }
    if (c.sources.includes("microphone") || c.sources.includes("system")) {
      for (const [source, label] of [["microphone", "麦克风"], ["system", "电脑音频"]]) {
        if (!c.sources.includes(source)) continue;
        const option = element("button", menu, label);
        option.onclick = () => { audioSource = source; currentSource.textContent = label; menu.hidePopover(); };
      }
      const record = element("button", actions, "开始录音");
      record.className = "audio-record-button";
      const setRecording = active => {
        record.innerHTML = active ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3m-3 0h6"/></svg>';
        $("run").disabled = active || running;
        record.setAttribute("aria-label", active ? "停止录音" : "开始录音");
        record.title = active ? "停止录音" : "开始录音";
        record.classList.toggle("recording", active);
        menuTrigger.disabled = active;
      };
      setRecording(false);
      let stop;
      window.addEventListener("message", event => {
        if (toolkitsHost.isHostEvent(event) && event.data?.type === "toolkits-system-audio-ended" && audioSource === "system") stop?.();
      });
      record.onclick = async () => {
        if (stop) {
          stop();
          return;
        }
        if (c.streaming) {
          if (running) return;
          record.disabled = true;
          try {
            const callbacks = beginStreamingTurn(i);
            const capture = await ToolkitsStreaming.capture({
              source: audioSource, systemAudio,
              ...callbacks,
              onStart: () => { callbacks.onStart(); setRecording(true); record.disabled = false; },
              onFinish: async data => { stop = null; await callbacks.onFinish(data); setRecording(false); record.disabled = false; },
              onError: async (error, data) => { stop = null; await callbacks.onError(error, data); setRecording(false); record.disabled = false; },
            });
            if (running) stop = () => { stop = null; record.disabled = true; status(""); void capture.stop(); };
          } catch (error) { record.disabled = false; status(error.message); }
          return;
        }
        record.disabled = true;
        if (transcriptField) {
          transcriptField.value = "";
          transcriptField.disabled = true;
        }
        inputValues[i] = null;
        let stream, context;
        try {
          if (audioSource === "system" && window.parent !== window) {
            await systemAudio("start");
            setRecording(true); record.disabled = false;
            stop = () => {
              stop = null; record.disabled = true;
              void systemAudio("stop").then(async result => {
                const blob = await (await fetch(result.data)).blob();
                await accept(new File([blob], result.name, { type: "audio/wav" }));
              }).catch(e => status(e.message)).finally(() => { setRecording(false); record.disabled = false; });
            };
            return;
          }
          if (audioSource === "system") {
            if (!navigator.mediaDevices.getDisplayMedia) throw Error("此浏览器不支持电脑音频，请在 Toolkits 中打开");
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            if (!stream.getAudioTracks().length) throw Error("未共享音频，请选择支持音频共享的窗口或标签页");
          } else stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          context = new AudioContext();
          await context.resume();
          const source = context.createMediaStreamSource(stream),
            node = context.createScriptProcessor(4096, 1, 1),
            chunks = [];
          let count = 0;
          node.onaudioprocess = (e) => {
            chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
            count += 4096;
            if (count > context.sampleRate * 300) stop?.();
          };
          source.connect(node);
          node.connect(context.destination);
          setRecording(true);
          stop = () => {
            stop = null;
            node.disconnect();
            source.disconnect();
            stream.getTracks().forEach((t) => t.stop());
            const file = wav(chunks, context.sampleRate);
            void context.close();
            setRecording(false);
            void accept(file);
          };
          record.disabled = false;
        } catch (e) {
          stream?.getTracks().forEach((t) => t.stop());
          void context?.close();
          record.disabled = false;
          status(`录音失败：${e.message}`);
        }
      };
      window.addEventListener("pagehide", () => {
        if (stop && !c.streaming) stop();
      });
    }
    if (compact && schema.inputs.length === 1) {
      if (autoSubmit) $("run").hidden = true;
      else actions.append($("run"));
      s.parentElement.append($("status"));
      document.querySelector(".composer-bar").hidden = true;
    }
  });

  function render(parent, c, v, context = "message") {
    return ToolkitsContent.render(parent, ToolkitsContent.content(c, v), context);
  }
  const resizeHandle = $("detail-resize");
  const detailPanel = $("result-detail");
  const workspace = document.querySelector(".agent-workspace");
  const resizeDetail = (width) => {
    const limit = Math.max(240, workspace.clientWidth - 300);
    const next = Math.max(240, Math.min(limit, width));
    detailPanel.style.setProperty("--detail-width", next + "px");
    resizeHandle.setAttribute("aria-valuenow", String(Math.round(next)));
  };
  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeHandle.setPointerCapture(event.pointerId);
    resizeHandle.classList.add("dragging");
  });
  resizeHandle.addEventListener("pointermove", (event) => {
    if (resizeHandle.hasPointerCapture(event.pointerId))
      resizeDetail(workspace.getBoundingClientRect().right - event.clientX);
  });
  const finishResize = () => resizeHandle.classList.remove("dragging");
  resizeHandle.addEventListener("lostpointercapture", finishResize);
  resizeHandle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    resizeDetail(detailPanel.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 20 : -20));
  });
  let captionTarget = null;
  const captionText = new Map();
  function sendCaption(action, reply) {
    if (window.parent === window) { status("置顶字幕请在 Toolkits 桌面中打开"); return; }
    const requestId = crypto.randomUUID();
    if (action === "open") {
      const timeout = setTimeout(() => { window.removeEventListener("message", receive); status("字幕窗口未响应，请更新 Toolkits 桌面"); }, 5000);
      function receive(event) {
        if (!toolkitsHost.isHostEvent(event) || event.data?.type !== "toolkits-captions-result" || event.data.requestId !== requestId) return;
        clearTimeout(timeout); window.removeEventListener("message", receive);
        if (event.data.error) status(event.data.error);
      }
      window.addEventListener("message", receive);
    }
    toolkitsHost.post({type:"toolkits-captions", action, text:captionText.get(reply) || "", requestId});
  }
  function captionButton(section, reply) {
    if (!schema.streaming) return;
    section.classList.add("has-caption-button");
    const button = element("button", section);
    button.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 3h6v6M17 3l-8 8M8 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4"/></svg>';
    button.className = "caption-output-button";
    button.title = "打开置顶实时字幕";
    button.setAttribute("aria-label", "打开实时字幕");
    button.onclick = () => { captionTarget = reply; sendCaption("open", reply); };
  }
  let selectedReply;
  const completedTurns = new Map();
  let historySave = Promise.resolve();
  function saveHistory() {
    const body = JSON.stringify({turns: Array.from(completedTurns.values())});
    historySave = historySave.catch(() => {}).then(async () => {
      const response = await fetch("history", {method: "POST", headers: {"Content-Type": "application/json"}, body});
      if (!response.ok) throw Error("对话保存失败，请勿关闭页面");
    });
    return historySave;
  }
  function renderInspectable(parent, block, context = "message") {
    const section = ToolkitsContent.render(parent, block, context);
    if (context === "parameter" && block.kind !== "audio") return section;
    if (section.hidden) return section;
    if (block.kind === "audio") section.classList.add("audio-message-row");
    const inspect = element("button", section, block.kind === "table" ? (block.label || "查看数据") + " ↗" : "查看详情 ↗");
    inspect.className = "result-inspect";
    inspect.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12"/></svg>';
    inspect.title = block.label ? "查看" + block.label + "详情" : "查看详情";
    inspect.setAttribute("aria-label", inspect.title);
    section.classList.add("inspectable-content");
    inspect.onclick = () => showDetail(block, section);
    return section;
  }
  function renderReply(content, reply, record) {
    const blocks = record.messages?.[1]?.content || [];
    captionText.set(reply, blocks.filter(block => block.kind === "text").map(block => String(block.value || "")).join("\n"));
    let attachedCaption = false;
    blocks.forEach(block => {
      const section = renderInspectable(content, block);
      if (block.kind === "text" && !attachedCaption) { captionButton(section, reply); attachedCaption = true; }
    });
    if (captionTarget === reply) sendCaption("update", reply);
    if (!record.outputs) element("p", content, record.error || "上次处理已中断，请重新提交").className = "error";
  }
  function showDetail(block, section) {
    selectedReply = section;
    document.querySelector(".agent-workspace").classList.add("detail-open");
    $("result-detail").hidden = false;
    $("detail-content").replaceChildren();
    const heading = document.querySelector(".detail-heading strong");
    if (heading) heading.textContent = ({audio:"音频详情", text:"文本详情", table:"数据详情", number:"数值详情"})[block.kind] || "内容详情";
    document.querySelectorAll(".result.selected").forEach(item => item.classList.remove("selected"));
    section?.classList.add("selected");
    const rendered = ToolkitsContent.render($("detail-content"), block, "detail");
    if (block.kind === "text") {
      const copy = element("button", rendered, "复制文本");
      copy.className = "detail-copy";
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(String(block.value ?? "")); copy.textContent = "已复制"; }
        catch { copy.textContent = "复制失败，请手动选择文本"; }
      };
    }
  }
  $("close-detail").onclick = () => {
    selectedReply = null;
    $("result-detail").hidden = true;
    document.querySelector(".agent-workspace").classList.remove("detail-open");
    document.querySelectorAll(".result.selected").forEach(item => item.classList.remove("selected"));
  };
  function scroll() {
    $("history").scrollTop = $("history").scrollHeight;
  }
  function beginStreamingTurn(index) {
    running = true; status(""); $("clear").disabled = true; $("run").disabled = true;
    $("welcome")?.remove();
    const turn = element("article", $("history")); turn.className = "turn";
    const user = element("div", turn); user.className = "message user";
    const captureState = element("p", user, "正在连接麦克风与识别服务…");
    const reply = element("div", turn); reply.className = "message assistant";
    const content = element("div", reply);
    const pending = element("section", content); pending.className = "result inspectable-content";
    element("p", pending, "等待语音…").className = "pending";
    captionButton(pending, reply);
    let values = [null], outputs = null;
    const finish = async (data, error) => {
      try {
        const file = wav(data.chunks, data.sampleRate);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
        values = [{name:"recording.wav", mimeType:"audio/wav", data:btoa(binary)}];
        user.replaceChildren();
        renderInspectable(user, ToolkitsContent.content(components[index], values[0]));
        outputs = data.outputs || outputs;
        const record = {inputs:values, outputs, error:error?.message, messages:[
          ToolkitsContent.message("user", components, values),
          ToolkitsContent.message("assistant", schema.outputs, outputs || schema.outputs.map(c => c.kind === "table" ? [] : "")),
        ]};
        completedTurns.set(reply, record);
        content.replaceChildren();
        if (error) element("p", content, error.message).className = "error";
        renderReply(content, reply, record);
        await saveHistory();
        status(error ? "识别中断，已保留录音和已有结果" : "");
      } catch (failure) { status(failure.message); }
      finally { running = false; $("clear").disabled = false; $("run").disabled = false; scroll(); }
    };
    return {
      onStart() { captureState.textContent = "正在录音…"; status(""); },
      onUpdate(next) {
        outputs = next; content.replaceChildren();
        renderReply(content, reply, {outputs:next,messages:[null,ToolkitsContent.message("assistant",schema.outputs,next)]});
        scroll();
      },
      onFinish: data => finish(data),
      onError: (error, data) => finish(data, error),
    };
  }
  async function submit(values, existing) {
    if (running) return;
    if (
      components.some((c, i) => values[i] === null || values[i] === undefined)
    ) {
      status("请先补充输入内容");
      return;
    }
    running = true;
    $("run").disabled = true;
    $("clear").disabled = true;
    $("inputs")
      .querySelectorAll(":popover-open")
      .forEach((p) => p.hidePopover());
    $("inputs").disabled = true;
    status("正在处理…");
    $("welcome")?.remove();
    let reply = existing;
    if (!reply) {
      const turn = element("article", $("history"));
      turn.className = "turn";
      const user = element("div", turn);
      user.className = "message user";

      const inputMessage = ToolkitsContent.message("user", components, values);
      inputMessage.content.forEach((block, i) => renderInspectable(user, block, mounts[i].classList.contains("main-input") ? "message" : "parameter"));
      reply = element("div", turn);
      reply.className = "message assistant";
    }
    completedTurns.set(reply, { inputs: values, outputs: null });
    if (!existing) components.forEach((c, i) => {
      if (c.kind === "audio" && mounts[i].classList.contains("main-input")) audioResets.get(i)?.();
    });
    reply.replaceChildren();

    const content = element("div", reply);
    element("p", content, "正在处理…").className = "pending";
    reply.setAttribute("aria-busy", "true");
    scroll();
    try {
      const r = await fetch("run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: pack(values) }),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || "处理失败");
      if (
        !Array.isArray(result.outputs) ||
        result.outputs.length !== schema.outputs.length
      )
        throw Error("返回结果与组件定义不一致");
      content.replaceChildren();
      completedTurns.set(reply, { inputs: values, outputs: result.outputs, messages: [
        ToolkitsContent.message("user", components, values),
        ToolkitsContent.message("assistant", schema.outputs, result.outputs),
      ] });
      renderReply(content, reply, completedTurns.get(reply));
      if (!existing) {
        components.forEach((c, i) => {
          if (c.kind === "text" && mounts[i].classList.contains("main-input"))
            inputValues[i] = "";
        });
        $("inputs")
          .querySelectorAll(".main-input textarea")
          .forEach((field) => { field.value = ""; field.dispatchEvent(new Event("input")); });
      }
      status("处理完成");
    } catch (e) {
      content.replaceChildren();
      completedTurns.set(reply, { inputs: values, outputs: null, error: "处理失败：" + e.message });
      element("p", content, "处理失败：" + e.message).className = "error";
      const retry = element("button", content, "重试");
      retry.onclick = () => submit(values, reply);
      status("处理失败，可在消息中重试");
    } finally {
      running = false;
      $("run").disabled = false;
      $("clear").disabled = false;
      $("inputs").disabled = false;
      reply.setAttribute("aria-busy", "false");
      try { await saveHistory(); } catch (error) { status(error.message); }
      scroll();
    }
  }
  try {
    const response = await fetch("history");
    if (!response.ok) throw Error("历史记录读取失败");
    const saved = await response.json();
    for (const record of saved.turns || []) {
      if (!Array.isArray(record.inputs)) continue;
      $("welcome")?.remove();
      const turn = element("article", $("history")); turn.className = "turn";
      const user = element("div", turn); user.className = "message user";
      const blocks = record.messages?.[0]?.content || ToolkitsContent.message("user", components, record.inputs).content;
      blocks.forEach((block, i) => renderInspectable(user, block, mounts[i]?.classList.contains("main-input") ? "message" : "parameter"));
      const reply = element("div", turn); reply.className = "message assistant";
      completedTurns.set(reply, record);
      renderReply(element("div", reply), reply, record);
    }
    scroll();
  } catch (error) { status(error.message); }
  $("clear").disabled = false;
  $("clear").onclick = async () => {
    if (running) return;
    $("history").replaceChildren();
    completedTurns.clear();
    if (captionTarget) sendCaption("stop", captionTarget);
    captionTarget = null; captionText.clear();
    $("close-detail").click();
    try { await saveHistory(); status(schema.streaming ? "" : "对话已清空"); } catch (error) { status(error.message); }
  };
  $("run").disabled = false;
  $("run").onclick = () => submit(structuredClone(Array.from(inputValues)));
  document.querySelector("footer").addEventListener("keydown", (event) => {
    if (
      event.target.tagName === "TEXTAREA" &&
      event.target.closest(".main-input") &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing && event.keyCode !== 229
    ) {
      event.preventDefault();
      $("run").click();
    }
  });
}
setup().catch((e) => status(e.message));
