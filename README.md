# LexTrace NT3

Edge MV3 extension with:

- monochrome tabbed popup shell
- overlay pseudo-terminal rendered over `http(s)` pages
- structured runtime logging with collapsible detailed log entries
- native-messaging host on `.NET 8` for long-running tasks
- automated Edge proof flow

## Commands

```powershell
npm install
npm run typecheck
npm run test:unit
npm run build
npm run pack
npm run register:native-host
npm run test:edge
```

## Notes

- `npm run test:edge` builds the extension, publishes the native host, packs a `.crx`, registers the native host in `HKCU`, and runs the full Edge end-to-end scenario.
- On this machine, direct Playwright navigation to `chrome-extension://.../popup.html` is blocked by branded Edge, so the test harness automatically falls back to an EdgeDriver session while staying in real Microsoft Edge.
- The generated extension ID is persisted through the local dev key under `artifacts/extension/lextrace-dev-key.pem`.
