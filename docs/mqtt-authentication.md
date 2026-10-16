# Lollipop authentication

Recovered from the author's beta.5 code and signed Android apps examined for [PR #2](https://github.com/senorshaun/homebridge-lollipop/pull/2). A tester confirmed account discovery, video, audio, motion and Music on two cameras with firmware `2025111400-g389c1ce10`; other firmware remains unverified.

1. Sign in to the Lollipop Parse service, complete email verification if required, and list cameras to obtain pairing IDs and local addresses.
2. POST `{"cameraId":"<pairing-id>","version":"0"}` to `https://parse-api.lollipop.camera/parse/functions/getCameraMQTTKeyLink` using the account session and application headers.
3. Download the returned `cert` and `key` URLs without forwarding account headers. Verify raw-byte MD5 checksums (`certChecksum`, `keyChecksum`), certificate dates and key matching.
4. Connect to local `mqtts://<address>:1883` using MQTT 3.1.1, the downloaded client certificate/key and the bundled `lollipop.ca.crt` trust anchor. The APK's `lollipop.camera.crt` is not the required client identity. Private-CA chain verification remains enabled; the local-IP hostname-check exception follows the recovered app behavior.

All hash inputs below are literal UTF-8 strings; results are lowercase hexadecimal MD5:

| Use | Formula |
| --- | --- |
| RTSP password | `MD5(username + ":" + cameraId + ":6A09E667BB67AE853C6EF372")` |
| MQTT password | `MD5(cameraId + ":6A09E667BB67AE853C6EF372")` |
| RTSP path | `/live/<MD5(cameraId)>/ch00_0` on port 554 |

RTSP defaults to username `homebridge`; MQTT requires `lollipop`. The camera ID must be obtained before authenticated MQTT can connect.

Music requests use `<cameraId>/controlMusic`, method `controlMusic`, and `params.playStatus` of `play` or `pause`. The plugin queries `musicStatus` and waits for the requested state on `musicStatus/return`. Track selection stays in the mobile app.

Never post account tokens, camera IDs, private keys, or authenticated URLs. Sessions and MQTT identities stay in private Homebridge storage; debug output must remain redacted.
