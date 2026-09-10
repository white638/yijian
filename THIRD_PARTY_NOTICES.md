# Third-party components

Yijian application source is distributed under the MIT License. Its Python and JavaScript dependencies retain their own notices and licenses, included in installed package metadata and distributions.

The application uses FastAPI, Uvicorn, Pydantic, Pillow, HTTPX, python-multipart, cryptography, React, Vite and a UI icon library. Dependency versions are recorded in the requirements files and `web/package-lock.json`.

The account edition uses Hono, Better Auth, Kysely, Zod, fflate and the Node SQLite adapter. Their versions and transitive dependencies are recorded in `online/package-lock.json`; their respective license texts remain in the distributed packages. Cloudflare Workers, D1, R2 and Vercel are external hosting services with their own service terms and charges.

## Image processing

- [rembg](https://github.com/danielgatis/rembg) is MIT-licensed. Its license is reproduced in `licenses/rembg-LICENSE.txt`.
- [U-2-Net](https://github.com/xuebinqin/U-2-Net) is Apache-2.0-licensed. Its license is reproduced in `licenses/U-2-Net-LICENSE`.
- The image setup program downloads the `u2netp.onnx` resource published through [rembg's U2Net model release](https://github.com/danielgatis/rembg/releases/tag/v0.0.0). The verified SHA-256 is `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`.
- ONNX Runtime and the remaining image dependencies retain their respective installed package licenses. The model resource is stored in the local data directory, separately from application source.

## Product references

Acloset and GetWardrobe informed product research and information structure. Their names identify the referenced products; their branding, source code, commercial artwork and community content are not part of the application distribution.
