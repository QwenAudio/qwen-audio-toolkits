## Overview
Deezer Spleeter's 2-stem version separates mixed audio into vocals and accompaniment.

## Use cases
- Extract song vocals or accompaniment
- Remove background music before speech recognition
- Replace video background music

## Languages and capabilities
- Language-independent
- Two separate output tracks: vocals and accompaniment

## Usage tips
- INT8 (about 50 MB) is fastest; FP32 (about 180 MB) offers cleaner separation.
- For separating two speakers, use MossFormer2.

## Source and license
- Publisher: k2-fsa (based on Deezer Spleeter) · Runtime: sherpa-onnx
- Precision: INT8 / FP16 / FP32
