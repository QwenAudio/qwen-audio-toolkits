## Overview
DAMO Academy's MossFormer2 separates two-speaker 8 kHz mono mixtures into individual tracks for speaker 1 and speaker 2.

## Use cases
- Separate overlapping speech in phone recordings
- Improve accuracy by recognizing each separated track
- Organize conversation data

## Languages and capabilities
- Language-independent
- Two speakers only; not for separating vocals and accompaniment

## Usage tips
- Input is resampled to 8 kHz, unsuitable for high-fidelity needs.
- For more than two speakers, use speaker diarization.

## Source and license
- Publisher: Alibaba DAMO Academy · License: Apache-2.0
- Runtime: onnxruntime · Precision: FP32 · Size: about 219 MB
