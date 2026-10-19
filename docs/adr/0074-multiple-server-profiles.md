# 0074. Multiple server profiles

- Status: Accepted
- Date: 2026-10-19

## Context
The desktop and Android apps keep one server and one bearer token (0052). Changing the server or user revokes the session and deletes the previous account's offline store (0061), so readers with several instances or accounts sign in again and lose offline data and queued edits each time. A login also revokes whatever session the request carries, so a second user on the same server would end the first's session.

## Decision
- **Profiles.** The apps keep several profiles, each a server origin and a user on it, with a random id. One is active; the app shows only its data. There is no merged view across servers. The browser build keeps its single origin and cookie session.
- **Shell storage.** The shells keep the profiles and the active id (desktop `settings.json`, Android Preferences) and each profile's token in OS secure storage. The bridge hands the web app the active profile's token only, and a removed profile's once, to revoke it.
- **Switching** reloads the web app on the chosen profile, after any sync or send in progress finishes.
- **Offline stores** stay per profile and are kept when switching; only signing out or removing a profile deletes one. Only the active profile syncs, Android's background job included. The storage limit is per profile, and profiles after the first start at 256 MB.
- **Logins** for a profile carry no token.
- The desktop tray lists the profiles to switch between.

## Consequences
- Offline data on a device grows with each profile, all within one origin's storage quota; eviction can remove every profile's store at once.
- Inactive profiles go stale until switched to, and learn of an expired session only then.
- On Linux without a keyring, every profile signs in again after each launch.
- Apps updating from a single server move it and its token into one active profile.
