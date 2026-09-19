## Overview
DAMO Academy's ZipEnhancer targets 16 kHz mono speech. It is just 10 MB and preserves duration after denoising.

## Use cases
- Speech enhancement before recognition
- Clean up meeting and phone recordings
- Segmented denoising of long audio

## Languages and capabilities
- Language-independent
- 16 kHz mono; supports segmented processing of long audio

## Usage tips
- For high-sample-rate music or full-band audio, use DeepFilterNet3.
- Output can feed directly into SenseVoice, Paraformer, and other recognition models.

## Source and license
- Publisher: Alibaba DAMO Academy · License: Apache-2.0
- Runtime: onnxruntime · Precision: FP32 · Size: about 10 MB
