export async function getMicrophoneStream(
  constraints: MediaTrackConstraints,
): Promise<MediaStream> {
  const getUserMedia = navigator.mediaDevices?.getUserMedia
  if (!getUserMedia) {
    throw new Error(
      '当前安装环境未提供麦克风采集能力，请更新并重新启动 QwenAudio Toolkits',
    )
  }

  try {
    return await getUserMedia.call(navigator.mediaDevices, {
      audio: constraints,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error(
        '麦克风权限未开启，请在“系统设置 > 隐私与安全性 > 麦克风”中允许 QwenAudio Toolkits',
      )
    }
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new Error('没有找到可用的麦克风')
    }
    throw error
  }
}
