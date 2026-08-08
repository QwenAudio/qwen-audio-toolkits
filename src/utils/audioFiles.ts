const AUDIO_FILE_EXTENSION =
  /\.(wav|mp3|flac|m4a|aac|ogg|opus|webm|amr)$/i

export function isAudioFile(file: File): boolean {
  return (
    file.type.startsWith('audio/') ||
    AUDIO_FILE_EXTENSION.test(file.name)
  )
}

export function filterAudioFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(isAudioFile)
}
