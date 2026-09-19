## Overview
CT-Transformer restores Chinese and English punctuation offline, adding commas, periods, question marks, and more to unpunctuated transcripts.

## Use cases
- Postprocessing for unpunctuated models such as Paraformer and Zipformer
- Formatting captions and documents
- A text-cleanup node in workflows

## Languages and capabilities
- Languages: Chinese and English
- Plain-text input and output

## Usage tips
- INT8 (about 100 MB) is sufficient for everyday use; FP32 is about 400 MB.
- Works better before ITN number normalization.

## Source and license
- Publisher: k2-fsa · Runtime: sherpa-onnx
- Precision: INT8 / FP32
