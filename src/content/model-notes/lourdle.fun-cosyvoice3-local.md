## 简介
Fun-CosyVoice3 0.5B 的本地版本，基于 CosyVoice.cpp 与 GGUF 在 CPU 上运行，支持零样本音色克隆，无需 Python 或云端接口。

## 适用场景
- 用几秒参考音频克隆音色并朗读文本
- 隐私敏感的离线配音
- 多语言旁白与角色配音

## 语言与能力
- 多语言零样本合成
- 音色克隆：参考音频 + 参考文本

## 使用建议
- 推荐搭配 SenseVoice Small GGUF 自动识别参考音频文本
- Q5_K_M（约 970 MB）体积更小；Q8_0（约 1.2 GB）音质更稳
- CPU 合成速度慢于云端 CosyVoice，长文本请耐心等待

## 来源与许可
- 发布方：FunAudioLLM · 许可：Apache-2.0
- 运行时：cosyvoice.cpp · 版本：2512
