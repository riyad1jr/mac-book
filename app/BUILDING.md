# Building Mame / Avanza Inventory

One source tree, two shops:
- **Mame** (orange, Mac customer) — this tree as it is.
- **Avanza** (blue, Windows customer) — generated from this tree:
  `node scripts/make-brand.cjs avanza ../avanza-app`
  It maps every name back to the ones Avanza has always used (data folder
  `ledgerly-inventory`, `avanza_shop.db`, `avanza2-` settings), so his data is found.
  Never rename those, or the app will start empty.

## Setup
    npm install
    npm run build          # typecheck + frontend + backend + native runtime

## Run while developing
    npm run server         # backend on :3001
    npm run dev            # frontend on :5173
    npx electron .         # desktop shell (loads :5173 when not packaged)

## Installers
- Windows: `npm run dist:win` (on Windows; output in tmp-release/)
- Mac (Apple Silicon), from Windows: install WSL (Ubuntu) and run
  `bash scripts/build-mac-on-linux.sh` - the script's header has the one-time
  setup. Electron's builder cannot make Mac apps on Windows itself.
- Mac, on a Mac: `npm install && npm run build && npx electron-builder --mac dir --arm64`,
  then `codesign --force --deep -s - "release/mac-arm64/Mame Inventory.app"`.
  Zip with `zip -r -y` (keeps symlinks). First open needs "Open Anyway" in Privacy & Security.

## Where the data lives
- Mac: `~/Library/Application Support/mame-inventory/mame_shop.db` (+ `Backups/`, `logs/`)
- Windows (Avanza): `%APPDATA%\ledgerly-inventory\avanza_shop.db`
- iCloud copies (Mac): `iCloud Drive/Mame Backups/`

See CHANGES.md for what changed in each round and why.
