# Privacy

QwenAudio Toolkits is a local-first desktop application. It contains no built-in
telemetry, advertising analytics, or automatic crash reporting. Some features
use network services selected by the user.

## Local processing

Offline models run on the user's device. Their input audio, text, and inference
results are not uploaded by QwenAudio Toolkits. Model assets are downloaded from
the source declared in the catalog after the user chooses to install them.

## Cloud processing

When a cloud API model is selected, the requested audio, text, reference audio,
and model parameters may be sent to that provider. Provider terms, retention,
and privacy policies apply. Configuring a provider key does not automatically
route local model runs to the cloud.

## Local data

On macOS, the current application identifier stores data under:

```text
~/Library/Application Support/org.qwenaudio.toolkits/
```

Data can include installed models and plugins, run history, generated and
processed audio, recordings, downloaded catalog metadata, model dependency
bindings, and provider configuration. Uninstalling the app does not remove this
directory automatically.

Provider credentials are stored in the application's private configuration
directory. They are not intentionally written to logs or exported with model
artifacts. Native Keychain / credential-vault storage is planned; until then,
do not configure production credentials on a shared operating-system account.

## Microphone and system audio

Microphone access begins only after a recording or live-input action. On macOS,
system-audio capture uses Core Audio Process Tap. Live monitoring can play audio
back through the selected output device. The app does not record continuously
in the background when capture is stopped.

## Local integration API

The experimental Harness API listens on `127.0.0.1:3847`. It has no remote
authentication and is intended only for software on the same trusted machine.
Do not expose it through port forwarding or a reverse proxy.

## Sharing diagnostics

Run errors and exported artifacts may include local file names, model names,
timestamps, transcripts, or generated audio. Review them before attaching them
to a public issue. Never publish API keys, access tokens, private recordings,
or the application configuration directory.

