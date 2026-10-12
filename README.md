# homebridge-lollipop

A [Homebridge](https://homebridge.io) plugin for [Lollipop baby cameras](https://www.lollipop.camera), with local video, snapshots, camera-event sensors, and a sound-machine switch.

The account setup in this branch implements the authentication flow recovered from the signed Android app. **It is a draft pending testing with a physical Lollipop camera.** Local protocol, account-flow, and Homebridge-boundary tests pass; current vendor responses and camera firmware acceptance remain to be checked.

## Installation

Install this plugin through Homebridge. [Homebridge Config UI X](https://github.com/homebridge/homebridge-config-ui-x) provides the account sign-in screen. This plugin is untested on HOOBS.

Development changes are on `fix/authenticated-rtsp` in [draft PR #2](https://github.com/senorshaun/homebridge-lollipop/pull/2). They are not an npm release.

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
| `debug` | Platform-level diagnostic logging; camera URLs and stream keys are redacted. |

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

- **Email code/sign-in needed:** reopen plugin settings, complete sign-in, and restart the child bridge.
- **No local address:** ensure the camera is online in the Lollipop app. Discovery will retry automatically.
- **MQTT unavailable:** check that Homebridge can reach the camera on local TCP 1883. Logs distinguish TLS, MQTT login, and subscription failures. Video can still start if only MQTT provisioning is unavailable.
- **Camera cannot confirm a sound change:** check the selected sound and connectivity in the Lollipop app. The switch reports an error instead of replaying the request later.
- **Camera IP changed:** allow the next five-minute account refresh. Restarting the child bridge also refreshes discovery.

## Development checks

Run `npm install`, then `npm test` with Node.js 18 or newer. The tests exercise account/OTP responses, private storage, cloud-outage and revocation handling, real certificate/key validation, Homebridge integration, switch confirmation, MQTT reconnects, log redaction, and media lifecycle behavior. The local TLS/MQTT integration tests require the installed `mqtt` dependency and an `openssl` executable to generate temporary synthetic certificates.

The app protocol is supported by signed Android versions 3.11.11 (June 2023) and 4.5.2 (February 2025). Tests use account fixtures, synthetic identities, and local brokers. They do not establish acceptance by a physical camera, current vendor account service, or a HomeKit hub.

## Credit

This project started with [homebridge-camera-ffmpeg](https://github.com/Sunoo/homebridge-camera-ffmpeg). Thank you to [Sunoo](https://github.com/Sunoo) and its contributors.
