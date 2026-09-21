# Getting this on your iPhone (personal use)

Three routes, easiest first. For a personal tool you probably want **route 2**.

---

## 1. No build at all — Bluefy

iOS Safari has no Web Bluetooth and never will, but
[Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055) is a
third-party iOS browser that implements it (still maintained — v3.9.3, Jan 2026).

1. Deploy the web build anywhere with **HTTPS** — Cloudflare Pages, Netlify and
   GitHub Pages are all free and take minutes:
   ```bash
   npm run build      # outputs dist/
   ```
2. Install Bluefy on the iPhone.
3. Open your URL in Bluefy. Connect and print as normal.

HTTPS is required — Web Bluetooth refuses to run on plain HTTP.

**Good for:** proving the printer works from the phone today, with zero Xcode.
**Not so good:** you're in a browser tab, not an app with an icon. No offline use
unless you add a service worker.

---

## 2. Sideload from Xcode — free Apple ID

No paid Developer Program needed. A normal Apple ID works.

```bash
# on the Mac
git clone <this repo>
cd mtg-token-printer
npm install
npm run ios:sync     # vite build + cap sync ios
npm run ios:open     # opens Xcode
```

In Xcode:

1. **Xcode → Settings → Accounts →** `+` → add your Apple ID.
2. Select the **App** target in the sidebar → **Signing & Capabilities**.
3. Tick **Automatically manage signing**, set **Team** to your name
   (*Personal Team*).
4. Change **Bundle Identifier** to something unique to you, e.g.
   `com.yourname.tokenprinter`. Free accounts often reject a generic one.
5. Plug the iPhone in, unlock it, and trust the Mac.
6. Pick the iPhone from the run-destination dropdown (top bar, next to the
   scheme name).
7. Press **⌘R**.

On first launch the phone will refuse to open it. On the iPhone go to
**Settings → General → VPN & Device Management → Developer App →** your Apple ID
**→ Trust**. Then launch it from the home screen.

### The catch: 7 days

A free Apple ID gets a **7-day** signing certificate. After that the app won't
launch until you plug it in and press ⌘R again — a 30-second job, but a recurring
one. Other free-account limits: 10 App IDs per 7 days, and no push/App Groups
(neither of which this app uses).

**Bluetooth needs no special entitlement**, so printing works fine on a free
account.

---

## 3. Sideload from Xcode — paid Developer Program

Identical to route 2, but the £79/$99-a-year membership raises the certificate
life from 7 days to **a year**. That's the only difference that matters here —
you still install over the cable, no TestFlight, no App Review.

Worth it if the weekly re-signing becomes annoying. Not worth it just to get the
app onto your own phone once.

---

## After changing any web code

```bash
npm run ios:sync
```

Then ⌘R in Xcode. `cap sync` copies `dist/` into `ios/App/App/public/`; the
native project itself doesn't need regenerating.

---

## Things to know once it's on the phone

**The Simulator can't help you.** It has no Bluetooth stack, so printing can
only be tested on real hardware. Use the Simulator for layout if you like, but
the Connect button will always fail there.

**No device picker.** Web Bluetooth gets a system chooser for free; CoreBluetooth
doesn't. The transport scans ~6s and connects to the strongest Phomemo-looking
signal. Fine with one printer; it would guess between two. Scan results are
already collected in `lastScan` if a picker is ever needed.

**Close Cauldron first.** A BLE peripheral already connected to another app often
stops advertising, and the connection will just fail.

**The permission prompt** text comes from `NSBluetoothAlwaysUsageDescription` in
`ios/App/App/Info.plist`. iOS terminates the app on its first CoreBluetooth call
if that key is missing — it's already set.

**Printing is foreground-only.** iOS suspends BLE for backgrounded apps, so don't
switch away mid-print.
