## Installation

```bash
yarn install
yarn build
```

Load `dist/extension/manifest.json` in `about:debugging`.


## Using the remote module

```bash
yarn install
yarn build
```

In your remote project:

```bash
yarn install ../path/to/esper/dist/index.js
```