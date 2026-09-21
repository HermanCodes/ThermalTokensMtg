# Getting this onto an iPhone

## What you can and can't do on Windows

| Task | Windows | Needs macOS |
|---|---|---|
| Develop and preview the UI | yes | — |
| `npx cap add ios` / `cap sync` | yes (done) | — |
| Edit `Info.plist`, Swift files | yes | — |
| iOS Simulator | **no** | yes |
| Build / archive the app | **no** | yes |
| Upload to TestFlight | **no** | yes |

The iOS Simulator is part of Xcode and only runs on macOS. There is no legitimate
way around this. Note the Simulator has **no Bluetooth stack** either, so even on
a Mac it could not test printing — that always needs a physical iPhone.

## Previewing the UI on Windows

The app is a web view on iOS, so what the browser shows at iPhone dimensions is
what the phone renders. Only the Bluetooth layer differs.

```bash
npm run dev
```

Then in Brave/Chrome press `Ctrl+Shift+M`, choose an iPhone from the device list,
and reload. Everything except the Connect button behaves identically.

## Getting to TestFlight

You need two things: an **Apple Developer Program** membership (£79/$99 a year)
and access to a Mac *or* a macOS CI runner.

### Option A — borrow a Mac (simplest, one-off)

```bash
git clone <this repo>
npm install
npm run ios:sync      # vite build + cap sync ios
npm run ios:open      # opens Xcode
```

In Xcode:

1. Select the **App** target → **Signing & Capabilities**.
2. Set **Team** to your Apple Developer team. Leave "Automatically manage
   signing" ticked.
3. Change the **Bundle Identifier** if `com.joshhermann.tokenprinter` is taken.
4. Plug in your iPhone, select it as the run destination, press **Run**. This
   installs a debug build directly — enough to test printing, no TestFlight
   needed.
5. For TestFlight: **Product → Archive**, then **Distribute App → App Store
   Connect → Upload**.

Step 4 is worth doing first: it is the fastest way to confirm the printer works
from the phone, and it needs no App Store Connect setup at all.

### Option B — GitHub Actions macOS runner (no Mac required)

GitHub provides macOS runners, so CI can archive and upload for you. You will
need, as repository secrets:

- an **App Store Connect API key** (Issuer ID, Key ID, and the `.p8` file),
- a **distribution certificate** and **provisioning profile**, most easily
  managed with [fastlane match](https://docs.fastlane.tools/actions/match/).

This is more setup up front but means you never touch a Mac. Worth it only if
borrowing one is genuinely impossible — the certificate handling is the fiddly
part, not the build.

## After any web change

```bash
npm run ios:sync
```

`cap sync` copies `dist/` into `ios/App/App/public/` and refreshes the plugin
list. The native project does not otherwise need regenerating.

## What is already set up

- `capacitor.config.ts` — app id, name, `webDir: dist`.
- `ios/App/App/Info.plist` — `NSBluetoothAlwaysUsageDescription`. **Required**:
  iOS kills the app on its first CoreBluetooth call without it.
- `src/printer/capacitorBluetooth.ts` — CoreBluetooth transport.
- `src/printer/pickTransport.ts` — picks Web Bluetooth or CoreBluetooth at
  runtime. The Capacitor plugin is imported lazily, so the web build never
  downloads it.

## Differences to expect on iOS

**No device chooser.** Web Bluetooth shows a system picker; CoreBluetooth does
not. The transport scans for ~6s and connects to the strongest Phomemo-looking
signal. If you own more than one printer, this needs a picker UI — the scan
results are already collected in `lastScan`.

**Opaque device ids.** iOS gives each peripheral a per-app UUID rather than a MAC
address. It is stable for this app and device, so it can be stored to skip the
scan on later launches. Not wired up yet.

**Permission prompt on first use.** The string above is what the user sees.

**Background limits.** iOS suspends BLE for backgrounded apps unless you declare
background modes. Printing is foreground-only, so this does not apply — just
don't expect a print to survive the app being backgrounded mid-job.
