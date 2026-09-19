## Overview
Qwen3 TTS Voice Design performs speech synthesis using voices created from scratch via the qwen-voice-design service. You can create a custom voice from a natural-language description alone.

## Use cases
- Rapid prototyping and creative content production
- Game characters and animated figure dubbing
- Designing a unique virtual voice identity for a brand or application

## Languages and capabilities
- Voice descriptions support Chinese and English, up to 2048 characters
- Requires creating a custom voice through voice design first
- 24 kHz output

## Usage tips
- The more specific the description, the closer the generated voice will match your intent; combine dimensions such as gender, age, pitch, speed, and emotion.
- The target_model used when creating the voice must match the synthesis model.
- Listen to the returned preview audio first to confirm quality before using it for formal synthesis.
- Requires a Model Studio API Key; voice creation is billed per creation, synthesis by character.

## Source and license
- Provider: Alibaba Cloud Model Studio · Model ID: qwen3-tts-vd-2026-01-26
