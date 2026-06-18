# Vendored assets

Third-party libraries bundled locally so the `vts serve` dashboard loads them **same-origin from
127.0.0.1** — never from a CDN or any network. This keeps vs-token-safer's zero-transmission guarantee
intact (nothing leaves the machine) and lets the dashboard render with the network unplugged.

| File | Library | Version | License | Source (fetched once at vendor time) |
| --- | --- | --- | --- | --- |
| `three.module.min.js` | [Three.js](https://threejs.org) | r160 (0.160.1) | MIT | `https://unpkg.com/three@0.160.1/build/three.module.min.js` |

Three.js is © 2010-2023 three.js authors, MIT-licensed (SPDX `MIT`; the license banner is preserved at
the top of the file). To refresh: re-download the same path for the desired version and update this table.
