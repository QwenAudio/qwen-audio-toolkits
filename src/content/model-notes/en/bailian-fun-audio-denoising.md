## Overview
Alibaba Cloud Model Studio's Fun Audio Denoising service cleans recordings, recognition inputs, and voice-cloning samples, supporting long audio and common formats.

## Use cases
- Clean reference audio before voice cloning
- Denoise long meeting and interview recordings
- Batch processing when local computing power is limited

## Languages and capabilities
- Language-independent
- File processing; up to about 2 hours per request

## Usage tips
- Audio is uploaded to the cloud. For privacy-sensitive material, use local DeepFilterNet3 / ZipEnhancer.
- Billed per call. Configure a Model Studio API Key in provider settings.

## Source and license
- Provider: Alibaba Cloud Model Studio · Model ID: fun-audio-denoising
- Requires Bailian API access
