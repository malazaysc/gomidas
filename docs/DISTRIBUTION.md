# Distributing Gomidas (macOS)

How to package and hand Gomidas to testers / users. Two paths: a free **ad-hoc** path
(works today, one trust-step for the user) and the **notarized** path (Apple Developer
account, zero warnings — the proper commercial route).

---

## Path A — Free ad-hoc build (works now)

Good for sending to one or two testers. The app is signed with an ad-hoc identity (`-`),
so macOS quarantines it on download and the user must do a one-time bypass.

**Target so far:** Apple Silicon (arm64) only. Will NOT run on Intel Macs.

### Build + package steps (what we ran 2026-06-29)

```bash
# 1. Configure a Release build in its own dir (keeps Debug intact)
cmake -B build-release -DCMAKE_BUILD_TYPE=Release

# 2. Build
cmake --build build-release --config Release -j$(sysctl -n hw.ncpu)

# 3. Deep ad-hoc re-sign (covers nested frameworks)
APP=build-release/Gomidas_artefacts/Release/Gomidas.app
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"   # should say "valid on disk"

# 4. Zip preserving the bundle (use ditto, NOT Finder/zip)
ditto -c -k --sequesterRsrc --keepParent "$APP" "$HOME/Desktop/Gomidas.zip"
```

Result last time: `~/Desktop/Gomidas.zip`, ~136 MB compressed (161 MB app), arm64.

### Instructions to send the tester

> 1. Unzip `Gomidas.zip` and drag **Gomidas.app** into **Applications**.
> 2. **Right-click** the app → **Open** → click **Open**. (Double-clicking the first
>    time is blocked — you must use right-click → Open.)
> 3. After the first launch it opens normally.
>
> **If you get "Gomidas is damaged and can't be opened"**, open **Terminal** and paste:
> ```
> xattr -dr com.apple.quarantine /Applications/Gomidas.app
> ```
> Then open it normally.

### Notes
- The "damaged" message is normal for ad-hoc apps on recent macOS — nothing is actually
  wrong; `xattr` just clears the download-quarantine flag.
- Mic permission will prompt if the tester uses live input — expected.
- Reminder: the live-input / plugin / recording stack is built but **runtime-unverified**
  (see CLAUDE.md / live-input-paths-unverified memory) — those features may be rough.
- For future ad-hoc builds, `build-release/` is already configured, so just re-run steps 2–4.

---

## Path B — Notarized build (Apple Developer account — the proper route)

Once notarized, **any** Mac can download → double-click → open with **no warning at all**.
No right-click, no `xattr`. This is how a commercial app should ship outside the App Store.

### One-time setup (BLOCKING — do this first)
1. **Enroll** in the Apple Developer Program — $99/yr at developer.apple.com.
   Approval is usually quick but can take 24–48h; individual enrollment may require ID
   verification. **Nothing else can proceed until the account is active.**
2. **Create a "Developer ID Application" certificate** (Xcode → Settings → Accounts →
   Manage Certificates, or the developer portal). This is the *outside-App-Store*
   distribution cert — distinct from the "Apple Distribution" / App Store cert.
3. **Notary credentials** — either an app-specific password for your Apple ID, or
   (cleaner) an App Store Connect API key. `notarytool` needs one of these.

### What changes vs ad-hoc
Notarization is stricter. Three things become mandatory:
- **Hardened runtime** must be enabled when signing.
- **Entitlements** — Gomidas needs two beyond the defaults:
  - `com.apple.security.device.audio-input` — mic / live-input feature.
  - `com.apple.security.cs.disable-library-validation` — **required** so the app can load
    third-party VST3/AU plugins signed by other devs (or unsigned). Without it, hardened
    runtime refuses to load any plugin not signed by us → breaks the priority-#1 VST feature.
  - (Possibly also `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory`
    if a plugin JITs — add only if a plugin fails to load.)
- **Notarize + staple** after signing.

### Release flow (target shape of the future `package.sh`)
```bash
APP=build-release/Gomidas_artefacts/Release/Gomidas.app

# sign with Developer ID + hardened runtime + entitlements
codesign --force --deep --options runtime \
  --entitlements gomidas.entitlements \
  -s "Developer ID Application: <NAME> (<TEAMID>)" "$APP"

# zip for submission
ditto -c -k --keepParent "$APP" Gomidas.zip

# submit + wait for Apple's notary service
xcrun notarytool submit Gomidas.zip --wait \
  --apple-id <APPLE_ID> --team-id <TEAMID> --password <APP_SPECIFIC_PW>
  # (or: --keychain-profile <PROFILE>, or App Store Connect API key)

# staple the ticket into the bundle (works offline afterward)
xcrun stapler staple "$APP"

# final zip to distribute
ditto -c -k --keepParent "$APP" Gomidas-notarized.zip
```

---

## TODO for tomorrow (Path B prep, while the dev account is pending)
- [ ] **Start the Apple Developer enrollment now** — it's the blocking item.
- [ ] Write `gomidas.entitlements` (audio-input + disable-library-validation).
- [ ] Check whether `CMakeLists.txt` needs hardened-runtime / entitlements flags wired in
      (JUCE `juce_add_gui_app` options) vs. signing post-build in the script.
- [ ] Write `package.sh` doing sign → notarize → staple → zip end-to-end (placeholders for
      Developer ID name + notary credentials).
- [ ] **Decide:** arm64-only vs **universal** (arm64 + x86_64) binary. Universal runs on
      Intel Macs too (~2x binary size). The tester this week is Apple Silicon, so arm64 was
      fine, but universal maximizes reach for wider testing.

---

_Last updated 2026-06-29. Tester this round: Apple Silicon, ad-hoc Path A._
