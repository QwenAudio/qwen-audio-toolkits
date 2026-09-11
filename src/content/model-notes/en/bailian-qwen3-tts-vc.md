## Overview
Qwen3 TTS Voice Cloning performs high-fidelity speech synthesis using voices cloned via the qwen-voice-enrollment service. The same cloned voice can be used for output in 11 languages.

## Use cases
- Personalized brand announcements and virtual-character dubbing
- Custom voices for voice assistants
- Maintaining a consistent speaker voice across multilingual content

## Languages and capabilities
- One cloned voice supports 11 languages
- Requires creating a custom voice through voice cloning first
- 24 kHz output

## Usage tips
- For best results, use a 10-20 second clean, single-speaker sample without background noise.
- The target_model used when creating the voice must match the synthesis model.
- Requires a Model Studio API Key; voice creation is billed per creation, synthesis by character.

## Source and license
- Provider: Alibaba Cloud Model Studio · Model ID: qwen3-tts-vc-2026-01-22
