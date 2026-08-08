# Third-Party Notices

QwenAudio Toolkits uses and distributes third-party open-source components. The
project's original source is Apache-2.0; each dependency remains subject to its
own license.

Primary runtime and UI components include:

| Component | License | Project |
| --- | --- | --- |
| Tauri | Apache-2.0 / MIT | https://github.com/tauri-apps/tauri |
| React / React DOM | MIT | https://github.com/facebook/react |
| Vite | MIT | https://github.com/vitejs/vite |
| wavesurfer.js | BSD-3-Clause | https://github.com/katspaugh/wavesurfer.js |
| React Flow | MIT | https://github.com/xyflow/xyflow |
| Lucide | ISC | https://github.com/lucide-icons/lucide |
| sherpa-onnx | Apache-2.0 | https://github.com/k2-fsa/sherpa-onnx |
| DeepFilterNet | MIT / Apache-2.0 | https://github.com/Rikorose/DeepFilterNet |
| RNNoise / nnnoiseless | BSD-3-Clause | https://github.com/xiph/rnnoise |
| WeTextProcessing / kaldifst | Apache-2.0 | https://github.com/wenet-e2e/WeTextProcessing |
| FunASR llama.cpp runtime | Apache-2.0 | https://github.com/modelscope/FunASR |
| cosyvoice.cpp | MIT | https://github.com/Lourdle/cosyvoice.cpp |

Exact JavaScript and Rust dependency versions are recorded in
`package-lock.json` and `src-tauri/Cargo.lock`. Distributed dependencies retain
their accompanying license files and notices.

## Models

Model weights are not committed to or bundled with this source repository.
They are downloaded after a user chooses to install a model. Model publishers
may impose separate licenses, acceptable-use policies, attribution, or data
terms. The model catalog records the publisher, upstream source, and SPDX
license identifier where available.

Catalog maintainers must verify model terms before adding or mirroring assets.
Users and downstream distributors remain responsible for reviewing the terms
of every model they install or redistribute.

Cloud providers process data under their own service terms and privacy
policies. QwenAudio Toolkits does not grant rights to any provider API, hosted
model, or dataset.
