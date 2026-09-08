## Overview
WeText provides WFST-based text normalization (TN) and inverse normalization (ITN) for Chinese, English, and Japanese, running locally with millisecond response times.

## Use cases
- TTS preprocessing: read "2024年" as "二零二四年"
- ASR postprocessing: write "一千二百元" as "1200 元"
- Standardize dates, amounts, phone numbers, and other formats

## Languages and capabilities
- Languages: Chinese, English, and Japanese
- TN and ITN, with rules for character width and Traditional/Simplified Chinese conversion

## Usage tips
- Recommended companion for local TTS such as VITS and MeloTTS.
- Rule-based; unsupported expressions pass through unchanged.

## Source and license
- Publisher: WeNet · License: Apache-2.0
- Runtime: kaldifst · Size: about 3 MB · Version: 0.1.6
