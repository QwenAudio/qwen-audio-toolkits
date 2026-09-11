## Overview
The official SenseVoice Small GGUF runtime produces text together with language, emotion, and audio-event tags, offering a balanced choice for local multilingual recognition.

## Use cases
- Mixed Chinese, English, Japanese, Korean, and Cantonese transcription
- Analysis needing rich tags such as emotion, laughter, and applause
- Generate reference text for voice cloning

## Languages and capabilities
- Languages: Chinese, English, Japanese, Korean, and Cantonese
- Automatic language detection, emotion tags, and audio-event tags

## Usage tips
- Default Q8 (about 243 MB) suits most uses; F16 / F32 offer greater precision at larger sizes.
- The project includes FSMN-VAD GGUF segmentation resources; no extra VAD model is needed.

## Source and license
- Publisher: FunAudioLLM · License: Apache-2.0
- Runtime: llama-funasr · Precision: Q8 / F16 / F32
