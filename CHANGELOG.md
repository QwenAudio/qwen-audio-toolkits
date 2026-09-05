# Changelog

All notable user-facing changes are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- GitHub Release automation for Apple Silicon DMG builds, signed updater
  artifacts, and `latest.json` publishing.
- Public installation, release, model-catalog, and privacy documentation.

### Changed

- Native macOS window controls have more balanced titlebar insets. Desktop
  commands prefer an installed Xcode 26+ SDK over older Command Line Tools
  so local Tahoe builds use the current native control appearance.
- Model installation now accepts declared directories as well as files and
  reports download and dependency progress consistently.
- The unavailable Fun Audio Music Separation cloud model was removed from the
  model store while local source-separation support remains available.

## 0.1.20 - 2026-08-07

### Changed

- Sidebar model groups now collapse by clicking the category row without a
  separate chevron indicator.
- Model labels align with category labels and expanded groups use a subtle
  vertical guide to show their contained models.

## 0.1.19 - 2026-08-07

### Changed

- The model sidebar can now be resized up to a fixed 520 px instead of using
  the longest installed model name as its maximum width.

## 0.1.18 - 2026-08-07

### Fixed

- Bailian TTS result downloads now upgrade temporary HTTP URLs to HTTPS and
  retry transient transport or server failures up to three times.
- Remote download errors no longer expose signed temporary URLs in the UI.

## 0.1.17 - 2026-08-07

### Added

- Chinese and English open-source documentation, architecture and model-catalog
  guides, contribution templates, privacy policy, and community metadata.
- PCM16 validation for generated audio in the installed-model smoke suite.

### Changed

- Audio artifacts are normalized through one shared WebView compatibility layer
  before playback, waveform rendering, and Mel spectrogram analysis.
- Model and runtime license metadata is included in the remote catalog.

### Fixed

- Fun-CosyVoice3 no longer leaves IEEE-float WAV outputs that WebKit may play
  but fail to decode for Mel spectrograms.
- Existing float-WAV history is converted in memory when opened, so old results
  remain inspectable without regeneration.

## 0.1.16 - 2026-08-06

Initial public-preview baseline.

### Added

- Local and cloud model store with on-demand model installation and variants.
- Capability-driven conversations for audio processing, understanding,
  generation, and text processing.
- Shared waveform, Mel spectrogram, timestamp, speaker-segment, and runtime
  result views.
- Streaming microphone and macOS system-audio sessions for supported models.
- Signed in-app updater artifacts for Apple Silicon test releases.

### Changed

- Model dependency bindings are persisted by the Rust backend.
- Referenced dependency weights are retained and hidden instead of deleted.
- Local models are runnable whenever installed and load only when requested.
- Audio tagging is grouped under audio understanding.

### Fixed

- Unified local deletion behavior across the sidebar, model store, and local
  API.
- Removed stale provider and runtime entries from the model store.
- Improved compact-window playback, result details, and empty conversation
  presentation.
