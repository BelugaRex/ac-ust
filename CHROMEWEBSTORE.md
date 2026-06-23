# AC-UST — Chrome Web Store Listing Metadata

## Extension Overview
- **Name**: AC-UST
- **Version**: 0.4.3
- **Manifest**: MV3
- **Category**: Productivity / Utilities

## Short Description (132 chars max)
Auto-control HKUST Smart Power Meter air conditioning with clock-synced PWM scheduling. Odd hours ON, even hours OFF. Save balance effortlessly.

## Detailed Description
AC-UST automatically controls the air conditioning switch on the HKUST Smart Power Meter web portal (w5.ab.ust.hk). It uses a clock-synchronized PWM (Pulse Width Modulation) schedule to toggle the AC on and off at precise hour boundaries:

- **Clock Mode (default)**: AC turns ON at odd-numbered hours (1:00, 3:00, 5:00...23:00) and OFF at even-numbered hours (0:00, 2:00, 4:00...22:00).
- **Interval Mode**: Custom ON/OFF minute intervals with manual override.

Key features:
- One-click "Timer ON" / "Timer OFF" from the popup
- Real-time countdown to next toggle with clock-time display
- Badge shows minutes remaining until next action
- Auto-confirms page dialogs (no manual clicking needed)
- Reliable background execution with heartbeat keepalive
- Stabilization verification prevents UI rollback false-positives
- Pinned AC page support for faster toggling

## Permissions Justification
| Permission | Why Needed |
|-----------|------------|
| `alarms` | Schedule PWM toggles at precise wall-clock times |
| `storage` | Save user settings (clock mode, intervals, schedule state) |
| `tabs` | Find and interact with the HKUST Power Meter page |
| `offscreen` | Keep Service Worker alive for reliable background timing |
| `scripting` | Fallback injection if content script is not loaded |

## Host Permissions
- `https://w5.ab.ust.hk/njggt/app/*` — Required to read AC status, click the switch, and read balance on the HKUST Smart Power Meter portal.

## Screenshots
<!-- Add paths to screenshots after capturing -->
- `screenshots/popup-clock-mode.png` — Popup showing clock mode with countdown
- `screenshots/popup-interval-mode.png` — Popup showing interval mode
- `screenshots/ac-page.png` — AC control page with extension badge

## Privacy
- No data collection
- No analytics
- No external network requests beyond the HKUST portal
- All settings stored locally via chrome.storage.local

## Support
- GitHub: https://github.com/BelugaRex/ac-ust
- Issues: https://github.com/BelugaRex/ac-ust/issues
