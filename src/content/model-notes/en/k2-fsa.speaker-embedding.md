## Overview
The 3D-Speaker CAM++ model extracts speaker embeddings and compares the cosine similarity of two voice clips for speaker verification.

## Use cases
- Check whether two recordings feature the same speaker
- Enroll and compare speaker embeddings
- Match speakers to separated audio tracks

## Languages and capabilities
- Language-independent
- Speaker embeddings and similarity scores

## Usage tips
- Use at least 3 seconds of active speech per clip.
- Tune the similarity threshold for your use case. Noise and channel differences lower scores.

## Source and license
- Publisher: k2-fsa (based on 3D-Speaker) · Runtime: sherpa-onnx
- Precision: FP32 · Size: about 30 MB
