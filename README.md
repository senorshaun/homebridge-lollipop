# homebridge-lollipop
 
[Homebridge](https://homebridge.io) Plugin Providing [Lollipop Baby Camera](https://www.lollipop.camera) Support

## Installation
This plugin is supported under [Homebridge](https://homebridge.io) and is untested on [HOOBS](https://hoobs.org). It is highly recommend that you use [Homebridge Config UI X](https://www.npmjs.com/package/homebridge-config-ui-x) to install and configure this plugin.

## Configuration
- `platform`: __(Required)__ Must be set to `Lollipop`
- `debug`: _(Boolean)_ When set to `true`, lots of data will be populated in to the logs. Its recommended you only set this temporarily
- `cameras`: _(Array of objects)_ It's likely you will only have one camera object, but multiple are allowed
- `name`: __(Required)__ This is the name of the Lollipop that will appear in the logs and initially in the Home App
- `ip`: __(Required)__ This is the IP address of the Lollipop. It's recommended you set a DHCP reservation in your router or you may need to update this field if it stops responding in HomeKit.
- `unbridge`: _(Boolean)_ Recommend to be set to `true` when this plugin is not configured to run as a child bridge. Camera streaming can slow down other plugins on the same bridge. When set to `true`, the camera will need to be paired within HomeKit. NOTE: The sensor names attached the camera will default to the camera name upon plugin restart when set this is set to `true` 
- `enableSoundMachine`: _(Boolean)_ Creates a switch that will play the queued sound effect or song within the Lollipop app when turned on, and pause when turned off. Even if the camera is configured as `unbridge`:`true`, this switch will be presented bridged and does not need to be paired
### Sensors
- `contactSensors`: _(Boolean)_ When not set, or set to `false`, the enabled sensors will be presented as Motion Sensors. When set to `true`, they will be preseneted as Contact Sensors
- `hksv`: _(Boolean)_ Enable the camera to be compatible with HomeKit Secure Video. When set to `true`, an additional motion sensor is configured and attached to the camera that triggers on any other sensor trigger. It is this sensor that triggers HomeKit to record motion. NOTE: This sensor will always be configured as a Motion Sensor regardless of `contactSensors`. You must have a home hub and supported iCloud plan for this to be useful
- `movementSensitivity`: _(Integer)_ When set to a value greater than 0, a sensor will be added to the camera that is triggered when the motion level detected by the Lollipop is greater than this setting. Homebridge Config UI X presents predefined names for some values. 0:`Disabled`, 2:`High`, 5:`Medium`, 10:`Low`. This sensor automatically resets after 30 seconds of the motion level not being greater than this setting
- `enableCryingDetectionSensor`: _(Boolean)_ When set to `true`, a sensor will be added to the camera that is triggered any time the Lollipop determines crying is detected above the level set within the Lollipop app, as long as Crying Detection is enabled within the Lollipop app. This sensor automatically resets 60 seconds after the last Crying Detection event
- `enableCrossingDetectionSensor`: _(Boolean)_ When set to `true`, a sensor will be added to the camera that is triggered any time the Lollipop determines barrier crossing is detected, as long as Crossing Detection is enabled within the Lollipop app. This sensor automatically resets 60 seconds after the last Crossing Detection event
- `enableNoiseSensor`: _(Boolean)_ When set to `true`, a sensor will be added to the camera that is triggered any time the Lollipop determines noise levels are above the in app configured threshold, as long as Crossing Detection is enabled within the Lollipop app. This sensor automatically resets 60 seconds after the last Noise event

### Config Example
```json
{
	"platform": "Lollipop",
	"cameras": [
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

 ## To-Do
  - Get Two-Way Audio working
  - Find a solution to the sensor name issue, if there is one in the future
  - If there is a request for being able to change the sound machine track or more control over it, the code could be updated to change the presented accessory to a TV that has sources for each track, volume control, and power to play/pause

  ## Credit
  I started with the [homebridge-camera-ffmpeg](https://github.com/Sunoo/homebridge-camera-ffmpeg) code base, removed and added as needed, so thank you for the work already done by [Sunoo](https://www.github.com/Sunoo)