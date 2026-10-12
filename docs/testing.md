# Hardware testing and debug logs

This guide is for testing the account setup and authenticated MQTT work in [draft PR #2](https://github.com/senorshaun/homebridge-lollipop/pull/2), on the `fix/authenticated-rtsp` branch. It has automated coverage using synthetic account responses, temporary certificates, and a local MQTT broker. A physical Lollipop camera, the current Lollipop account service, and HomeKit still need to be exercised together.

## Before starting

Use the draft branch in the Homebridge instance being tested. The published npm package does not include these changes. Record the branch's commit when reporting results: the package version alone is not enough to identify a draft build.

Have the camera working in the Lollipop app and connected to a network reachable from Homebridge. Account discovery supplies the camera ID and local address automatically, but video and MQTT still connect directly over the local network. Use the account that owns the camera.

In the Lollipop app, select a sound or track for the sound-machine switch to resume. The HomeKit switch supports resume/repeat and pause; it does not choose a track or set the volume. HKSV is not part of this test and remains disabled in account mode.

## Enable logging before setup

1. Open the Lollipop plugin settings in Homebridge Config UI X.
2. Turn on **Enable debug logging**, above the account sign-in form. Wait for the saved-setting message.
3. Sign in and enter the email verification code if requested. Debug logging applies to these setup requests immediately. It can also be changed between verification-code attempts.
4. Restart the Lollipop child bridge, or Homebridge if the plugin runs in the main bridge. This applies the saved setting to camera discovery, MQTT, sound controls, and FFmpeg.
5. Keep the logs from startup through the test action and its result. Note the approximate action time and time zone.

The equivalent manual setting is a boolean on the platform object:

```json
{
  "platform": "Lollipop",
  "debug": true,
  "account": {
    "email": "you@example.com"
  }
}
```

Add the setting to the existing configuration; retain existing camera preferences. The checkbox changes only `debug` and preserves the other settings.

**Where to find the output:** camera/runtime diagnostics use the normal Homebridge log. Sign-in and email-code diagnostics are written by the Homebridge UI plugin backend, so collect the Homebridge UI service or container log as well when setup fails. Log locations depend on how Homebridge is installed. Browser developer-console output is not needed. The plugin does not write a separate diagnostic file.

After testing, turn the checkbox off and restart the child bridge. Homebridge's global `-D` or `--debug` startup option also enables runtime diagnostics; remove that option if runtime logging remains enabled.

## Test sequence

Record each result, including successful steps before a failure.

| Test | Action | Expected result |
| --- | --- | --- |
| Sign-in | Sign in through the plugin settings; complete the email-code step if requested. | The screen reports a connected account and discovered camera names. |
| Startup/discovery | Restart the child bridge with debug enabled. | The camera is selected, has a local address, and obtains or reuses a valid MQTT identity. |
| MQTT readiness | Let startup finish before operating the switch. | TLS succeeds, MQTT accepts the connection, and all five camera subscriptions are accepted. |
| Snapshot | Open the Home app's camera view. | A fresh thumbnail is returned. Logs distinguish fetching from resizing and reuse of a recent snapshot. |
| Live video/audio | Open the live camera view, listen briefly, then close it. | FFmpeg receives a video frame, the HomeKit view plays, and the stream shuts down when closed. |
| Sound On | With a sound selected in the Lollipop app, turn the HomeKit sound switch on. | The camera plays the selected sound and reports the playing state. |
| Sound Off | Turn the switch off after On has completed. | The camera pauses and reports pause or stop. |
| Reconnect | When convenient, briefly restart the camera or interrupt its network connection, then restore it. | Homebridge reconnects, subscribes again, and requests sound status. A command issued while disconnected reports an error and is not replayed later. |
| Bridge restart | Restart Homebridge once more. | The saved session and valid identity are reused, and existing HomeKit accessories are retained. |
| Optional sensors | Trigger an enabled movement/noise/crying/crossing event through normal camera use. | The corresponding sensor activates and later resets. The configured event must be supported/enabled by the camera. |

If a step fails, capture its log context before changing settings. There is no need to keep retrying a rejected login or repeatedly toggling a disconnected switch. A sound command has an eight-second confirmation deadline; a stream start has a twenty-second first-frame deadline.

## Reading the trace

Structured lines begin with `[diagnostic #N]` and an event name. Homebridge supplies the surrounding timestamp. Sequence numbers are local to the process and restart from the beginning after a process restart; setup and camera runtime may therefore have different sequences. `camera-1` and `stream-1` are temporary correlation aliases, not hashes or portions of real IDs. Display names may also appear as the usual Homebridge camera prefix.

| Event family | What it establishes |
| --- | --- |
| `platform.start` | Diagnostic format, plugin/Node/Homebridge/MQTT versions when available, operating system/architecture, and account/manual mode. |
| `setup.request.*` | Whether a sign-in, verification, status, or cancellation request began, completed, or failed in the setup backend. |
| `account.http.*` | The operation (`login`, `otp`, `session`, `cameras`, `mqtt_key`, or credential download), duration, HTTP status, and safe transport errors. |
| `account.response.*` | Expected response types and presence of relevant fields. An unexpected server shape is visible without printing a response body. |
| `account.session`, `account.authenticate`, `account.sign_in`, `account.otp` | Whether a session was validated or a new sign-in/code is required. |
| `account.cameras*`, `account.camera`, `platform.camera` | Pagination, camera counts, whether a local address was present, selection, and changes to an existing connection. |
| `account.cache.*` | Disk/memory reads and writes, cache age and eligibility, outage fallback, and invalidation scope. |
| `account.credential.download`, `account.identity*` | Credential download status/size/redirects, checksum results, certificate/key parsing and matching, and certificate validity. |
| `mqtt.tls` | A TLS attempt and, on success, negotiated protocol/cipher and certificate authorization. |
| `mqtt.connection` | MQTT connection acceptance, failure stage, offline/close/reconnect, and shutdown. |
| `mqtt.subscription` | Requested, accepted, and denied topic counts; retry delay after rejection. |
| `mqtt.message` | Known message category, byte count, expected outer structure, malformed/ignored reason, and sampled message count. |
| `sound.command`, `sound.status` | The switch request, local publish completion, camera acknowledgment, reported playback state, final confirmation or failure. |
| `camera.sensor` | Sensor state transitions and resets. |
| `media.stream`, `media.snapshot` | Stream/snapshot stages, requested dimensions, first frame, elapsed time, output size, process exit/signal, and failure reason. |

A successful TLS handshake is only the first MQTT checkpoint. The TLS `authorized` field describes Homebridge's verification of the camera certificate. `phase=secure` does not establish that the camera accepted the client certificate; TLS 1.3 can report a certificate rejection afterward. Look next for `mqtt.connection` with `phase=connected`, then `mqtt.subscription` with `phase=complete`. TLS can also succeed while the camera rejects the MQTT username/password or refuses subscriptions.

For sound, `published` means MQTT.js completed its local write callback. `acknowledged` means the camera replied successfully to `controlMusic`. The switch change completes only when `confirmed` follows a matching camera playback status. If it stops at acknowledgment, the trace should show whether `musicStatus` arrived and whether its state matched the request. An unrecognized playback value produces `sound.status` with `reason=invalid_schema` and its type, without copying the value. A timeout, rejection, or disconnect ends the command with a distinct reason.

`mqtt.message` reports the first occurrence of a category and then at most one summary per category per minute; `count` is cumulative since connection setup. Repeated identical motion messages do not produce a new sensor-state line. These limits keep a busy camera from burying useful failures.

If a record includes `redactionLimited=true`, the bounded credential-redaction registry has filled. Structured diagnostics remain available, while free-form messages are omitted to protect credentials. Restarting the process resets that registry; include the marked records in a report if the limit is reached again.

FFmpeg stderr is available with debug enabled and goes through the shared redactor. Seeing `first_frame` establishes that FFmpeg received a frame; the tester still needs to confirm that the HomeKit view renders and that audio plays.

## What to include in a report

Copy this template and fill in only the relevant parts:

```text
Branch/commit tested:
Homebridge / Node versions:
Host OS or container setup:
Camera model and firmware (from the Lollipop app):
Account mode or manual mode:
Time and time zone of the attempt:

Steps taken:
Expected result:
Actual result / Home app error:

Sign-in and discovery:
MQTT subscriptions:
Snapshot:
Live video / audio:
Sound On / Off:
Reconnect / bridge restart:
Optional event sensors:

Relevant log excerpt from startup through the failure:
```

Include the complete short sequence around the failed attempt, including preceding successes. For a setup failure, include the Homebridge UI backend logs; for video/switch failures, include the runtime startup and action logs. If firmware metadata is not reported over MQTT, the firmware version from the Lollipop app is still useful.

Structured diagnostics exclude raw server bodies and MQTT payloads. The shared logger redacts passwords, verification codes, session tokens, camera IDs, credential URLs, PEM material, and HomeKit stream keys. Do not attach account cache files, a full configuration export, certificates/private keys, packet captures, or authenticated stream URLs. Review camera display names and logs from other plugins before posting a public excerpt.

These traces are intended to locate failures and make follow-up testing specific. They cannot establish compatibility with every firmware or replace an observation from a real camera.
