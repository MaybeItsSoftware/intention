# Production readiness — 18 September 2026

## Verified

- The configured backend, `https://api.intention.maybeitssoftware.co.uk/health`,
  returned HTTP 200 with `{"ok":true}`. This verifies readiness at the time of
  the check, not receipt verification or a successful paid coaching request.
- GitHub repository secret names cover Chrome, Firefox, Android signing/Play
  publishing, and Apple App Store Connect/match. Values and store permissions
  have not been verified.
- The latest two CI runs (16 September) passed. Android publishing runs also
  passed on 16 September, but the workflow targets the internal testing track.
- The most recent Apple, Chrome and Firefox publishing workflows ran on
  3 September, for the latest GitHub release v0.23.1. Apple's iOS and macOS
  upload steps succeeded. The working tree is v0.24.2. Successful publishing
  status does not establish public availability.
- Local validation passed: lint, 1,689 unit tests, the full Chromium smoke
  suite, platform sync and Chrome/Firefox extension builds. Native binaries
  were not rebuilt during this review.
- All store screenshots and purchase review images were regenerated from the
  current working tree, including the site icon changes. Images unchanged in
  Git were still regenerated.

## Before public release

1. Cut and validate a release containing the latest UI changes. The local
   changes in this review have not been committed, uploaded or submitted.
2. Submit Chrome's draft for review; the workflow uses `publish: false`.
   Attach current Apple builds, listing assets and consumable IAPs to the
   version and submit in App Store Connect. Promote Android from internal
   testing to production when its testing/review requirements are satisfied.
   Confirm Firefox's latest version and review outcome in AMO.
3. Exercise a real store purchase on iOS, macOS and Android: product loading,
   verify, credited balance, paid chat deduction, insufficient balance,
   restart/reinstall recovery, refund notification and duplicate receipt.
   Backend health and unit tests do not establish that the store credentials,
   product metadata and refund notification subscriptions are configured.
4. Verify the backend mounts persistent storage with `INTENTION_STATE_FILE`,
   runs one process/replica, and has a tested backup and restore procedure.
   The synchronous file ledger is unsuitable for independent replicas.
   Production startup currently allows an unset state file, leaving balances
   and receipt idempotency in memory; enforcing durable production storage
   would remove that configuration failure mode.
5. Test native release builds on real devices: Safari enablement and App Group
   credit sharing; iOS Screen Time authorization, shields and foreground
   passes; Android Accessibility/Usage Access, reboot and permission revocation.
6. Confirm store listing/privacy/support URLs, data declarations, current
   prices, product availability, signing capabilities and reviewer instructions
   in each console. Their current console state was not inspected.

## Screenshot limits

The marketing generator loads the actual Chrome extension and seeds example
usage. It frames browser-rendered website UI for Apple and Android, and also
uses Chromium for Firefox images. These are current website-experience images,
not captures of native app blocking, store purchase sheets or Firefox itself.
The IAP generator renders the real paywall with products/prices from the local
StoreKit configuration; live store metadata can differ. Real device/store
captures are still needed to verify those experiences before submission.
