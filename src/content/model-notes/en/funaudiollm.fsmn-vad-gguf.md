## Overview
The official GGUF version of FunASR's FSMN voice activity detector is just 2 MB and outputs speech intervals with millisecond precision.

## Use cases
- Split long audio automatically before recognition
- Trim silence and measure active speech
- A segmentation node before recognition in workflows

## Languages and capabilities
- Language-independent
- Speech segment intervals with millisecond precision

## Usage tips
- Recommended companion for GGUF recognition models such as SenseVoice and Paraformer.
- Runs independently to inspect the distribution of speech in recordings.

## Source and license
- Publisher: FunAudioLLM · License: Apache-2.0
- Runtime: llama-funasr · Precision: F32 · Size: about 2 MB
