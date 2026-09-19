## Overview
Uses Whisper Tiny's language identification capability to detect the language of an audio clip offline.

## Use cases
- Automatically route multilingual audio
- Choose a suitable ASR model before recognition
- Clean up speech datasets

## Languages and capabilities
- Covers nearly 100 languages supported by Whisper
- Outputs only the language, not a transcript

## Usage tips
- The first 30 seconds are sufficient for identification.
- Very short clips and music-only audio may give unstable results.

## Source and license
- Publisher: k2-fsa (based on OpenAI Whisper) · Runtime: sherpa-onnx
- Precision: FP32 · Size: about 150 MB
