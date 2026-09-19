## Overview
RNNoise is Xiph.Org's established real-time denoising algorithm. This pure Rust implementation (nnnoiseless) has very low latency and resource use.

## Use cases
- Low-latency denoising for calls and meetings
- Microphone input preprocessing
- Frontend processing for live captions and wake-word streams

## Languages and capabilities
- Language-independent; processes 10 ms frames in real time
- Supports both files and live streams

## Usage tips
- For quality-focused offline cleanup, choose DeepFilterNet3.
- Input is processed at 48 kHz and output is restored to the original sample rate.

## Source and license
- Author: Xiph.Org · License: BSD-3-Clause
- Runtime: nnnoiseless (Rust) · Size: about 1 MB
