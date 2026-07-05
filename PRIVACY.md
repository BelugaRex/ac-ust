# Privacy Policy for AC-UST

**Last updated: 2026-07-06**

## Data Collection

AC-UST does **not** collect, transmit, or share any personal information or user data with any third party.

### What data does AC-UST access?

| Data | Purpose | Stored? | Transmitted? |
|------|---------|---------|-------------|
| Chrome Storage (`chrome.storage.local`) | Save user timer settings (on/off minutes, clock mode, PWM state) | ✅ Locally only | ❌ Never |
| Chrome Storage (`chrome.storage.sync`) | v0.5.6+ synchronizes timer settings + PWM phase across the same browser account's devices (so multi-device PWM doesn't fight over the AC) | ✅ Browser account sync store (user-controlled) | ⚠️ Only via the browser's own account sync feature — never sent to any AC-UST/developer server |
| HKUST Smart Power Meter page (`w5.ab.ust.hk`) | Read AC switch state, remaining balance, and toggle AC on/off | ❌ | ❌ Never |
| Chrome Alarms (`chrome.alarms`) | Schedule timed AC on/off events | ✅ Locally only | ❌ Never |
| Chrome Tabs | Open/refresh the AC control page for scheduled operations | ❌ | ❌ Never |

### What data does AC-UST NOT collect?

- ❌ No personal information (name, email, phone, etc.)
- ❌ No location data
- ❌ No browsing history
- ❌ No cookies or tracking data
- ❌ No analytics or telemetry
- ❌ No authentication credentials

## Data Storage

All data is stored **in the browser's storage** (`chrome.storage.local` per-device, plus optional `chrome.storage.sync` for users who have signed into Chrome/Edge sync to keep their timer phase aligned across devices). The extension does not communicate with any external servers. The `chrome.storage.sync` payload contains only timer config + current PWM phase (`enabled`, `onMinutes`, `offMinutes`, `activeHours`, `pwmState`, `nextTriggerAt`); **never** includes heartbeats, page tab state, or any other runtime data. If you have not signed into browser sync or have disabled extension sync, the extension gracefully falls back to local-only storage and behaves identically.

## Third-Party Services

AC-UST does not integrate with any third-party services, analytics platforms, or advertising networks.

## Changes to This Policy

Any changes to this privacy policy will be reflected in this document and the GitHub repository at [github.com/BelugaRex/ac-ust](https://github.com/BelugaRex/ac-ust).

## Contact

For questions about this privacy policy, open an issue at [github.com/BelugaRex/ac-ust/issues](https://github.com/BelugaRex/ac-ust/issues).
