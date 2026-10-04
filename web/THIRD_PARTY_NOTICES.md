# Third-party notices

This Web implementation retains the repository's existing GPL-2.0 project license. Dependency licenses are listed below. Original Battle City ROM, image and audio assets are not included.

## Game runtime: Phaser 4.2.1

Source: [phaserjs/phaser v4.2.1](https://github.com/phaserjs/phaser/tree/v4.2.1). The following license is copied from the version's [LICENSE.md](https://github.com/phaserjs/phaser/blob/v4.2.1/LICENSE.md).

```text
The MIT License (MIT)

Copyright (c) 2026 Richard Davey, Phaser Studio Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Game runtime dependency: EventEmitter3 5.0.4

Phaser uses [EventEmitter3](https://github.com/primus/eventemitter3) for event dispatch. This dependency is bundled into the game runtime. The following notice is copied verbatim from the `LICENSE` file in the installed `eventemitter3@5.0.4` package, whose exact version and integrity are recorded in `package-lock.json`.

```text
The MIT License (MIT)

Copyright (c) 2014 Arnout Kazemier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Development and test tools

These tools run locally or in CI, and are not game runtime code. Their dependency packages retain their own license files.

| Component | Version / role | License / source |
|---|---|---|
| TypeScript | 7.0.2, type checking | [Apache-2.0](https://github.com/microsoft/TypeScript/blob/v7.0.2/LICENSE.txt) |
| Vite | 8.3.2, build and development server | [MIT](https://github.com/vitejs/vite/blob/v8.3.2/LICENSE) |
| Vitest | 5.0.3, rules tests | [MIT](https://github.com/vitest-dev/vitest) |
| Playwright Test | 1.63.0, browser tests | [Apache-2.0](https://github.com/microsoft/playwright/blob/v1.63.0/LICENSE) |
| Node.js | 24.x, development / CI runtime | [MIT and third-party notices](https://github.com/nodejs/node/blob/main/LICENSE) |
| npm CLI | Package manager | [Artistic-2.0 and dependency notices](https://github.com/npm/cli/blob/latest/LICENSE) |

Direct versions are pinned in `package.json`; `package-lock.json` records exact transitive packages. Transitive packages and browser test binaries retain their respective notices; the table is not an assertion that all dependencies share one license.
