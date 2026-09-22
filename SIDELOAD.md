# Sideloading to your iPhone

Personal use, your own device, no TestFlight and no App Review. A **free Apple
ID works** — the paid Developer Program only changes how long the build lasts
(see [The 7-day catch](#the-7-day-catch)).

Bluetooth needs no special entitlement, so printing works on a free account.

---

## Before you start

On the Mac you need:

- **Xcode** from the Mac App Store (large download; start it first)
- **Node 20+**
- Your **Apple ID** (any free one)
- The **iPhone** and its cable

You do *not* need a paid developer account, a Mac of your own long-term, or
anything on App Store Connect.

---

## 1. Get the project onto the Mac

```bash
git clone https://github.com/HermanCodes/mtg-token-printer.git
cd mtg-token-printer
npm install
```

## 2. Build the web app into the native shell

```bash
npm run ios:sync
```

That runs `vite build` and then `cap sync ios`, which copies `dist/` into
`ios/App/App/public/` and refreshes the plugin list. **Re-run this after any
change to the web code** — Xcode serves the copy, not your working tree.

## 3. Open it in Xcode

```bash
npm run ios:open
```

Xcode may spend a minute resolving Swift packages the first time. Capacitor 8
uses Swift Package Manager, so there is no CocoaPods step.

## 4. Sign it

1. **Xcode → Settings → Accounts →** `+` → **Apple ID** → sign in.
2. In the left sidebar click the blue **App** project, then the **App** target.
3. Open **Signing & Capabilities**.
4. Tick **Automatically manage signing**.
5. Set **Team** to your name *(Personal Team)*.
6. Change **Bundle Identifier** to something unique to you, e.g.
   `com.hermancodes.tokenprinter`. Free accounts often reject a generic one, and
   the identifier must not already exist under another Apple ID.

If it shows a red signing error, it is almost always the bundle identifier —
change it to something more obviously yours and the error clears.

## 5. Install it

1. Plug in the iPhone, unlock it, and tap **Trust This Computer**.
2. Pick the iPhone from the run-destination dropdown at the top of the Xcode
   window (next to the scheme name, where it says "Any iOS Device" or a
   simulator).
3. Press **⌘R**.

The build installs and launches. The **first launch will be refused** by iOS —
that is expected for a free account. On the iPhone:

**Settings → General → VPN & Device Management → Developer App →** your Apple ID
**→ Trust**

Then open it from the home screen.

## 6. Connect the printer

Tap **Connect printer**. On iOS this opens a **native device list** rather than
the browser chooser — pick your printer by name and it connects.

The first BLE call triggers the system Bluetooth permission prompt. The wording
comes from `NSBluetoothAlwaysUsageDescription` in `ios/App/App/Info.plist`,
which is already set — iOS terminates the app on that first call if it is
missing.

**Force-quit Cauldron first.** A BLE peripheral already connected to another app
usually stops advertising, and the picker will show nothing.

---

## The 7-day catch

A free Apple ID gets a **7-day** signing certificate. After that the app will
not launch until you plug the phone in and press ⌘R again — about 30 seconds,
but recurring.

Other free-account limits: 10 App IDs per 7 days, and no push notifications or
App Groups. This app uses none of those.

The paid Developer Program (£79/$99 a year) raises the certificate to **a year**.
That is the only difference that matters here — you still install over the cable.
Worth it if the weekly re-sign becomes annoying; not worth it just to get the app
onto your own phone.

---

## What the iOS build does differently

**Native device picker.** `requestDevice` shows an iOS list, so you choose the
printer by name instead of the app guessing from signal strength.

**It discovers the printer's services rather than assuming them.** Your unit
does not expose the documented `0xff00`/`0xff02` pair, so the transport
enumerates every service and picks a writable characteristic by the same
precedence the web build uses: documented pair → the pair that last printed →
any known Phomemo service → anything writable. The working pair is remembered
after a successful print, so later connects target it directly.

**Unacknowledged writes are actually usable here.** In the browser there is no
way to read the negotiated MTU, so a write-without-response has to be clamped to
20 bytes to be safe. iOS typically negotiates 185, and CoreBluetooth provides
real flow control — so **Print options → Advanced → Write mode → Without
response** should be meaningfully faster on the phone than it ever could be in
Bluefy. Try it; if nothing prints, switch back.

**Printing is foreground-only.** iOS suspends BLE for backgrounded apps, so do
not switch away mid-print.

---

## If something goes wrong

**"Could not launch" / app closes instantly** — the certificate was not trusted.
Do step 5's Trust flow.

**Signing errors in Xcode** — change the bundle identifier.

**The picker shows no devices** — the printer is off, out of paper, or still
connected to another app. Force-quit Cauldron and power-cycle the printer.

**Connects but nothing prints** — open **Print options → Advanced → Show
diagnostics**. The `match:` line says how the characteristic was chosen and the
table lists every service found. `brute-force` means it guessed; send that table
and the right UUIDs can be hardcoded.

**Changes to the web app are not showing** — you skipped `npm run ios:sync`.

---

## Rebuilding later

```bash
npm run ios:sync
```

then ⌘R in Xcode. Only the web assets change; the native project stays as is.
