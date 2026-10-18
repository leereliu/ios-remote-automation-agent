# Security and data boundaries

This is a personal prototype, not a multi-tenant service. Use only devices and hosts you are authorized to control.

- Controller, agent and device use separate bearer credentials. Device requests are limited to one configured device. There is no arbitrary network forwarding or shell API.
- Agent tool restrictions reduce the application surface; they do not provide VM isolation or guarantee immunity from malicious screen content.
- Screenshots, accessibility text and task replies leave the device, enter cloud storage and may be sent to the model. Automatic redaction is not implemented.
- Static runtime keys currently require manual rotation. A controller QR code carries a real device-control credential and must never be published.
- Cloud cleanup is lazy and bounded. It does not guarantee a 24-hour retention period. Backups, exports and local logs have separate lifetimes.
- Unknown operation outcomes must be inspected. Never automatically replay a touch or text entry after a timeout.
- Do not commit `.local/`, `*-private.json`, Codex homes, `.env`, signing material, device IDs, run logs or screenshots. Git ignore patterns are only an aid; inspect staged contents before pushing.

Please avoid posting credentials, device screenshots or personal task content in GitHub issues. This repository does not currently advertise a private security-reporting channel.
