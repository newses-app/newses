# 0092. User email

- Status: Accepted
- Date: 2026-11-14

## Context
Users want to email an article and get a digest of unread entries (#82). The server only emails operators: alerts over SMTP on Docker, and through the stage's SNS topic on AWS, which reaches confirmed topic subscribers only, all with the same message. Users have no email address, and mail sent with a user's address as `From` fails SPF and DMARC at the recipient.

## Decision
- A `Mailer` port sends user mail; `Notifier` stays operator-only. One nodemailer adapter sends over SMTP (`SMTP_URL`) on Docker and through nodemailer's SES transport (the SES v2 API, raw MIME) on AWS, with the functions' IAM role and the stage's configuration set.
- `SMTP_URL` alone turns user mail on; `ALERT_EMAIL_TO` still decides alert email.
- Every user mail comes from the instance's address (`MAIL_FROM`, default `newses@` the public host; on AWS the stage domain, an SES identity the stack creates with DKIM and a custom MAIL FROM domain). A user's address only appears as `Reply-To`.
- Users add an address to their account and confirm it from a link mailed to it; only a confirmed address receives digests or appears as `Reply-To`.
- User mail is written in the owner's `language` preference from the server's locale files; operator alerts stay untranslated.
- Mail sent on a schedule carries one-click unsubscribe (RFC 8058).

## Consequences
- A Docker install with SMTP can email users; an AWS stage needs SES production access before it can mail addresses SES has not verified.
- The SES SDK is a Lambda-only dependency, kept out of the Docker image.
- Recipients see the instance as the sender, and replies reach the user.
