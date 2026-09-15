# Store assets

The listing copy for Apple, Chrome and Firefox is in `listings/`. Google Play
copy is in `Intention Android/fastlane/metadata/android/en-US/`.

Run `scripts/sync.sh`, then `node scripts/store-assets/generate.mjs` to
capture the shipped extension UI and render the Apple iPhone, iPad and Mac
screenshots, Android phone screenshots and feature graphic, and Chrome/Firefox
browser screenshots. Chrome's 128 px icon and promo tiles are in
`browser/chrome/`; Firefox's icon and direct screenshots are in
`browser/firefox/`. The original Apple screenshot commands call this same
generator.

Run `node scripts/appstore-screenshots/generate-iap.mjs` separately for the
three App Store purchase review screenshots. They use the real paywall,
StoreKit products and localized prices.

These assets show the website experience. Android's app time breakdown depends
on Usage Access. Apple's iPhone/iPad Screen Time report provides an aggregate
for selected apps, because iOS does not expose individual app identities here.
No generated image claims individual iOS app icons.
