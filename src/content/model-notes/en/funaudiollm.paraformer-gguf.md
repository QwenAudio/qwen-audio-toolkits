## Overview
The official GGUF version of non-autoregressive Paraformer outputs a full sentence in one forward pass, suitable for high-throughput offline batch transcription.

## Use cases
- Batch transcription of Chinese and English recordings
- Speed-sensitive offline processing
- Caption and document generation

## Languages and capabilities
- Languages: Chinese and English
- Fast, high-throughput non-autoregressive decoding

## Usage tips
- Default Q8 is about 226 MB; F16 / F32 provide greater precision.
- Output has no punctuation. Pair with Chinese/English punctuation restoration.

## Source and license
- Publisher: FunAudioLLM · License: Apache-2.0
- Runtime: llama-funasr · Precision: Q8 / F16 / F32
