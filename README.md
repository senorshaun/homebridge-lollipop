# homebridge-lollipop

A [Homebridge](https://homebridge.io) plugin for [Lollipop baby cameras](https://www.lollipop.camera), with local video, snapshots, camera-event sensors, and a sound-machine switch.

The account setup in this branch implements the authentication flow recovered from the signed Android app. **It is a draft pending testing with a physical Lollipop camera.** Local protocol, account-flow, and Homebridge-boundary tests pass; current vendor responses and camera firmware acceptance remain to be checked.

## Installation

Install this plugin through Homebridge. [Homebridge Config UI X](https://github.com/homebridge/homebridge-config-ui-x) provides the account sign-in screen. This plugin is untested on HOOBS.

Development changes are on `fix/authenticated-rtsp` in [draft PR #2](https://github.com/senorshaun/homebridge-lollipop/pull/2). They are not an npm release.

### Homebridge and Node.js requirements

This branch targets **Homebridge 2.x**. The recommended test setup is **Homebridge 2.4.0 with Node.js 24.21.0 LTS**. The supported Node.js ranges are `^22.12.0 || ^24.0.0 || ^26.0.0`; use the latest patch release in the chosen supported major.

| Component | Version used by this branch | Purpose |
| --- | --- | --- |
| [Homebridge](https://github.com/homebridge/homebridge/blob/latest/package.json) | `2.4.0` for development/tests; runtime compatibility `^2.0.0` | Test against the current stable 2.x API while accepting compatible 2.x installations. |
| [Node.js LTS](https://nodejs.org/en/blog/release/v24.21.0) | `24.21.0`, also recorded in `.nvmrc` | Recommended stable LTS runtime for testers and development. |
| [Plugin UI utilities](https://github.com/homebridge/plugin-ui-utils/releases/tag/v2.2.6) | `^2.2.6`, locked to `2.2.6` | Load the current ESM settings-server utility through an asynchronous import. |
| [MQTT.js](https://github.com/mqttjs/MQTT.js/releases/tag/v5.16.0) | `^5.16.0`, locked to `5.16.0` | Support local-IP TLS connections on current Node.js releases. |

These stable versions were verified on October 12, 2026. Node 26 is supported by current Homebridge and by this plugin's engine range; it is still the Node.js Current release line at that date. Node 24 LTS is the recommended baseline. `engines` expresses compatibility; updating this plugin does not install or upgrade Homebridge or Node.js on the host. Homebridge is a development dependency only, so the plugin uses the host's injected Homebridge/HAP API in production.

The MQTT client upgrade fixes the previous client's use of IP addresses as TLS server names, which Node 26 rejects. MQTT.js 5 continues to use the camera's MQTT 3.1.1 protocol, and the account-mode certificate, private-CA, and authentication checks remain enabled.

## Automatic account setup

1. Open the Lollipop plugin's settings in Homebridge Config UI X.
2. Sign in with the email address and password for the Lollipop account that owns the camera.
3. If Lollipop sends an email verification code, enter it in the next step. A mistyped code can be retried; an expired code requires a new sign-in.
4. Review the discovered camera names, then restart Homebridge or the plugin's child bridge. The sign-in screen saves the account configuration automatically.

**You do not need to enter an IP address, camera ID, RTSP URL, or certificate.** The plugin reads each camera's ID and local address from its account record, derives its RTSP credentials, provisions its MQTT client certificate/private key, and connects to local MQTT over TLS on port 1883.

All cameras returned by the account are discovered by default. The sound-machine switch and microphone audio are enabled. Homebridge must be able to reach the cameras on the local network; account sign-in does not tunnel local video or MQTT through the internet.

The resulting configuration looks like this:

```json
{
  "platform": "Lollipop",
  "account": {
    "email": "you@example.com"
  },
  "cameraDefaults": {
    "audio": true,
    "enableSoundMachine": true
  }
}
```

Interactive sign-in uses the password only for the authentication request. It stores the resulting session, camera metadata, and verified MQTT identity in Homebridge's private storage, with owner-only directory/file permissions. It does not put the password, token, camera ID, or client key into `config.json`. Existing account passwords or manually supplied tokens are removed from the configuration after successful interactive sign-in.

The plugin refreshes account camera records every five minutes and updates local addresses without recreating the HomeKit camera. Valid MQTT identities are reused for twelve hours before refreshing. During a network or server outage, previously authenticated metadata and still-valid credentials can be reused for up to seven days. Authentication rejection, TLS verification failure, and denied access do not use the outage fallback. Existing local connections continue during a cloud outage. Expired or revoked sessions require sign-in again.

### Sound-machine switch

The HomeKit switch uses the same authenticated MQTT connection as the camera's event subscriptions:

- **On:** resume the sound selected in the Lollipop app and repeat it.
- **Off:** pause playback.
- After subscribing or reconnecting, query the camera's current sound status.
- Complete a switch change after receiving the requested playback state from the camera. Disconnection, rejection, or no confirmation within eight seconds returns an error to HomeKit.

Select the track or sound in the Lollipop app first. Track selection, volume controls, and two-way talk are not implemented. Interactive commands are not queued for replay after a disconnection.

### Camera preferences and existing HomeKit accessories

Open **Camera preferences and advanced settings** to configure defaults and individual cameras. `cameraDefaults` applies to every discovered camera. Optional `lollipops` entries override those defaults:

```json
{
  "platform": "Lollipop",
  "account": { "email": "you@example.com" },
  "cameraDefaults": {
    "audio": true,
    "enableSoundMachine": true,
    "movementSensitivity": 10
  },
  "lollipops": [
    {
      "accountCameraName": "Nursery",
      "name": "Crib",
      "enableCryingDetectionSensor": true
    },
    {
      "accountCameraName": "Guest room",
      "enabled": false
    }
  ]
}
```

`accountCameraName` is the name displayed in the Lollipop app; `name` is the HomeKit name. An optional raw `cameraId` is available as an advanced selector if account camera names are ambiguous. A `name` that matches the app camera name also selects that camera. A single existing camera configuration is automatically matched to a single account camera, retaining its HomeKit name and settings.

Existing cached camera/switch identities are reused when they can be matched. Newly discovered cameras use stable identities based on their camera ID, so changing a DHCP address or the name in the Lollipop app does not create another HomeKit camera. An existing manual `ip` is superseded by account discovery. A camera temporarily missing its address remains selected until the account reports its address.

| Setting | Behavior |
| --- | --- |
| `audio` | Listen to the camera microphone; default `true`. |
| `enableSoundMachine` | Expose the playback switch; default `true` for account cameras. |
| `unbridge` | Publish the camera separately; it must then be paired in the Home app. The sound switch stays bridged. |
| `movementSensitivity` | `0` disables movement; `10` low, `5` medium, `2` high sensitivity. Account default is `10`. |
| `enableCryingDetectionSensor` | Expose the camera's crying events, configured in the Lollipop app. |
| `enableCrossingDetectionSensor` | Expose the camera's configured barrier-crossing events. |
| `enableNoiseSensor` | Expose the camera's configured noise events. |
| `contactSensors` | Present configured event sensors as contact sensors. |
| `debug` | Enable account, discovery, TLS/MQTT, sound-switch, sensor, and FFmpeg diagnostics. Available on the main setup screen; restart the child bridge to apply it to running cameras. |

**HomeKit Secure Video remains unavailable in account mode.** The recovered recording delegate has separate unfinished work; this change restores the account/MQTT/video path and sound control. Event sensors can operate without enabling HKSV.

### Setup without the sign-in screen

For an account without email verification enabled, a headless configuration may supply `account.email` and a masked `account.password`. An existing legitimate `account.sessionToken` may be used instead. These advanced fields are stored in the Homebridge configuration by the user; the interactive sign-in flow avoids storing them there.

If an email code is required, finish sign-in through the plugin settings instead of repeatedly restarting with a password. The plugin stops automatic login attempts when verification or corrected credentials are required. Do not paste passwords, tokens, complete camera URLs, IDs, or downloaded keys into issue reports.

## Manual video setup

Manual configuration remains available by omitting `account`.

### Known camera ID

```json
{
  "platform": "Lollipop",
  "lollipops": [
    {
      "name": "Crib",
      "ip": "192.168.0.2",
      "cameraId": "YOUR_CAMERA_PAIRING_ID",
      "audio": true,
      "unbridge": true
    }
  ]
}
```

The plugin derives the RTSP password from the original pairing ID and an optional `rtspUsername` (default `homebridge`). The ID is the account camera's object ID, not the printed hardware serial or the already-hashed stream path. Manual ID mode supplies video, snapshots, and listening audio; it has no account session to provision MQTT, so the sound switch, sensors, and HKSV are disabled.

### Complete authenticated URL

Supply `rtspUrl` instead of `ip` and `cameraId` when you already have a working authenticated stream URL. It takes precedence over the derived credentials and preserves its path and query. An optional `ip` must match its host. Percent-encode special characters in the username/password.

```json
{
  "platform": "Lollipop",
  "lollipops": [
    {
      "name": "Crib",
      "rtspUrl": "rtsp://USERNAME:PASSWORD@192.168.0.2:554/live/EXISTING_STREAM_ID/ch00_0"
    }
  ]
}
```

This is also video-only without an account. The owner's Android app database can contain an authenticated URL: `LollipopProvider.db`, `baby_camera`, `internal_live_url`; see the [original recovery write-up](https://dparv.dev/2023/08/16/reverse-engineering-lollipop-camera.html). The Android **cloud camera record** uses the same field name for a bare local address; the account implementation handles that distinction.

### Older firmware with anonymous MQTT

For older cameras that permit unauthenticated MQTT, configure `name` and `ip` while omitting `account`, `cameraId`, and `rtspUrl`. Discovery subscribes to camera topics for at most fifteen seconds. The legacy `pairingID` setting skips this discovery step when already known. This mode retains the older anonymous TLS behavior; it does not substitute for authenticated account setup on newer firmware.

## Protocol and troubleshooting

The [MQTT authentication notes](docs/mqtt-authentication.md) record the recovered account requests, credential checks, TLS policy, password derivations, certificate provenance, and control messages. See also the [original firmware issue](https://github.com/senorshaun/homebridge-lollipop/issues/1).

### Debug logging and hardware testing

Turn on **Enable debug logging** at the top of the plugin settings **before signing in**. Setup requests use the setting immediately, including verification-code retries. The checkbox saves the platform's `debug` option; restart the Lollipop child bridge or Homebridge to apply it to running cameras. For a manual configuration, set `"debug": true` beside `"platform": "Lollipop"`.

The logs trace account requests and response structure, session/cache use, camera discovery, certificate downloads and validation, TLS negotiation, MQTT acceptance and subscriptions, reconnects, sound command confirmation, and video/snapshot failures. Each structured record has a sequence number and a fixed event name. Cameras and streams use temporary aliases instead of camera IDs or HomeKit session IDs. Frequent MQTT messages are sampled; payloads are not dumped.

Diagnostics go to the existing Homebridge and Homebridge UI process logs. The plugin does not create a separate log file. Passwords, verification codes, tokens, credential URLs, camera IDs, certificates/private keys, and HomeKit stream keys are redacted or excluded. Review any visible display names and messages from other plugins before sharing an excerpt.

For a physical-camera test, follow the **[hardware testing and debug-log guide](docs/testing.md)**. It includes the test sequence, which log to collect for each failure, and a report template. Current tests use synthetic accounts and a local TLS/MQTT broker; physical-camera and current vendor-service testing are still needed.

- **Email code/sign-in needed:** reopen plugin settings, complete sign-in, and restart the child bridge.
- **No local address:** ensure the camera is online in the Lollipop app. Discovery will retry automatically.
- **MQTT unavailable:** check that Homebridge can reach the camera on local TCP 1883. Logs distinguish TLS, MQTT login, and subscription failures. Video can still start if only MQTT provisioning is unavailable.
- **Camera cannot confirm a sound change:** check the selected sound and connectivity in the Lollipop app. The switch reports an error instead of replaying the request later.
- **Camera IP changed:** allow the next five-minute account refresh. Restarting the child bridge also refreshes discovery.

## Development checks

Use a supported Node.js version (`nvm use` selects the recommended LTS version when nvm is installed), then run `npm ci` and `npm test`. The lockfile installs the stable Homebridge development dependency and ESM UI utility along with the runtime dependencies. The tests exercise account/OTP responses, private storage, cloud-outage and revocation handling, real certificate/key validation, Homebridge integration, switch confirmation, MQTT reconnects, log redaction, and media lifecycle behavior. The local TLS/MQTT integration tests require the installed `mqtt` dependency and an `openssl` executable to generate temporary synthetic certificates.

Compatibility tests load the plugin through Homebridge's real plugin loader, construct real HAP camera/switch/sensor services, and run the settings backend through the installed UI utility's subprocess/IPC protocol. Camera preparation and stream-start failures must reach Homebridge's callbacks exactly once and release their session resources. These checks require development dependencies, so use `npm ci` without `--omit=dev` when running tests.

The app protocol is supported by signed Android versions 3.11.11 (June 2023) and 4.5.2 (February 2025). Tests use account fixtures, synthetic identities, and local brokers. They do not establish acceptance by a physical camera, current vendor account service, or a HomeKit hub.

## Credit

This project started with [homebridge-camera-ffmpeg](https://github.com/Sunoo/homebridge-camera-ffmpeg). Thank you to [Sunoo](https://github.com/Sunoo) and its contributors.
