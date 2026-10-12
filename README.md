# homebridge-lollipop
 
[Homebridge](https://homebridge.io) Plugin Providing [Lollipop Baby Camera](https://www.lollipop.camera) Support

## Installation
This plugin is supported under [Homebridge](https://homebridge.io) and is untested on [HOOBS](https://hoobs.org). It is highly recommend that you use [Homebridge Config UI X](https://www.npmjs.com/package/homebridge-config-ui-x) to install and configure this plugin.

## Configuration
### Cameras with authenticated firmware

Configure the camera's **complete authenticated RTSP URL**. The plugin uses that
URL directly for live video and snapshots, without waiting for MQTT discovery.
Listening audio is enabled by default and can be disabled with `audio: false`.

```json
{
  "platform": "Lollipop",
  "lollipops": [
    {
      "name": "Crib",
      "rtspUrl": "rtsp://STREAM_USERNAME:STREAM_PASSWORD@192.168.0.2:554/live/EXISTING_STREAM_ID/ch00_0",
      "audio": true,
      "unbridge": true
    }
  ]
}
```

Replace the example with the URL supplied by your own camera/app. Keep its path
unchanged; do not hash its stream identifier again. URL special characters in the
username and password must be percent-encoded. An optional `ip` must match the
URL's host. The settings UI masks the URL, and plugin logs redact camera URLs and
HomeKit stream keys.

This mode provides video, snapshots, and listening audio. Camera motion, crying,
crossing, and noise events, the sound-machine switch, and event-triggered HomeKit
Secure Video recording require MQTT and are disabled in this mode. Cached sensor
and sound-machine accessories are removed; the camera retains its existing
name-based HomeKit identity. Two-way talk is not implemented.

The URL can be recovered from the owner's Android app database on a rooted device
or emulator: `LollipopProvider.db`, table `baby_camera`, column `internal_live_url`.
See the [original recovery write-up](https://dparv.dev/2023/08/16/reverse-engineering-lollipop-camera.html)
and [the firmware issue](https://github.com/senorshaun/homebridge-lollipop/issues/1).
That is an external credential-recovery step; the plugin does not access the app
database or generate camera passwords. Treat the complete URL as a credential
and do not include it in issue reports.

### MQTT firmware and common settings

For cameras that still allow local MQTT without client authentication, configure
`ip` and omit `rtspUrl`. MQTT discovery is bounded to 15 seconds and stops with an
actionable error if it fails. An optional known `pairingID` skips discovery; it
does not provide authentication for newer firmware.

- `platform`: __(Required)__ Must be set to `Lollipop`
- `debug`: _(Boolean)_ When set to `true`, lots of data will be populated in to the logs. Its recommended you only set this temporarily
- `lollipops`: _(Array of objects)_ It's likely you will only have one camera object, but multiple are allowed
- `name`: __(Required)__ This is the name of the Lollipop that will appear in the logs and initially in the Home App
- `ip`: _(Required when `rtspUrl` is omitted)_ The IP address or hostname of the Lollipop. A DHCP reservation avoids changes to a configured IP address.
- `rtspUrl`: _(String)_ Complete authenticated RTSP URL. This selects the video mode described above.
- `audio`: _(Boolean, default `true`)_ Enable listening audio from the camera microphone.
- `pairingID`: _(Optional string, MQTT firmware only)_ A known camera pairing ID that avoids the initial MQTT discovery step.
- `unbridge`: _(Boolean)_ Recommend to be set to `true` when this plugin is not configured to run as a child bridge. Camera streaming can slow down other plugins on the same bridge. When set to `true`, the camera will need to be paired within HomeKit. NOTE: The sensor names attached the camera will default to the camera name upon plugin restart when set this is set to `true` 
- `enableSoundMachine`: _(Boolean)_ Creates a switch that will play the queued sound effect or song within the Lollipop app when turned on, and pause when turned off. Even if the camera is configured as `unbridge`:`true`, this switch will be presented bridged and does not need to be paired
### Sensors (MQTT connection required)
- `contactSensors`: _(Boolean)_ When not set, or set to `false`, the enabled sensors will be presented as Motion Sensors. When set to `true`, they will be preseneted as Contact Sensors
- `hksv`: _(Boolean)_ Enable the camera to be compatible with HomeKit Secure Video. When set to `true`, an additional motion sensor is configured and attached to the camera that triggers on any other sensor trigger. It is this sensor that triggers HomeKit to record motion. NOTE: This sensor will always be configured as a Motion Sensor regardless of `contactSensors`. You must have a home hub and supported iCloud plan for this to be useful
- `movementSensitivity`: _(Integer)_ When set to a value greater than 0, a sensor will be added to the camera that is triggered when the motion level detected by the Lollipop is greater than this setting. Homebridge Config UI X presents predefined names for some values. 0:`Disabled`, 2:`High`, 5:`Medium`, 10:`Low`. This sensor automatically resets after 30 seconds of the motion level not being greater than this setting
- `enableCryingDetectionSensor`: _(Boolean)_ When set to `true`, a sensor will be added to the camera that is triggered any time the Lollipop determines crying is detected above the level set within the Lollipop app, as long as Crying Detection is enabled within the Lollipop app. This sensor automatically resets 60 seconds after the last Crying Detection event
- `enableCrossingDetectionSensor`: _(Boolean)_ When set to `true`, a sensor will be added to the camera that is triggered any time the Lollipop determines barrier crossing is detected, as long as Crossing Detection is enabled within the Lollipop app. This sensor automatically resets 60 seconds after the last Crossing Detection event
- `enableNoiseSensor`: _(Boolean)_ When set to `true`, a sensor will be added to the camera that is triggered any time the Lollipop determines noise levels are above the in app configured threshold, as long as Crossing Detection is enabled within the Lollipop app. This sensor automatically resets 60 seconds after the last Noise event

### MQTT Config Example
```json
{
	"platform": "Lollipop",
	"lollipops": [
		{
			"name": "Crib",
			"ip": "192.168.0.2",
			"enableSoundMachine": true,
			"movementSensitivity": 10,
			"enableCryingDetectionSensor": true
		}
	]
}
```

## Notes
 - Sensors attached to the camera will change their name to the name of the camera after they are added in the Home app, regardless of what they are named when initially added. If the camera is not set up as `unbridge`, the names can be changed and they won't revert naming on restart. However if it is set as `unbridge`, they will revert naming to the camera name after every restart.

## Development checks

Run `npm test` with Node.js 18 or newer. These tests use mocked Homebridge, MQTT,
and process boundaries to check startup, URL handling, credential redaction,
session cleanup, and FFmpeg success/failure reporting. They do not establish
compatibility with a particular physical camera or firmware.

 ## To-Do
  - Get Two-Way Audio working
  - Find a solution to the sensor name issue, if there is one in the future
  - If there is a request for being able to change the sound machine track or more control over it, the code could be updated to change the presented accessory to a TV that has sources for each track, volume control, and power to play/pause

  ## Credit
  I started with the [homebridge-camera-ffmpeg](https://github.com/Sunoo/homebridge-camera-ffmpeg) code base, removed and added as needed, so thank you for the work already done by [Sunoo](https://www.github.com/Sunoo)
