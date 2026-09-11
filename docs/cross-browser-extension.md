# Cross-browser extension builds

Tabloom keeps one organizer implementation and selects a typed browser adapter at build time. Chrome, Arc, and Dia use the Chromium artifact. Firefox and Safari receive target-specific manifests while sharing the same UI, synchronization, bookmarks, tab management, drag-and-drop, and theme code.

## Build commands

```bash
npm run build:extension
npm run build:extension:chromium
npm run build:extension:firefox
npm run build:extension:safari
```

The all-target command writes unpacked resources to:

- `dist-extension/chromium`
- `dist-extension/firefox`
- `dist-extension/safari`

### Chromium browsers

Open the browser extension manager, enable developer mode, choose **Load unpacked**, and select `dist-extension/chromium`.

- Chrome: `chrome://extensions`
- Arc: `arc://extensions`
- Dia: `dia://extensions`

### Firefox

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist-extension/firefox/manifest.json`. The manifest uses the stable add-on ID `tabloom@tabloom.app`; keep that ID unchanged so the OAuth redirect remains stable.

### Safari on macOS

Build converter-ready resources with `npm run build:extension:safari`. To generate the unsigned containing app and Xcode project, install full Xcode and run:

```bash
npm run package:safari
```

The script prefers Xcode's current `safari-web-extension-packager` command and falls back to its former `safari-web-extension-converter` name. The generated project is written to `dist-extension/safari-xcode`. Choose a local development team in Xcode, build the macOS app, then enable Tabloom under Safari **Settings → Extensions**. Signing, notarization, and App Store distribution are intentionally deferred. Safari sign-in uses a temporary browser tab and the packaged `auth-callback.html` page because Safari does not implement the WebExtensions identity API.

## OAuth callbacks

Add every installed target's exact callback URL to the Supabase authentication redirect allow list. Chromium and Firefox use `identity.getRedirectURL("auth-callback")`; Chromium extension IDs can differ by browser or install, while Firefox uses the stable manifest ID above. Safari uses `runtime.getURL("auth-callback.html")`, which is determined by the converted extension bundle, so register that value from the built Safari extension before testing sign-in.

Never commit Google client secrets, Supabase service-role keys, or authenticated browser profiles.

## Capability behavior

Tab grouping is feature-detected. When the API or optional permission is unavailable, **Open all** still opens every saved link and reports that the tabs were opened without a group. Bookmark access remains optional and is requested only when a user explicitly imports bookmarks during onboarding or while creating a space. Safari does not expose the WebExtensions bookmarks API, so its build omits the import option; ordinary collections imported and synchronized from Chromium or Firefox remain available in Safari.
