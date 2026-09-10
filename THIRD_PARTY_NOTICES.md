# Third-party components

Yijian application source is distributed under the MIT License. Its Python and JavaScript dependencies retain their own notices and licenses, included in installed package metadata and distributions.

The application uses FastAPI, Uvicorn, Pydantic, Pillow, HTTPX, python-multipart, cryptography, React, Vite and a UI icon library. Dependency versions are recorded in the requirements files and `web/package-lock.json`.

The experimental self-hosted account code uses Hono, Better Auth, Kysely, Zod, fflate and the Node SQLite adapter. Their versions and transitive dependencies are recorded in `online/package-lock.json`.

## Windows desktop distribution

The desktop window uses [pywebview](https://github.com/r0x0r/pywebview) and Python.NET under their respective BSD and MIT licenses. PyInstaller uses GPL with a distribution exception permitting bundled applications to retain their own licenses. The installation program is built with Inno Setup. Installed Python, native and frontend dependency notices are included under `_internal/licenses`; Python source packages and exact versions are listed there as well.

Microsoft WebView2 and the Visual C++ runtime are proprietary redistributable runtime components governed by Microsoft's licenses. The installer includes Microsoft's signed WebView2 bootstrapper and prepares the runtime when missing; that step requires an Internet connection. Application-local Visual C++ runtime DLLs are included for the Python and image libraries. These components are not covered by the application's MIT license.

## Image processing

- [rembg](https://github.com/danielgatis/rembg) is MIT-licensed. Its license is reproduced in `licenses/rembg-LICENSE.txt`.
- [U-2-Net](https://github.com/xuebinqin/U-2-Net) is Apache-2.0-licensed. Its license is reproduced in `licenses/U-2-Net-LICENSE`.
- The image setup program downloads the `u2netp.onnx` resource published through [rembg's U2Net model release](https://github.com/danielgatis/rembg/releases/tag/v0.0.0). The verified SHA-256 is `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`.
- ONNX Runtime and the remaining image dependencies retain their respective installed package licenses. The model resource is stored in the local data directory, separately from application source.

## Product references

Acloset and GetWardrobe informed product research and information structure. Their names identify the referenced products; their branding, source code, commercial artwork and community content are not part of the application distribution.
