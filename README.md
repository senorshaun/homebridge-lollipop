# homebridge-lollipop

Lollipop cameras in [Homebridge](https://homebridge.io): local video, microphone audio, camera-event sensors and Music switches.

Requires Homebridge 2.x and Node `^22.12.0 || ^24.0.0 || ^26.0.0`. This branch is available through [PR #2](https://github.com/senorshaun/homebridge-lollipop/pull/2), not yet released to npm.

## Setup

1. Install the PR branch and open the plugin settings. To diagnose sign-in, enable **Debug** in the standard Homebridge form first.
2. Click **Sign in / reconnect**, enter your Lollipop account credentials and complete email verification if requested.
3. Click Homebridge’s **Save** button, then restart the child bridge or Homebridge.

No IP address, camera ID or certificates are required. The plugin discovers account cameras and connects to them locally; Homebridge must be able to reach their network. Sessions and MQTT credentials are stored privately on the host. Interactive sign-in does not save passwords or verification codes in `config.json`.

```json
{ "platform": "Lollipop", "account": { "email": "you@example.com" } }
```

Homebridge manages settings, child bridges and accessory restoration. A child bridge isolates the plugin process. **Unbridge** is a separate per-camera option requiring individual HomeKit pairing; leave it off to keep cameras on the child bridge.

## Features and settings

- **Music:** The switch plays/repeats or pauses the sound selected in the Lollipop app. It waits for camera-reported playback confirmation.
- **Sensors:** Motion, crying, crossing and noise events. Configure the corresponding camera alerts in the Lollipop app.
- **Preferences:** The standard form exposes audio, Music, sensitivity and optional camera overrides. `accountCameraName` selects an account camera; `name` sets its HomeKit name.
- **Debug:** Enable temporarily and restart the child bridge for runtime logging. Setup diagnostics appear in the Homebridge UI backend log; camera diagnostics appear in the Homebridge runtime log. Review logs for private details before posting them.

Manual video setup remains available without an account: supply `cameraId` plus `ip`, or a complete authenticated `rtspUrl`. This direct mode does not provide MQTT Music controls or sensors.

## Limitations

Authenticated-camera mode does not support HomeKit Secure Video or two-way talk. Snapshot and stream startup can take several seconds; some firmware produces FFmpeg timestamp warnings despite successful playback.

[Authentication protocol notes](docs/mqtt-authentication.md). Originally based on [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg).
