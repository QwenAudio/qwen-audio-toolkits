## Overview
This local Fun-CosyVoice3 0.5B version runs on CPU with CosyVoice.cpp and GGUF. It supports zero-shot voice cloning without Python or cloud APIs.

## Use cases
- Clone a voice from a few seconds of reference audio and read text
- Offline voiceovers for privacy-sensitive content
- Multilingual narration and character voices

## Languages and capabilities
- Multilingual zero-shot synthesis
- Voice cloning: reference audio + reference text

## Usage tips
- Use SenseVoice Small GGUF to transcribe the reference audio automatically.
- Q5_K_M (about 970 MB) is smaller; Q8_0 (about 1.2 GB) offers more consistent audio quality.
- CPU synthesis is slower than cloud CosyVoice. Allow more time for long text.

## Source and license
- Publisher: FunAudioLLM · License: Apache-2.0
- Runtime: cosyvoice.cpp · Version: 2512
