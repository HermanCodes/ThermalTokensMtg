# MTG Token Printer

Search for any Magic: The Gathering token — or any card at all — and print it to
a Phomemo M110 thermal label printer over Bluetooth.

Built because clone and copy decks need token copies of real cards, and because
speaking a card name at a phone is a worse way to find one than typing it.

**Live app: <https://hermancodes.github.io/mtg-token-printer/>**

---

## What it prints

Four modes, switchable per print:

| Mode | What comes out |
|---|---|
| **Text** | Name, type line, rules text and P/T, set as type rather than an image. Crisp at any size. |
| **Card** | The card art itself, tone-adjusted and dithered. |
| **Card + text** | Both: the picture to recognise at a glance, the text underneath to actually read. |
| **Calibration** | A strip of the same art at a sweep of brightness and contrast values, to find settings by eye. |

Card + text is the default, and the reason the app exists: a dithered card at
203 dpi is recognisable but its rules text is not legible, so the text is
re-typeset underneath with a hard threshold and no tone shift.

The print head is 384 dots across — **48 mm at 8 dots/mm**, a hard mechanical
limit. Length is free on continuous roll, so labels are sized to their content.

## Getting it running

```bash
npm install
npm run dev
```

Printing needs Bluetooth, which needs a secure context. `localhost` counts, so
the dev server works; anything else must be HTTPS.

### Browser support

| Browser | Works |
|---|---|
| Chrome, Edge (desktop + Android) | Yes |
| Brave | Yes, after enabling `brave://flags/#brave-web-bluetooth-api` |
| Firefox, Safari | No — no Web Bluetooth, and none is planned |
| iOS | [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) against the hosted URL, or the native build below |

Pushing to `main` deploys to GitHub Pages, which is what makes the iOS route
work: Bluefy needs HTTPS.

The interface picks itself by capability, not by user agent — a desktop gets
three columns, a phone gets a navigation stack and a settings sheet — and
either can be forced from the header.

### On an iPhone, as a real app

The web build reaches the printer through Web Bluetooth; the iOS build swaps in
CoreBluetooth via Capacitor. Everything above the transport — protocol,
renderer, dithering, UI — is shared.

```bash
npm run ios:sync    # vite build && cap sync ios
npm run ios:open    # needs macOS
```

- **[SIDELOAD.md](SIDELOAD.md)** — installing on your own phone with a free
  Apple ID, written for someone who does not use a Mac. No App Store, no
  TestFlight, no paid developer account.
- **[IOS.md](IOS.md)** — what can and cannot be done from Windows, and the
  TestFlight route if you want one.

## How a print is made

1. **Search** — [Scryfall](https://scryfall.com/docs/api), scoped to tokens or
   to every card. Both the API and its image CDN send `Access-Control-Allow-Origin: *`,
   so there is no backend anywhere in this project.
2. **Render** — card art to one canvas, typeset text to another. Split
   deliberately: the card wants tone adjustment and error diffusion, the text
   wants a hard threshold and no tone shift at all. Dithering the assembled
   image in one pass would wreck the text.
3. **Tone** — CLAHE for local contrast, then brightness solved to hit a target
   ink coverage. Contrast stays a user control, because legibility is not
   something a coverage target can reason about.
4. **Dither** — Atkinson or Floyd–Steinberg error diffusion for art, plain
   threshold for text.
5. **Pack** — 1 bpp, 48 bytes per line, MSB leftmost, bit set means black.
6. **Send** — `GS v 0` raster inside an ESC/POS-ish job, chunked to the ATT MTU.

### Auto-tone, and why brightness rather than contrast

Error diffusion reproduces the *average* tone of its input, so ink coverage
lands near `(255 − mean) / 255` and the threshold slider barely moves the
result. Brightness is the real control. The solver uses that: it measures the
card, then solves brightness for the coverage you asked for.

An earlier version solved contrast too and produced cards that measured
correctly and read terribly. Contrast is an input now.

## Working with the printer

The M110 speaks a dialect of ESC/POS over BLE. `src/printer/protocol.ts` has
the commands and the reasoning; the parts worth knowing up front:

- **A job over ~44 KB is discarded silently.** The image is dropped and the
  feed still runs, so a long label appears to print as blank paper. Long labels
  are split into separate jobs — cut at the rule between card and text, never
  through a line of rules text.
- **Each job must finish printing before the next is sent.** Bluetooth writes
  are acknowledged by the radio long before the paper moves. Hand the printer a
  second job mid-print and it drops the data and comes out garbled.
- **Notifications must be enabled or nothing prints.** This firmware will not
  accept raster data until the notify characteristic is subscribed. The failure
  looks exactly like a pacing problem, which is a good way to lose an evening.
- **The documented `0xff00`/`0xff02` pair is not guaranteed.** Services are
  discovered and a writable characteristic chosen by precedence, with the match
  path shown in Diagnostics — `brute force` there means it is probably wrong.

## When something goes wrong

Open **Diagnostics** (Advanced → Show diagnostics). It shows the GATT table,
which characteristic was chosen and how, whether notify subscribed, and what
the last print actually did.

| Symptom | Likely cause |
|---|---|
| Connect does nothing | Web Bluetooth disabled. On Brave, the flag above. On iOS Safari, use Bluefy. |
| Connects, but no Bluetooth symbol on the printer | Wrong characteristic — check the match path in Diagnostics. |
| Feeds blank paper | Notify never subscribed, or a job over the size limit. |
| Prints garbled, and keeps doing so | A previous job was abandoned mid-raster. **Advanced → Clear printer**, then power-cycle if it persists. |
| Card stops short with text over it | The gap between jobs was too short. Lower **Print speed** in Diagnostics. |
| Text unreadable on a card print | Use Card + text rather than Card. |
| Bright cards look washed out | Auto-tone handles this, or run a Calibration strip. |

Nearly every default in Diagnostics was measured on hardware rather than
chosen, and the comments say which.

## Layout

```
src/
  scryfall.ts      card search and the shapes Scryfall returns
  label.ts         typesetting — name, type line, rules text, P/T
  raster.ts        greyscale, CLAHE, auto-tone, dithering, 1bpp packing
  compose.ts       card + text composition, and the seam between them
  calibration.ts   brightness/contrast sweep strips
  usePrinter.ts    all state and behaviour, with no opinion about layout
  ui/              PhoneApp, DesktopApp, shared controls
  printer/
    protocol.ts        wire format and every measured constant
    index.ts           job building, splitting and pacing
    webBluetooth.ts    Web Bluetooth transport
    capacitorBluetooth.ts  CoreBluetooth transport for iOS
    gattPick.ts        shared characteristic selection
```

## Notes

Personal project, no licence, no warranty. Not affiliated with Wizards of the
Coast, Scryfall or Phomemo. Card data and images come from Scryfall under their
terms; Magic: The Gathering is a trademark of Wizards of the Coast.
