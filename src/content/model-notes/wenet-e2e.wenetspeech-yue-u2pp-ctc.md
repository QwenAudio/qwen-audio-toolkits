## 简介
基于 WeNet U2++ Conformer、在 WeNetSpeech-Yue 数据上训练的粤语识别模型，同时覆盖普通话与英文。

## 适用场景
- 粤语视频、播客与访谈转写
- 港澳地区会议记录
- VAD 分段后的准实时识别

## 语言与能力
- 语言：粤语、中文、英文
- CTC 解码，输出时间戳

## 使用建议
- 建议搭配 VAD 分段处理长音频
- 纯普通话内容可优先考虑 SenseVoice 或 Paraformer

## 来源与许可
- 发布方：WeNet · 许可：Apache-2.0
- 运行时：sherpa-onnx · 精度：INT8 · 体积：约 112 MB
