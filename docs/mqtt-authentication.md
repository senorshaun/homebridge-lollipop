# Recovered Lollipop MQTT authentication

## Finding and verification limits

The Android application uses an authenticated cloud request to obtain a client
certificate and private key for local MQTT. It also sends a separate MQTT
username and camera-specific password. The two public certificate files bundled
with the app are not a complete client identity.

This protocol was recovered by static analysis of Android package
`com.aoitek.lollipop`, versions **3.11.11 (June 2023)** and **4.5.2 (February
2025)**. The package signatures were verified and have signing-certificate
SHA-1 `80d11522e6ddf968301a2a8c4744e8fbcfbaf33d`. No vendor account, camera, or
credential endpoint was contacted during this investigation. Current API
responses and physical-camera acceptance remain unverified.

The plugin's authenticated RTSP mode does not yet perform this cloud provisioning
or open authenticated MQTT. This document records the missing protocol so that
implementation does not depend on guessing passwords or certificate roles.

## Complete sequence

1. Sign in to the owner's Lollipop account and obtain its Parse session token.
2. Obtain the original camera/pairing ID from the account's camera records.
3. Request that camera's MQTT certificate and private-key download links.
4. Download both files and verify their raw-byte MD5 checksums.
5. Use the downloaded certificate and key as the TLS client identity. Use the
   bundled `lollipop.ca.crt` as the trust anchor for the camera.
6. Connect to the camera's TLS MQTT broker on TCP port 1883 with the MQTT
   username/password below.
7. Verify the MQTT connection and subscription acknowledgement before relying on
   messages or issuing camera commands.

This changes the old discovery order. The old plugin subscribed to `#` and read
the pairing ID from the first topic. The authenticated app already knows the ID
before requesting credentials and opening MQTT. A fresh installation cannot use
the old anonymous subscription as its sole source of that ID.

## Cloud provisioning request

The 3.11.11 Android client sends:

```http
POST https://parse-api.lollipop.camera/parse/functions/getCameraMQTTKeyLink
Content-Type: application/json; charset=utf-8
X-Parse-Application-Id: WVxA1yrfGc8Jx9xNLyb0dX9005CI7cIThUFPSglD
X-Parse-Session-Token: <the owner's current Parse session token>
X-Requested-With: android
```

```json
{
  "cameraId": "<original camera pairing ID>",
  "version": "0"
}
```

The application ID is a fixed identifier included in the Android app. It is not
the owner's session token. `version` is the literal string `"0"` in this code
path. The request does not include an `X-Parse-REST-API-Key` header.

The response's `result` contains these fields:

```json
{
  "result": {
    "cert": "<certificate download URL>",
    "key": "<private-key download URL>",
    "certChecksum": "<MD5 of complete downloaded certificate bytes>",
    "keyChecksum": "<MD5 of complete downloaded private-key bytes>"
  }
}
```

The Android parser accepts either an object or a JSON-encoded string in
`result`; static analysis does not establish which representation the service
currently returns. The download URLs' hosts, lifetimes, and reuse rules also
require an actual authorized response.

The app downloads these URLs separately from the authenticated API client. It
does not explicitly forward the Parse session header to them. It computes
lowercase, zero-padded, 32-character MD5 digests over the original file bytes and
rejects either mismatch. PEM whitespace or line endings must not be normalized
before this check.

## MQTT password

```text
username = lollipop
constant = 6A09E667BB67AE853C6EF372
password = MD5_HEX_UTF8(cameraId + ":" + constant)
```

The constant is literal uppercase ASCII text. The colon is part of the input.
The output is lowercase hexadecimal, padded to 32 characters. The app builds
the constant from byte values rather than storing it as one contiguous string.

This differs from the recovered RTSP password:

| Protocol | Username | Password input before MD5 |
| --- | --- | --- |
| MQTT | `lollipop` | `cameraId + ":" + constant` |
| RTSP | Chosen stream username, e.g. `homebridge` | `username + ":" + cameraId + ":" + constant` |

For an independent synthetic example, `cameraId = synthetic-pairing-id` gives
MQTT password `25696c4c1b836b64532148fad72be804`. This is test data, not a real
camera credential.

The app constructs a Paho `MqttAsyncClient` with a generated client ID. No fixed
MQTT client ID was found in this connection path.

## TLS certificate roles

| Material | Role in the recovered MQTT client |
| --- | --- |
| Bundled `lollipop.ca.crt` | Loaded into a trust store and used by `TrustManagerFactory` to validate the camera's certificate chain. |
| Certificate downloaded from `result.cert` | Loaded as the TLS client certificate. |
| Private key downloaded from `result.key` | Parsed from PEM and paired with the downloaded certificate in a key store. |
| Bundled `lollipop.camera.crt` | Present in the APK, but not used by the recovered MQTT connection path. No literal reference to this filename was found in the examined DEX or native libraries. |

Both bundled certificate assets are byte-for-byte identical to the files
recovered from the author's old laptop. The old plugin put the bundled wildcard
certificate into Node's `cert` option, omitted the private key, and never loaded
the CA. That does not reproduce the app's authenticated connection.

The Android app uses `SSLContext.getInstance("TLSv1.2")`, supplying both
`KeyManagerFactory.getKeyManagers()` and
`TrustManagerFactory.getTrustManagers()`. The client key store uses an empty
password and contains an actual parsed private key; no private key is derived
from a public certificate.

The downloaded identity's subject, issuer, expiry, key type, whether it is unique
to one camera/account, and the server's exact hostname-verification requirements
cannot be established from the request and parsing code alone. Those details
must be checked with an authorized response and the target camera before
finalizing Node TLS options. The old wildcard certificate's expiration is not
by itself the diagnosis of the historical failure.

## Why the old failure could be silent

The recovered lockfile uses MQTT.js 4.2.8 and mqtt-packet 6.10.0. With
`rejectUnauthorized: false`, that version's TLS adapter does not forward many
TLS handshake errors to the MQTT client. Its generic stream-error forwarding
also omits `EPROTO` and `ERR_SSL_*` errors.

This was reproduced with actual MQTT.js 4.2.8, Node TLS sockets, and a local
synthetic MQTT broker:

| Controlled condition | Observed result |
| --- | --- |
| Server permits anonymous TLS clients; only recovered public certificate supplied | MQTT discovery succeeds, but the server receives no client certificate. |
| Server requires a client certificate; no matching private key supplied | TLS fails; the raw stream emits a handshake/certificate-required error, while the old MQTT client emits no error. |
| Server requires a client certificate; matching synthetic certificate and key supplied | TLS authentication and MQTT discovery succeed. |
| Server only supports TLS 1.1 | Protocol negotiation fails and the old MQTT client also suppresses that error. This illustrates why a silent failure alone cannot prove mTLS. |
| TLS succeeds but MQTT credentials are rejected | MQTT reports CONNECT rejection code 4. |
| Broker rejects the wildcard subscription | SUBACK returns QoS 128, which must be checked explicitly. |

TLS 1.3 can emit Node's `secureConnect` before the peer's later
`certificate_required` alert. That event alone is not proof of accepted client
authentication. Reconnects also replace the underlying TLS stream, so diagnostic
listeners need to follow each replacement.

The draft now observes both MQTT client errors and underlying TLS stream errors,
including replacement streams after reconnects. It reports the stage, error
code, and a fixed explanation without printing raw errors or credentials.
Discovery stops promptly on a TLS/MQTT failure, connection closure, or denied
SUBACK and clears its existing 15-second deadline. This diagnostic repair does
not implement the cloud provisioning flow described above.

These controlled tests establish client behavior and the diagnostic failure.
They do not establish that any simulated broker reproduces the actual camera's
full authorization policy.

## Evidence and source map

Downloaded APKs were inspected as data; their application code was not executed.
The 3.11.11 APK SHA-256 is
`b66bbb42c58000e661988210396b1150f6c818957655688aa4eac46c88c875ce`.
The 4.5.2 base APK SHA-256 is
`1494a15e46f15fc1271651c53ea6d489e643781057a94f811f2fc05f18e5202e`.

Relevant 3.11.11 classes, with original names recovered from Kotlin metadata:

| APK class | Original source name | Relevant behavior |
| --- | --- | --- |
| `com.aoitek.lollipop.communication.mqtt.a` | `MqttClient.kt` | Downloads, checksum validation, certificate/private-key loading, CA trust, MQTT username/password. |
| `com.aoitek.lollipop.repository.p` | `MqttRepository.kt` | Camera ID request and credential response fields. |
| `r1.i` | `ParsePrimaryService.kt` | Endpoint, API base URL, and session headers. |
| `com.aoitek.lollipop.utils.v` | `SecurityUtils.kt` | MD5 formatting and construction of the fixed string. |

External references:

- [APK version inventory](https://lollipop-smart-baby-monitor.apk.gold/).
- [MQTT.js 4.2.8 TLS adapter](https://github.com/mqttjs/MQTT.js/blob/v4.2.8/lib/connect/tls.js).
- [MQTT.js 4.2.8 client](https://github.com/mqttjs/MQTT.js/blob/v4.2.8/lib/client.js).
- [Original firmware issue and author's 2023 observations](https://github.com/senorshaun/homebridge-lollipop/issues/1).
- [Home Assistant discussion distinguishing 2021 firmware success from the 2023 authentication change](https://community.home-assistant.io/t/mosquitto-get-data-from-another-mqtt-broker-lollipop-camera/424547?page=2).

No real account session, downloaded client private key, certificate download URL,
or camera identifier is included in this document or the repository.
