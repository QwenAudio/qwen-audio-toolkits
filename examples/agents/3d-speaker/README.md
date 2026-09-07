# 3D-Speaker 声纹 Agent

从一段音频中提取声纹向量，也可以对比两段录音的声纹相似度。

## 使用

在桌面应用的 Agents 页面选择“导入 Agent”，选择本项目文件夹。
也可以将本目录打包为 ZIP，通过旁边的安装包按钮导入。首次安装下载约 28 MB 的 CAM++ ONNX 权重。
若相同 ID 已安装，不会覆盖原项目。

上传主音频后执行声纹提取；添加对比音频可查看余弦相似度。
建议使用清晰的单人语音。结果会受录音环境、内容和时长影响，不能用于身份认证结论。

## 项目组成

- CAM++ ONNX 模型，通过清单中的 HTTPS 地址和 SHA-256 安装到本项目目录。
- `speaker-embedding` Harness，使用宿主的 sherpa-onnx 执行器。
- 音频解码、单声道/采样率处理、声纹计算与结果展示由这一契约连接。
- 输入要求、使用示例和限制均在 `agent.json` 中声明。

不调用其他 Agent，不包含多人说话人分离或语音转写。
本版本采用宿主执行器，不运行任意项目脚本。

模型来源：[3D-Speaker CAM++](https://www.modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced)。上游模型卡声明 Apache License 2.0。
