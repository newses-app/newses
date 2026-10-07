# 0035. Two-factor login and app passwords

- Status: Accepted
- Date: 2026-10-06

## Context
0008 promised optional TOTP and app passwords for compatibility clients. The web app, Electron, and Capacitor all log in through `/auth/login`, so 2FA limited to cookie logins would leave bearer logins as a way around it. TTRSS and Google Reader clients cannot prompt for a code.

## Decision
- TOTP per RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step), implemented with `node:crypto`. The secret is sealed with the `totp` key (0034); the last accepted step is stored to refuse replays.
- Once enabled, every `/auth/login` (cookie or bearer) with a correct password returns a challenge signed with the `login-challenge` key and valid for 5 minutes; `/auth/login/2fa` exchanges it and a TOTP or recovery code for a session. No server-side login state.
- Ten single-use 80-bit recovery codes, stored as SHA-256 hashes. Enrolling re-checks the password; enabling signs out other sessions; admins and the CLI can reset 2FA.
- App passwords are random tokens, shown once and stored as SHA-256 hashes. They authenticate only the compatibility APIs, bypass TOTP, and are never accepted by `/auth/login`.

## Consequences
- Native apps need the code step as well as the web app.
- A code cannot be reused within its window, so a second sign-in in the same 30 s waits for the next code.
- A leaked app password exposes only the compatibility APIs and can be revoked on its own.
