# Putting this app on your iPhone

Written for someone who does not use a Mac. Nothing here assumes you have git,
Node, or any developer tools installed.

**A free Apple ID is enough.** You do not need the paid Developer Program, and
you never touch the App Store or TestFlight. The app installs over the cable
straight from the Mac.

**Time:** about 20 minutes of your attention, plus a long unattended Xcode
download (30–90 minutes depending on the connection). Start step 1 first and do
the rest while it runs.

---

## Mac basics, if you need them

| Thing | What it means |
|---|---|
| **⌘** | The Command key, next to the space bar |
| **Spotlight** | Press **⌘ + Space**, type an app's name, press Return to open it |
| **Terminal** | The Mac's command line. Open it with Spotlight: ⌘+Space, type `Terminal` |
| **Finder** | The file browser, like Windows Explorer |
| Running a command | Type or paste it into Terminal, then press **Return** |
| Pasting into Terminal | **⌘ + V** (not Ctrl+V) |

One very useful trick: in Terminal you can type `cd ` (with a space) and then
**drag a folder from Finder into the Terminal window**. It fills in the path for
you. Press Return to move into that folder.

Terminal shows no output for many successful commands. Silence usually means it
worked.

---

## Step 0 — check the Mac is new enough

Click the **Apple logo** (top-left) → **About This Mac**. Note the macOS version.

Xcode needs a fairly recent macOS. If yours is older than **macOS 14 (Sonoma)**,
run **System Settings → General → Software Update** first and install what it
offers.

If the Mac cannot update far enough, Xcode may be too old to install apps onto a
current iPhone. That is worth finding out now rather than after an hour of
downloading.

---

## Step 1 — install Xcode (start this first, it is slow)

1. Open the **App Store** on the Mac (Spotlight: ⌘+Space, type `App Store`).
2. Search for **Xcode**.
3. Click **Get** / **Install**. It is a very large download — expect 30–90
   minutes. You can carry on with steps 2 and 3 while it downloads.
4. When it finishes, **open Xcode once**. It will ask to install additional
   components — allow it, and enter the Mac's password if prompted. Accept the
   licence agreement.

Leave Xcode open or closed, it does not matter for now.

> Installing Xcode also gives you `git`, so you do not need to install that
> separately.

---

## Step 2 — install Node

Node is what builds the app's web code.

1. Go to **<https://nodejs.org>**.
2. Download the **macOS Installer (.pkg)** for the version marked **LTS**.
   - If the page offers a choice of chip: pick **ARM64** for an Apple Silicon
     Mac (M1/M2/M3/M4), or **x64** for an older Intel Mac. About This Mac from
     step 0 tells you which you have.
3. Open the downloaded `.pkg` file and click through the installer.

Check it worked. Open **Terminal** (⌘+Space, type `Terminal`) and run:

```bash
node --version
```

You should see something like `v20.11.1` or `v22.x`. If you get
"command not found", close Terminal completely and open a new one — the
installer only affects newly opened windows.

---

## Step 3 — get the code onto the Mac

The simplest way needs no git at all.

1. In **Safari** on the Mac, go to:
   <https://github.com/HermanCodes/mtg-token-printer>
2. Click the green **Code** button → **Download ZIP**.
3. Open your **Downloads** folder in Finder and **double-click the ZIP** to
   unpack it. You will get a folder called `mtg-token-printer-main`.
4. Drag that folder to your **Desktop**, so it is easy to find.

<details>
<summary>Alternative: use git instead (optional)</summary>

If you would rather have git so you can pull updates later, run this in
Terminal after Xcode is installed:

```bash
cd ~/Desktop && git clone https://github.com/HermanCodes/mtg-token-printer.git
```

Then use `mtg-token-printer` in place of `mtg-token-printer-main` everywhere
below.
</details>

---

## Step 4 — build the app

Open **Terminal** and move into the folder. If you put it on the Desktop and
used the ZIP:

```bash
cd ~/Desktop/mtg-token-printer-main
```

`~` means your home folder. If that errors with "No such file or directory",
type `cd ` (with a space) and drag the folder from Finder into the Terminal
window, then press Return.

Confirm you are in the right place — this should list files including
`package.json`:

```bash
ls
```

Now install the app's dependencies. This takes a minute or two and prints a lot
of text:

```bash
npm install
```

Then build it and copy it into the iPhone app shell:

```bash
npm run ios:sync
```

You should see `Sync finished` near the end.

> **Remember this command.** Any time the web code changes, run
> `npm run ios:sync` again. Xcode installs the *copied* build, not your working
> files — forgetting this is the most common reason a change does not appear on
> the phone.

---

## Step 5 — open the project in Xcode

```bash
npm run ios:open
```

Xcode opens. The first time, it may sit for a minute or two resolving Swift
packages — there is a progress indicator at the top. Wait for it to settle.

---

## Step 6 — sign the app with your Apple ID

Signing is Apple's way of saying "this person built this app". A free Apple ID
can sign apps for its own devices.

1. **Xcode menu → Settings…** (or ⌘+,) → **Accounts** tab.
2. Click **+** at the bottom-left → **Apple ID** → **Continue** → sign in with
   your Apple ID. Use the same one as your iPhone if you can.
3. Close Settings.
4. In the **left sidebar**, click the blue **App** icon at the very top.
5. In the middle pane, under **TARGETS**, click **App**.
6. Click the **Signing & Capabilities** tab along the top.
7. Tick **Automatically manage signing**.
8. Set **Team** to your name — it will say something like
   *Joshua Herman (Personal Team)*.
9. Change **Bundle Identifier** to something unique to you, for example:

   ```
   com.hermancodes.tokenprinter
   ```

If you see a **red error** here, it is nearly always the Bundle Identifier —
another Apple ID already claimed it. Change it to something more obviously
yours (add a word, change the middle part) and the error clears by itself.

---

## Step 7 — turn on Developer Mode on the iPhone

**Do not skip this.** On iOS 16 and later the iPhone refuses to run
self-installed apps until Developer Mode is on, and the option is hidden until
you have tried to install one.

1. Plug the iPhone into the Mac with its cable.
2. **Unlock the iPhone.** On its screen, tap **Trust This Computer** and enter
   your passcode.
3. On the iPhone go to **Settings → Privacy & Security**, scroll to the bottom,
   and look for **Developer Mode**.
   - **If it is there:** turn it **on**. The phone will ask to restart — let it.
     After it restarts, unlock it and confirm **Turn On** when prompted.
   - **If it is not there yet:** carry on to step 8 and press ⌘R. That first
     attempt makes the option appear; then come back here, turn it on, restart,
     and press ⌘R again.

---

## Step 8 — install it on the phone

1. With the iPhone plugged in and unlocked, look at the **top bar of the Xcode
   window**. Next to the app name is the run destination — it may say
   *Any iOS Device* or the name of a simulator.
2. Click it and choose **your iPhone** from the list (under a heading with your
   phone's name).
3. Press **⌘R**, or click the **▶ play button** at the top-left.

Xcode builds and installs. The first build takes a few minutes; later ones are
quick.

---

## Step 9 — trust the app on the phone

The app is now installed, but **iOS will refuse to open it** the first time,
with a message about an untrusted developer. This is expected on a free Apple
ID, not a failure.

On the **iPhone**:

**Settings → General → VPN & Device Management → Developer App →** tap your
Apple ID **→ Trust → Trust**

Now open **Token Printer** from the home screen.

---

## Step 10 — connect the printer

1. Turn the printer on and check it has paper.
2. **Force-quit Cauldron** if it is running — double-tap the home button or
   swipe up from the bottom and hold, then swipe Cauldron away. A Bluetooth
   printer already connected to another app usually stops advertising, and the
   picker will show nothing.
3. In Token Printer, tap **Connect printer**. A native iOS list of nearby
   Bluetooth devices appears — pick your printer by name.
4. Allow Bluetooth when iOS asks.
5. Search for a token, tap it, tap **Print label**.

---

## When something goes wrong

**"command not found: node"** — close Terminal completely and open a new window.
The installer only affects new windows.

**"No such file or directory" from `cd`** — type `cd ` with a space, then drag
the project folder from Finder into Terminal and press Return.

**Red signing error in Xcode** — change the Bundle Identifier to something more
unique to you.

**Your iPhone does not appear in the destination list** — check the cable is a
data cable (not charge-only), the phone is unlocked, and you tapped
**Trust This Computer**. Unplug and replug if needed.

**"Could not launch" / the app closes instantly** — you have not done step 9's
Trust flow, or Developer Mode from step 7 is off.

**The app worked and now will not open, about a week later** — the free
certificate expired. Plug in, press ⌘R, done. See below.

**The printer picker is empty** — printer off, out of paper, or still connected
to Cauldron or the Phomemo app. Force-quit those and power-cycle the printer.

**It connects but nothing prints** — in the app open **Print options → Advanced
→ Show diagnostics**. The `match:` line says how it chose the characteristic and
the table lists every service found. Send me that.

**A change to the app is not showing on the phone** — you skipped
`npm run ios:sync`. Run it, then ⌘R again.

---

## The 7-day expiry

A free Apple ID's signature lasts **7 days**. After that the app will not launch
until you plug the phone into the Mac and press ⌘R again — about 30 seconds of
work, but it recurs weekly.

The paid Developer Program (£79/$99 a year) extends this to **a year**. That is
the only difference that matters for this app — you still install over the
cable, with no App Store involvement. Worth it only if the weekly re-sign
becomes a nuisance.

---

## Installing an update later

Once everything above is done, updating is three commands and a keypress:

```bash
cd ~/Desktop/mtg-token-printer-main
```

If you used git:

```bash
git pull
```

If you downloaded the ZIP, download a fresh one and replace the folder instead.

Then:

```bash
npm install && npm run ios:sync && npm run ios:open
```

and press **⌘R** in Xcode with the phone plugged in.

---

## What the iPhone version does better

**A proper device picker.** iOS shows a native list, so you choose the printer
by name instead of the app guessing.

**It finds your printer's services instead of assuming them.** Your unit does
not expose the service the documentation describes, so the app enumerates
everything the printer offers and picks a characteristic it can write to,
remembering the one that worked for next time.

**Faster printing is possible.** In a browser there is no way to ask how much
data the Bluetooth link will accept per message, so unacknowledged writes have
to be kept tiny and end up slower. iOS does not have that limitation. Once
installed, try **Print options → Advanced → Write mode → Without response** —
it should be noticeably quicker. If nothing prints, switch it back.

**Printing is foreground-only.** iOS pauses Bluetooth for apps in the
background, so stay in the app while a label prints.
