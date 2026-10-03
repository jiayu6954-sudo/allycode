# Third-party components and redistribution boundary

The root MIT license covers AllyCode project source. It does not relicense external libraries, services, models, fonts or operating-system packages.

- JavaScript dependency versions are recorded in `package-lock.json`; their own package licenses apply. Dependencies are fetched by npm, not vendored in this source export.
- Python dependencies are listed in the bundled office skill's requirements files. They retain their own licenses and are installed separately.
- Electron, Chromium/Playwright, LibreOffice, Tesseract, Ollama and llama.cpp are external runtimes. Their upstream licenses and notices must accompany any separate binary redistribution where required. This source update does not redistribute their installers or binaries.
- Qwen3.5-9B and PaddleOCR-VL-1.6 are optional downloaded model artifacts. This repository ships integration code and download metadata, not weights. Check the precise upstream model/version license before deployment or redistribution; the project's MIT license does not grant model rights.
- Commercial Chinese document fonts are not included. Users must obtain suitable licensed fonts; generic fallback fonts do not establish exact-format conformity.
- Provider names identify protocol compatibility. No affiliation, provider SLA or blanket model certification is implied.
- Test fixtures are synthetic or character-class-redacted structural samples. No original private conversations, private continuation text, customer invoices or production databases are included.

This is a source distribution notice, not a claim that all future binary packaging obligations have been discharged. Review actual bundled dependencies and upstream notices when distributing installers.
