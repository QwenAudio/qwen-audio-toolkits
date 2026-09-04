## 简介
Deezer Spleeter 的 2 stems 版本，将混合音频分离为人声与伴奏两轨。

## 适用场景
- 提取歌曲人声或伴奏
- 去除背景音乐后再做语音识别
- 视频配乐替换

## 语言与能力
- 与语言无关
- 输出人声、伴奏两条独立音轨

## 使用建议
- INT8（约 50 MB）最快；FP32（约 180 MB）分离更干净
- 双人对话分离请使用 MossFormer2

## 来源与许可
- 发布方：k2-fsa（基于 Deezer Spleeter） · 运行时：sherpa-onnx
- 精度：INT8 / FP16 / FP32
