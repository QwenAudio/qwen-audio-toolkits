# DeepFilterNet

Local speech enhancement for files and real-time streams, powered by the
DeepFilterNet3 model running fully on-device.

## 能力

- `audio.enhance` — 降噪与语音增强
- `audio.denoise` — 宽带噪声抑制
- `stream.processor` — 实时流处理

## 使用

1. 在「扩展」中安装本模型（约 18 MB）。
2. 将模型添加到工作台，即可在批处理、实时监听等场景中使用。

## 运行环境

- Python ≥ 3.11，worker 进程隔离运行
- macOS / Windows / Linux，CPU 即可运行（macOS 支持 Metal 加速）

## 许可

模型权重来自 [Rikorose/DeepFilterNet3](https://huggingface.co/Rikorose/DeepFilterNet3)，
插件代码采用 MIT 许可。
