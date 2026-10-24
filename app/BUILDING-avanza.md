# Building Avanza Inventory (Windows customer, blue)

This is the Windows customer's version. It is the same code as the Mame
(Mac, orange) version; only the name, colours and the data locations differ.

## Keep these names exactly as they are
They decide where the app finds the shop's data. Change them and the app
opens empty (the data is still on disk, just not found):
- package.json `"name": "ledgerly-inventory"` -> data folder `%APPDATA%\ledgerly-inventory`
- database file `avanza_shop.db`, backups `avanza-backup-*.db`, log `avanza.log`
- settings keys starting with `avanza2-` (language, dark mode, zoom)

## Setup and build (on Windows)
    npm install
    npm run build          # typecheck + frontend + backend + native runtime
    npm run dist:win       # installer + portable .exe in tmp-release/

## Run while developing
    npm run server         # backend on :3001
    npm run dev            # frontend on :5173
    npx electron .         # desktop shell

## Where his data lives
    %APPDATA%\ledgerly-inventory\avanza_shop.db
    %APPDATA%\ledgerly-inventory\Backups\        (automatic backups)
    %APPDATA%\ledgerly-inventory\logs\avanza.log

## Changing the app for both shops
The Mame source (mame-inventory-source zip) is the main copy. Make changes
there, then regenerate this version with:
    node scripts/make-brand.cjs avanza ../avanza-app
That script sets every name above back to Avanza's and refuses to finish if
anything Mame-branded is left. (Changing this copy directly also works, but
then the Mac version won't have the change.)

The iCloud backup code is included but only switches on on a Mac; on
Windows the iCloud card is hidden. See CHANGES.md for every change and why.
