# PR #2 hardware feedback follow-up — October 13, 2026

## Evidence and scope

The tester, mitch7391, reports two cameras on firmware `2025111400-g389c1ce10`
working on a Raspberry Pi ARM64 with Homebridge 2.4.0 and Node 24.21.0 after
manually consolidating a split configuration. Account/OTP sign-in, automatic
discovery, video, listening audio, authenticated MQTT, credential caching, and
restart persistence worked. Music commands received playback-state confirmations.

Sources: [initial report](https://github.com/senorshaun/homebridge-lollipop/pull/2#issuecomment-6144409735)
and [blocker clarification](https://github.com/senorshaun/homebridge-lollipop/pull/2#issuecomment-6144665761).
These are tester observations of commit `1a48aef`, not physical validation of this
follow-up. The exact sequence of UI actions producing the duplicate was not
isolated by the tester.

## Configuration fix

The old setup helper only recognized a literal `platform: "Lollipop"`, appended
a new entry otherwise, and never reconciled multiple matching entries. A
plugin-scoped schema draft without its platform discriminator therefore produced
an orphan draft plus an account block. A fully qualified platform alias also
produced a second block. Already split entries remained split on every save.
These paths have been reproduced against the original helper.

Account and debug saves now use one reconciliation path. It reuses drafts,
recognizes `homebridge-lollipop.Lollipop`, and combines complementary Lollipop
entries into one canonical `platform: "Lollipop"` entry. It preserves the child
bridge, account, custom settings, and manual camera overrides. Explicit `false`
and `0` preferences remain authoritative in the first existing entry; later
entries supply missing settings. Only empty/schema-default camera rows are
removed. Partial connections and deliberately edited preferences are retained.

Interactive sign-in removes superseded headless passwords and tokens from all
merged Lollipop entries; changing debug alone preserves valid headless account
settings. Unrelated plugin/accessory entries remain unchanged. No disk write is
performed merely by opening the settings page.

Different accounts (except when explicitly replaced by sign-in), inconsistent
session credentials, or conflicting child-bridge settings stop the operation
before `updatePluginConfig`. A specific, credential-free message requests manual
consolidation after a backup. The repair never chooses a new bridge username,
port, or pairing identity to resolve a conflict silently.

## Music naming

Generated sound-switch labels become `<camera name> Music`, matching the app's
terminology while distinguishing multiple cameras. The existing accessory UUID,
service subtype, camera association, and MQTT topics are unchanged. Existing
explicitly customized switch names are retained. Label changes are persisted
through Homebridge's accessory update API, not unregister/re-register calls.

The internal configuration key `enableSoundMachine` and the existing sound
control protocol remain unchanged.

## Retest

Back up Homebridge before testing. Install the updated `fix/authenticated-rtsp`
branch. For an existing split configuration with complementary entries, toggle
**Enable debug logging** off/on in the custom setup page to save through the new
reconciliation path; sign-in is not required just to repair these entries.
Then verify there is one Lollipop platform containing both `account.email` and
the original `_bridge`, and restart Homebridge/the child bridge.

For a fresh setup, test child-bridge configuration followed by debug and account
sign-in/OTP, then reopen preferences, save again, and restart. Confirm both
cameras return without editing `config.json`. Check that Music On/Off still
works and that the renamed switches have not been duplicated or unpaired.

## Local validation and remaining work

`node --test tests/configurationPersistence.test.cjs tests/musicNaming.test.cjs`
passes **25 tests, zero failures, zero skips on Node 22.16.0**. The configuration
tests run the actual setup script in a browser/SDK fixture, including debug
before sign-in, OTP correction, concurrent native preference changes during OTP,
save retry without resending credentials, disk state, and reopening settings.
Naming tests run the actual sound runtime with HAP/MQTT fixtures and verify that
play/pause still waits for a matching camera status. Syntax checks pass for the
three changed production JavaScript files.

The earlier full 179-test/Homebridge runtime matrix was **not rerun** in this
environment: its installed dependencies are unavailable and npm registry DNS
resolution fails here. No fresh physical-camera test has been performed.

Snapshot delays (reported approximately 2.1–7.5 seconds), first-frame delays
(approximately 3.3–3.6 seconds), FFmpeg audio timestamp warnings, and ignored
stream reconfiguration are not fixed or claimed fixed by this patch. Media
commands and encoding settings were left unchanged. The next performance test
should compare repeated cold/warm snapshots and streams separately on each
camera with the same debug build and note simultaneous camera/app use.
