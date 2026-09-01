# Privacy Policy for AC-UST

**Last updated: 2026-09-01**

## Summary

AC-UST does not sell personal data and does not send personal information, website content, settings, diagnostics, or usage data to the developer, analytics providers, or advertising networks.

To perform its single purpose, the extension processes limited content from the HKUST Smart Power Meter portal, sends the user's requested or scheduled control actions to that portal, fetches public weather observations from the Hong Kong Observatory, and may use the browser's own account-sync service when the user has enabled extension sync. AC-UST does not operate a developer-controlled data server.

## Data Handled

| Data | Purpose | Storage | Network use |
| --- | --- | --- | --- |
| Settings and runtime state | Store PWM durations, smart-control sensitivity, active hours, phase, deadlines, retry state, and related operating status | `chrome.storage.local` on the user's device | None, except the limited sync fields described below |
| Synced configuration | Align enabled state, durations, active hours, smart-control configuration, PWM phase, and next trigger across devices in the same browser ecosystem | `chrome.storage.sync`, controlled by the user's Chrome/Edge account settings | Sent only through the browser vendor's sync service; never through an AC-UST or developer server |
| HKUST portal content | Read AC switch state, Charge Mode, remaining balance, and the `Power-off after` value; perform configured startup and timer actions | Current values and the most recent valid balance may be cached in `chrome.storage.local`; the balance is also copied to `chrome.storage.session` as a same-session hot cache. Raw DOM and credentials are not stored | Control actions are submitted only to the user-authenticated `w5.ab.ust.hk` portal as required to operate the AC |
| Hong Kong Observatory weather | Calculate smart-control ON time from Tseung Kwan O temperature, relative humidity, and wind observations; rainfall is not requested or used | The most recent successful observation is cached locally. After one hour it is treated as stale, but may remain as a fallback until a later refresh succeeds or extension storage is cleared | Fetched over HTTPS from `data.weather.gov.hk`; requests do not include HKUST account data, portal content, extension settings, balances, or diagnostics |
| Local diagnostic log | Let the user inspect recent background failures | Up to 50 redacted entries in `chrome.storage.local`; each entry contains only timestamp, severity, code-stage label, and a truncated message | Never uploaded or synced |
| Browser alarms and matching tabs | Schedule operations and find or open the exact HKUST AC page | Alarm metadata and relevant runtime state remain local | Other tabs are not read, recorded, or transmitted |

## Data Not Collected by the Developer

- No names, email addresses, phone numbers, student IDs, or other identity data
- No authentication credentials, cookies, session tokens, or passwords
- No browsing history or activity from unrelated tabs
- No precise location or geolocation API data
- No raw DOM snapshots, balances, or account details in diagnostics; diagnostic messages redact URLs and email-like text before local storage
- No analytics, telemetry, advertising identifiers, or behavioral profiles

## Network Communications

AC-UST limits network activity to:

1. **HKUST Smart Power Meter (`w5.ab.ust.hk`)** — the user signs in directly to HKUST. The extension reads the AC controls in that authenticated page and submits only the configured AC actions. It does not read or store the user's password.
2. **Hong Kong Observatory (`data.weather.gov.hk`)** — the extension fetches fixed public temperature, relative-humidity, and wind endpoints for local smart-control calculations. It does not request rainfall or attach user, HKUST, settings, balance, or diagnostic data to the requests.
3. **Chrome/Edge account sync** — if enabled by the user, the browser vendor syncs a limited configuration and phase payload through `chrome.storage.sync`. Diagnostic logs, weather data, balances, page content, and runtime heartbeats are excluded.

There are no AC-UST developer servers, remote-code services, analytics platforms, or advertising networks.

## Local Storage and Retention

- Settings and runtime state remain in browser extension storage until the user changes them, clears extension data, or removes the extension, subject to the browser's own storage behavior.
- The weather cache is scheduled to refresh hourly. If a refresh fails, the most recent successful observation may remain as a stale fallback until a later refresh succeeds or extension storage is cleared.
- The diagnostic ring stores at most 50 redacted entries and is reset when the installed extension version changes.
- AC-UST does not store raw HKUST page HTML or authentication credentials.

## Third-Party Services

The extension relies only on the HKUST Smart Power Meter portal, the Hong Kong Observatory public weather API, and the optional Chrome/Edge browser-sync service described above. Their own privacy and retention practices are governed by their respective operators. AC-UST does not integrate with third-party analytics, advertising, data-broker, or payment services.

## Remote Code

AC-UST does not download or execute remote JavaScript, WebAssembly, or other code. All executable extension code is included in the submitted extension package.

## Changes to This Policy

Policy changes will be published in this repository. The “Last updated” date will change when the extension's data handling changes.

## Contact

For privacy questions, open an issue at [github.com/BelugaRex/ac-ust/issues](https://github.com/BelugaRex/ac-ust/issues).