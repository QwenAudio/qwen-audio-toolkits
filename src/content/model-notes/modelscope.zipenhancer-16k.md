## 简介
达摩院 ZipEnhancer 语音降噪模型，面向 16 kHz 单声道语音，仅 10 MB，降噪后保留原始时长。

## 适用场景
- 识别前的语音增强
- 会议、电话录音清理
- 长音频分段降噪

## 语言与能力
- 与语言无关
- 16 kHz 单声道，支持长音频分段处理

## 使用建议
- 高采样率的音乐或全频带素材请用 DeepFilterNet3
- 输出可直接接入 SenseVoice、Paraformer 等识别模型

## 来源与许可
- 发布方：Alibaba DAMO Academy · 许可：Apache-2.0
- 运行时：onnxruntime · 精度：FP32 · 体积：约 10 MB
