# 0038. Generated passwords must be changed at first sign-in

- Status: Accepted
- Date: 2026-10-07

## Context
On AWS the first admin, `admin`, gets a random password generated into SSM (0033) when the database is empty. Nothing stopped it from being used indefinitely, which fails ASVS v5.0 6.4.1: system-generated initial passwords must not become long-term passwords. Docker operators choose `ADMIN_PASSWORD` themselves.

## Decision
- Users get a `password_change_required` flag, set only when a generated password is used (the AWS bootstrap admin) and cleared by any password change or reset.
- While it is set, the API allows only session, login, logout, and password change; every other authenticated request gets 403 `password_change_required`. The web app redirects to a dedicated password change view.
- Operators are told to create a personal admin and disable `admin`.

## Consequences
- A leaked SSM value is useful only until the admin's first sign-in.
- Native and compatibility clients see 403s until the password is changed in the web app.
- Admin-chosen passwords (Docker bootstrap, admin-created users, resets) are not forced to change.
