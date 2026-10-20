# 0075. Named bootstrap admin and expiring generated passwords

- Status: Accepted
- Date: 2026-10-19
- Supersedes 0038

## Context
The ASVS v5.0 L1 verification (#75) failed two controls. Under 6.3.2, every AWS stage kept an enabled `admin` account, and operators were only told to disable it. Under 6.4.1, generated passwords (the AWS bootstrap password in SSM, the TTRSS importer's temporary passwords) had to be changed at first sign-in but never expired.

## Decision
- The operator names the first admin: `adminLogin` in the AWS deploy config (required), `ADMIN_LOGIN` on Docker. A login containing `admin`, `root`, or `superuser`, or that is `sa` apart from digits and separators, is refused when bootstrapping and in the deploy config. Users created later may be called anything. Startup warns while an enabled admin has such a login.
- Generated passwords set `password_change_required`, as before. While it is set, the API allows only session, login, logout, and password change, and the web app shows only the password change.
- They also expire 7 days after they are set. An expired password answers 401 `password_expired`, counts as a failed login, and ends the user's sessions. A password change or admin reset clears both.
- On AWS, the migrate function's `reissue-admin` task writes a new generated password to SSM for the first admin, but only while no other admin is active.

## Consequences
- No deployment starts with a well-known admin login. Existing stages' `admin` accounts are disabled by hand, once.
- Every deploy config needs `adminLogin` before its next synth.
- A temporary password not handed out within 7 days needs an admin reset, or `reissue-admin` for the first admin.
- Admin-chosen passwords (Docker bootstrap, admin-created users, resets) neither must change nor expire.
