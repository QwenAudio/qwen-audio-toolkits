## Overview
The first-generation FireRedASR AED (attention encoder-decoder) model provides high-quality Chinese and English recognition plus some Chinese dialects. It is large and slower on CPU.

## Use cases
- Accuracy-focused offline Chinese and English transcription
- Mixed Mandarin and dialect content
- High-quality non-real-time documents

## Languages and capabilities
- Languages: Mandarin Chinese, English, and some dialects
- Accuracy-focused AED architecture

## Usage tips
- INT8 is about 1.75 GB and requires more memory. Prefer FireRedASR2 CTC for everyday use.
- Segment long audio with VAD to control memory use.

## Source and license
- Publisher: FireRedTeam · Runtime: sherpa-onnx
- Precision: INT8 · Version: 2025-02-16
