## Overview
GTCRN is an extremely lightweight speech-denoising network (about 1 MB). It runs locally with sherpa-onnx to remove steady background noise while preserving speech.

## Use cases
- Fast denoising of recordings
- Remove background hiss and fan noise before recognition
- Devices where size and startup speed matter

## Languages and capabilities
- Language-independent; processes mono speech
- File processing, extensible to real-time streams

## Usage tips
- Limited with strong noise or mixed music. Consider DeepFilterNet3 or ZipEnhancer.
- Output duration matches input and can feed directly into recognition.

## Source and license
- Authors: Xiaobin Rong et al. · Runtime: sherpa-onnx
- Precision: FP32 · Size: about 1 MB
