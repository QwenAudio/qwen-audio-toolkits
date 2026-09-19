## Overview
A Zipformer-based Chinese streaming recognition model. It accepts continuous microphone input and returns incremental results and timestamps in real time.

## Use cases
- Live captions and meeting interpretation captions
- Voice input and conversations
- Continuous long-form dictation

## Languages and capabilities
- Language: Chinese
- Streaming recognition, incremental results, and character timestamps

## Usage tips
- Default INT8 (about 127 MB) has lower latency; FP32 (about 567 MB) is slightly more accurate.
- Pair with the Chinese/English punctuation restoration model when punctuation is needed.

## Source and license
- Publisher: k2-fsa · Runtime: sherpa-onnx
- Precision: INT8 / FP32 · Version: 2025-06-30
