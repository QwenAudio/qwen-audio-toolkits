# Security Policy

## Supported versions

Security fixes are prioritized for the latest published release and the current
default branch.

## Report a vulnerability

Do not open a public issue containing exploit details, credentials, private
audio, or user data. Prefer GitHub's private vulnerability reporting page:

https://github.com/QwenAudio/qwen-audio-toolkits/security/advisories/new

If private reporting is unavailable, contact Zhendong Peng at
pengzhendong.pzd@alibaba-inc.com with the affected version, platform,
reproduction conditions, impact, and any suggested mitigation. Please avoid
public disclosure until a fix or mitigation is available.

## Security boundaries

- The local Harness API binds to `127.0.0.1` and is not authenticated. Never
  expose it to a LAN or public network.
- Model packages are data-only and must use a reviewed adapter. Archive paths,
  size limits, required files, and optional SHA-256 values are validated.
- Cloud API keys and local recordings must never be committed or attached to a
  public issue.
- Remote model assets, catalogs, API responses, file names, transcripts, and
  generated media should be treated as untrusted input.
- Official updater artifacts require a matching signature. Signing keys and
  notarization credentials must remain outside the repository.

See [PRIVACY.md](PRIVACY.md) for the data-flow boundary.
