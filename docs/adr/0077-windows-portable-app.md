# 0077. Windows portable app

- Status: Accepted
- Date: 2026-10-20

## Context
Windows readers can install the app per user or unpack the zip, and both keep their data in `%APPDATA%\Newses`. Some want to carry the app on a USB drive, or run it on a PC where they leave nothing behind. Since the offline store arrived (0061, 0074), the data folder holds up to 1 GB of articles and images for the first profile and 256 MB for each one after.

## Decision
- A single signed exe (electron-builder's `portable` target) ships beside the installer and the zip. It unpacks the app into a new temporary folder on each launch and deletes it on exit.
- It keeps its data (settings, encrypted tokens, the offline store) in `Newses Data` beside the exe; when that folder cannot be written, in `%APPDATA%\Newses` as the zip does.
- It does not offer launch at login, so it writes no login item.
- It does not update itself; a newer version links to the downloads page.

## Consequences
- The portable exe and an installed app keep separate profiles and offline stores, and can run at the same time.
- Tokens are encrypted with DPAPI, so on another PC or Windows user every profile signs in again. Changes waiting in the outbox are sent once the same user signs in again.
- Offline articles, notes, and waiting changes travel with the exe unencrypted, on a drive that is easier to lose than a PC.
- It starts a few seconds slower than an install, as it unpacks first.
