## [0.24.4](https://github.com/MaybeItsSoftware/intention/compare/v0.24.3...v0.24.4) (2026-09-20)

### Bug Fixes

* restore blocking screen icons and popup styling ([2c8bccc](https://github.com/MaybeItsSoftware/intention/commit/2c8bccc66ffaaff84b0c21565e3e8c775db73388))
* share website pass time across browser tabs ([e669af7](https://github.com/MaybeItsSoftware/intention/commit/e669af7f0ebb6e59c0f4987397529932475a5b62))

## [0.24.3](https://github.com/MaybeItsSoftware/intention/compare/v0.24.2...v0.24.3) (2026-09-18)

### Bug Fixes

* include site icons and prepare Android internal build 66 ([298fa44](https://github.com/MaybeItsSoftware/intention/commit/298fa44dc86e59c27f1cde2d86bbabfaf998a91e))

## [0.24.2](https://github.com/MaybeItsSoftware/intention/compare/v0.24.1...v0.24.2) (2026-09-16)

### Bug Fixes

* **settings:** remove redundant exit sections ([aa57008](https://github.com/MaybeItsSoftware/intention/commit/aa57008a53da025f582387ab095654b89ec86f28))

## [0.24.1](https://github.com/MaybeItsSoftware/intention/compare/v0.24.0...v0.24.1) (2026-09-16)

### Bug Fixes

* clarify settings controls and scheduled changes ([18ed956](https://github.com/MaybeItsSoftware/intention/commit/18ed956d0fe67887a1ef9f3b09900fb8c9169edc))

## [0.24.0](https://github.com/MaybeItsSoftware/intention/compare/v0.23.1...v0.24.0) (2026-09-15)

### Features

* **activity:** send Safari's website time to the iPhone and Mac apps ([3f1b91b](https://github.com/MaybeItsSoftware/intention/commit/3f1b91b37c31e63cba458a5434d46403eba67759))
* **billing:** browsers run on an API key only; no codes anywhere ([8b6cfe1](https://github.com/MaybeItsSoftware/intention/commit/8b6cfe1be3650b369d1458763846689f1fbf71b0))
* **billing:** drop recovery codes from the apps and Safari; fix versionName for CI ([f0c0fea](https://github.com/MaybeItsSoftware/intention/commit/f0c0feafcd7c962e3eb16c97335237b24d38ec33))
* **billing:** drop the Restore coaching credit box from the app builds ([1e50152](https://github.com/MaybeItsSoftware/intention/commit/1e5015290b28a1be3ddd32f601fba510d8147ced))
* **gate:** show the last seven days of usage on the gate ([edd7ccb](https://github.com/MaybeItsSoftware/intention/commit/edd7ccb50158ffc73e2947f7e5341b55641d272a))
* **mac:** the Mac app opens the real settings page instead of a status window ([bf070d8](https://github.com/MaybeItsSoftware/intention/commit/bf070d836246b981936c7d20acf81d02e28f8730))
* **options:** a Today dashboard, and a sidebar layout for wide windows ([4baff78](https://github.com/MaybeItsSoftware/intention/commit/4baff78dbf36e4bfadc3ca53b2e2728371ee6696))
* **parts:** always allow chosen accounts on a blocked site ([eb973e0](https://github.com/MaybeItsSoftware/intention/commit/eb973e09e0ad09dfc583ca8b7189f78d32f6c077))
* **server:** remove the access-code, redeem and recovery-code endpoints ([176a945](https://github.com/MaybeItsSoftware/intention/commit/176a945f55943486bff02564b25f8fa3078414f5))
* **sync:** add private cross-device settings sync ([ef899d3](https://github.com/MaybeItsSoftware/intention/commit/ef899d33e493fe3fe35aef4cd60f655a4500796b))
* add daily intentions, usage reports, Reddit exceptions, and foreground passes ([091ead6](https://github.com/MaybeItsSoftware/intention/commit/091ead6912aac9e31f67684650bcf8938e859bf8))
* replace blocking modes with daily intentions and a one-question setup ([dcbd054](https://github.com/MaybeItsSoftware/intention/commit/dcbd0544cc449ca3eef4efdcf8c6b5225650a853))

### Bug Fixes

* **setup:** fit every setup page to the screen and fill Android edge to edge ([e5e3382](https://github.com/MaybeItsSoftware/intention/commit/e5e33823326f1faf48d5941f926d057f2e6cd9fb))
* **sync:** stop the settings page throwing on load ([726006b](https://github.com/MaybeItsSoftware/intention/commit/726006b535426e2900f625d10300c14d767be163))

## [0.23.1](https://github.com/MaybeItsSoftware/intention/compare/v0.23.0...v0.23.1) (2026-09-03)

### Bug Fixes

* **apple:** ship the nine files the iOS app itself was built without ([1138ede](https://github.com/MaybeItsSoftware/intention/commit/1138ede818102f75aa470424438f0cd04c3e9815))

## [0.23.0](https://github.com/MaybeItsSoftware/intention/compare/v0.22.1...v0.23.0) (2026-09-03)

### Features

* **android:** recognise sections inside an app, and interpose on uninstall ([c001062](https://github.com/MaybeItsSoftware/intention/commit/c001062df8868f28ce1013ece0fc48472fc6c627))
* **android:** recognise sections inside an app, and interpose on uninstall ([12caf1f](https://github.com/MaybeItsSoftware/intention/commit/12caf1f530def75d53ec3d5f333b949e08aa024e))
* **android:** show the pass you were granted while it runs ([ae29119](https://github.com/MaybeItsSoftware/intention/commit/ae29119966dcb18abcbfc4406b7cd609f5774cbc))
* **apple:** recover a balance on a fresh install, and notice a disabled extension ([319b570](https://github.com/MaybeItsSoftware/intention/commit/319b57031555a1d355c03397f41b27fe40811ea6))
* **apple:** recover a balance on a fresh install, and notice a disabled extension ([75db0b3](https://github.com/MaybeItsSoftware/intention/commit/75db0b3e9896a4644c7ca54f6244b0d5a3d3eea0))
* **billing:** credit store promo codes so testers can be given credit ([3f86645](https://github.com/MaybeItsSoftware/intention/commit/3f86645e66349c1385d7a60d30b8f669b199bb5d))
* **billing:** offer a user's own key on Android, and calm the paywall down ([0486c06](https://github.com/MaybeItsSoftware/intention/commit/0486c06a9045f6057596df94cd2c4ffd9b66bfe6))
* **billing:** show the balance, and let a reinstall find its credit ([252f3fc](https://github.com/MaybeItsSoftware/intention/commit/252f3fc5140f75123c1189d0254e01ecfdd22b8f))
* **billing:** show the balance, and let a reinstall find its credit ([44aa3c3](https://github.com/MaybeItsSoftware/intention/commit/44aa3c386e86f7828d33b4e072b2110276c12f6e))
* **catalogue:** drop six sites from the suggestion list ([bbf1ea3](https://github.com/MaybeItsSoftware/intention/commit/bbf1ea350c5167d6ddf2ff7778acb01de6451278))
* **coach:** enforce the quick-check lane mechanically ([b390c5b](https://github.com/MaybeItsSoftware/intention/commit/b390c5b9597d400a39b85e1e174de0b92a6f0bdd))
* **coach:** go strict once the day's lenient window is spent ([8d02603](https://github.com/MaybeItsSoftware/intention/commit/8d0260316b296e49bffdd12106b54ae715e1c7b5))
* **coach:** report a coach message by pressing and holding it ([0974231](https://github.com/MaybeItsSoftware/intention/commit/0974231b16e6bbc74f3e57861cf21fa69d4fec56))
* **design:** retheme onto the house palette, light and dark ([761a24b](https://github.com/MaybeItsSoftware/intention/commit/761a24baf6937e406824f131a3b9498ff32a3956)), closes [#3b82f6](https://github.com/MaybeItsSoftware/intention/issues/3b82f6) [#0f1115](https://github.com/MaybeItsSoftware/intention/issues/0f1115) [#intention-root](https://github.com/MaybeItsSoftware/intention/issues/intention-root) [#intention-root](https://github.com/MaybeItsSoftware/intention/issues/intention-root) [#007fff](https://github.com/MaybeItsSoftware/intention/issues/007fff) [#007fff](https://github.com/MaybeItsSoftware/intention/issues/007fff)
* **gate:** route quick-check loosening through the coach ([d36abf2](https://github.com/MaybeItsSoftware/intention/commit/d36abf21c36fa4075507527172f49e41bb928d87))
* **gate:** scope a pass to one page, block parts of a site, and gate leaving ([197070d](https://github.com/MaybeItsSoftware/intention/commit/197070dfc0c088696163b7c2b16b08d31b2b5f47))
* **gate:** scope a pass to one page, block parts of a site, and gate leaving ([985979f](https://github.com/MaybeItsSoftware/intention/commit/985979f9fa36719d2ccb02278d521822854f1d85))
* **ios:** show a live timer for the length of a granted pass ([ae74311](https://github.com/MaybeItsSoftware/intention/commit/ae74311877dfe2ed6d317eeabc9f09836985cdf8))
* **onboarding:** ask what each site is for, and tell the coach ([205e6c8](https://github.com/MaybeItsSoftware/intention/commit/205e6c818c53087bfcc6b947d4cbb48d0c61f861))
* **onboarding:** rebuild the setup wizard and open up AI access ([aee2bf9](https://github.com/MaybeItsSoftware/intention/commit/aee2bf9681db6eddcf4d45abaea2f52eb5d0cb96))
* **onboarding:** say how long the per-service run is ([0ae0e9e](https://github.com/MaybeItsSoftware/intention/commit/0ae0e9ebda59042698bf088d46c0aada7b306d6c))
* **options:** per-site quick-check control and onboarding mention ([7c6a040](https://github.com/MaybeItsSoftware/intention/commit/7c6a04054f0dc5112d920c71589400af1111d4ca))
* **parts:** add the one place a URL is turned into a section or a page ([3a01f32](https://github.com/MaybeItsSoftware/intention/commit/3a01f32fb8429f5983062a183fa01f33ff953201))
* **parts:** add the one place a URL is turned into a section or a page ([f928cec](https://github.com/MaybeItsSoftware/intention/commit/f928cec406b564dff088fe511d1e8c480a1f3cef))
* **prompts:** teach the coach the quick-check lane ([b56be2a](https://github.com/MaybeItsSoftware/intention/commit/b56be2a68a5bd61aa7ea3cf96548647aa3b87a7c))
* **providers:** modernise the Groq model list around gpt-oss ([255b0eb](https://github.com/MaybeItsSoftware/intention/commit/255b0ebdc50b9726417f24fab3566a883668176c))
* **server:** give a surviving account id a way back to its balance ([8d789e9](https://github.com/MaybeItsSoftware/intention/commit/8d789e9c927c2f5e1fd2f7ceb7141740fc796003))
* **server:** give a surviving account id a way back to its balance ([fc196e1](https://github.com/MaybeItsSoftware/intention/commit/fc196e15bf6f637d72337df12c4726198474bcef))
* **settings:** controls for section rules, the credit chip and leaving ([82d7cd6](https://github.com/MaybeItsSoftware/intention/commit/82d7cd6615efce09e644b781f904dfaf23cb03a3))
* **settings:** controls for section rules, the credit chip and leaving ([09bab74](https://github.com/MaybeItsSoftware/intention/commit/09bab747be5d6eacd83aa2b1b4b7cc47fb3bbd80))
* **settings:** lay each blocked site and app out as a row you can read ([8d9f1ce](https://github.com/MaybeItsSoftware/intention/commit/8d9f1ce707619c4d32b50668a42e0a7d2035a000))
* **settings:** link the privacy policy, and stop links trapping the app ([42377ae](https://github.com/MaybeItsSoftware/intention/commit/42377ae229259d07b655b8a7956b73bc026ac108))
* **settings:** rebuild the blocked row around one decision ([2a7bd5f](https://github.com/MaybeItsSoftware/intention/commit/2a7bd5fa2f447f7c4c2dfa9e7a6e086ca7c23123))
* **settings:** retire the quick check, move suggestions into the add dialog ([b7f79f0](https://github.com/MaybeItsSoftware/intention/commit/b7f79f0ee0a11240827760ec942ee03089f2a0a5))
* **setup:** ask about every service on one screen, in taps ([b750aea](https://github.com/MaybeItsSoftware/intention/commit/b750aea0211594f33637aa466b0e0d68074486ae))
* **setup:** ask about every service on one screen, in taps ([498e445](https://github.com/MaybeItsSoftware/intention/commit/498e4456878df14cc3562848a02bbc771d535f0b))
* **setup:** drop the two general questions, and put the slider in the wizard ([98385c9](https://github.com/MaybeItsSoftware/intention/commit/98385c9987a2412d4f3603b603ec2ee22440bc56))
* **tracking:** count quick checks in their own lane ([a9f2afb](https://github.com/MaybeItsSoftware/intention/commit/a9f2afb0a9fef087cef33ca126524b9ba397bbd1))

### Bug Fixes

* **android:** give the launcher icon an adaptive definition ([f353601](https://github.com/MaybeItsSoftware/intention/commit/f353601fd74b1f065d60fc26812fa60a0bcaa5f0))
* **android:** stop a blocked video playing on in picture-in-picture over the coach ([03bcc5d](https://github.com/MaybeItsSoftware/intention/commit/03bcc5d38481f7740ddc72a051a05c49027e21c2))
* **apple:** keep background scripts ASCII so Safari stops mangling them ([e760bf9](https://github.com/MaybeItsSoftware/intention/commit/e760bf91395b9b4bf8331021d8c160a14a620a06))
* **apple:** ship the eight source files the extension was built without ([4dde53c](https://github.com/MaybeItsSoftware/intention/commit/4dde53c109d8b3e94e21c36ae07862a1aeec8439))
* **apple:** ship the eight source files the extension was built without ([3317e00](https://github.com/MaybeItsSoftware/intention/commit/3317e00ab006d7f85179834a3ae2c9a6dead6581))
* **billing:** connect Play Billing from the gate, and let a Mac redeem a code ([a7d360f](https://github.com/MaybeItsSoftware/intention/commit/a7d360f2b543f61c6eb2cdcd1e73b3af5a3f7cdd))
* **billing:** credit sandbox purchases up to a cap instead of refusing them ([8c8e2ce](https://github.com/MaybeItsSoftware/intention/commit/8c8e2ce82071657accc85b0654e84ee0d25690f1))
* **billing:** drop the custom API key route from Apple builds ([f8cad2d](https://github.com/MaybeItsSoftware/intention/commit/f8cad2d23bc88601478dacd2805a4f37c95c8f19))
* **billing:** point the native clients at the real backend, and stop the redeem button lying ([4e0982a](https://github.com/MaybeItsSoftware/intention/commit/4e0982a4407aab1ce9b816052eb485ec501033ce))
* **build:** keep one Intention.app so Safari lists one extension ([cf98385](https://github.com/MaybeItsSoftware/intention/commit/cf9838579b50b61a5b3bc8a007c12f65ed555027))
* **build:** point dev:safari at the app build.sh actually produces ([aa9b864](https://github.com/MaybeItsSoftware/intention/commit/aa9b864c5542267c8022beba616150f9878131ff))
* **gate:** stop the only gate Safari has from failing open in silence ([12004e9](https://github.com/MaybeItsSoftware/intention/commit/12004e9b81f8db602237743bc41444e7ebaaebb6))
* **parts:** reject a DNR pattern character whether or not the engine encoded it ([59aa8de](https://github.com/MaybeItsSoftware/intention/commit/59aa8de5a466e5803a80eed723df35a3246ac721))
* **prompts:** tell the coach the real time, to the minute ([645d113](https://github.com/MaybeItsSoftware/intention/commit/645d113987149b792859223c21692a49e6c1356c))
* **release:** pin the changelog preset the notes generator can actually read ([3848bb0](https://github.com/MaybeItsSoftware/intention/commit/3848bb04dbdc016054ede2510711100a41ba73c1))
* **safari:** ship the files the extension actually asks for ([059a770](https://github.com/MaybeItsSoftware/intention/commit/059a770c19432de848c18813291837b6e8693ac5))
* **server:** stop /health writing on demand, and sweep the rate limiter ([cc46653](https://github.com/MaybeItsSoftware/intention/commit/cc46653302f65c5f3b88e70cc9780f6e0a042d30))
* **setup:** say the code instruction once, and prefill the key that is already on disk ([6bc199b](https://github.com/MaybeItsSoftware/intention/commit/6bc199b2a9a28ae81b2457fbb8457b2b277fe52b))

## [0.22.1](https://github.com/MaybeItsSoftware/intention/compare/v0.22.0...v0.22.1) (2026-08-16)

## [0.22.0](https://github.com/MaybeItsSoftware/intention/compare/v0.21.0...v0.22.0) (2026-08-15)

## [0.21.0](https://github.com/MaybeItsSoftware/intention/compare/v0.20.0...v0.21.0) (2026-08-06)

## [0.20.0](https://github.com/MaybeItsSoftware/intention/compare/v0.19.1...v0.20.0) (2026-08-06)

## [0.19.1](https://github.com/MaybeItsSoftware/intention/compare/v0.19.0...v0.19.1) (2026-08-05)

## [0.19.0](https://github.com/MaybeItsSoftware/intention/compare/v0.18.2...v0.19.0) (2026-08-04)

## [0.18.2](https://github.com/MaybeItsSoftware/intention/compare/v0.18.1...v0.18.2) (2026-08-03)

## [0.18.1](https://github.com/MaybeItsSoftware/intention/compare/v0.18.0...v0.18.1) (2026-08-03)

## [0.18.0](https://github.com/MaybeItsSoftware/intention/compare/v0.17.0...v0.18.0) (2026-08-03)

## [0.17.0](https://github.com/MaybeItsSoftware/intention/compare/v0.16.1...v0.17.0) (2026-08-03)

## [0.16.1](https://github.com/MaybeItsSoftware/intention/compare/v0.16.0...v0.16.1) (2026-08-01)

## [0.16.0](https://github.com/MaybeItsSoftware/intention/compare/v0.15.4...v0.16.0) (2026-07-30)

## [0.15.4](https://github.com/MaybeItsSoftware/intention/compare/v0.15.3...v0.15.4) (2026-07-30)

## [0.15.3](https://github.com/MaybeItsSoftware/intention/compare/v0.15.2...v0.15.3) (2026-07-29)

## [0.15.2](https://github.com/MaybeItsSoftware/intention/compare/v0.15.1...v0.15.2) (2026-07-28)

## [0.15.1](https://github.com/MaybeItsSoftware/intention/compare/v0.15.0...v0.15.1) (2026-07-22)

## [0.15.0](https://github.com/MaybeItsSoftware/intention/compare/v0.14.0...v0.15.0) (2026-07-21)

## [0.14.0](https://github.com/MaybeItsSoftware/intention/compare/v0.13.4...v0.14.0) (2026-07-21)

## [0.13.4](https://github.com/MaybeItsSoftware/intention/compare/v0.13.3...v0.13.4) (2026-07-21)

## [0.13.3](https://github.com/MaybeItsSoftware/intention/compare/v0.13.2...v0.13.3) (2026-07-21)

## [0.13.2](https://github.com/MaybeItsSoftware/intention/compare/v0.13.1...v0.13.2) (2026-07-21)

## [0.13.1](https://github.com/MaybeItsSoftware/intention/compare/v0.13.0...v0.13.1) (2026-07-21)

## [0.13.0](https://github.com/MaybeItsSoftware/intention/compare/v0.12.1...v0.13.0) (2026-07-21)

## [0.12.1](https://github.com/MaybeItsSoftware/intention/compare/v0.12.0...v0.12.1) (2026-07-20)

## [0.12.0](https://github.com/MaybeItsSoftware/intention/compare/v0.11.0...v0.12.0) (2026-07-19)

## [0.11.0](https://github.com/MaybeItsSoftware/intention/compare/v0.10.1...v0.11.0) (2026-07-19)

## [0.10.1](https://github.com/MaybeItsSoftware/intention/compare/v0.10.0...v0.10.1) (2026-07-19)

## [0.10.0](https://github.com/MaybeItsSoftware/intention/compare/v0.9.0...v0.10.0) (2026-07-19)

## [0.9.0](https://github.com/MaybeItsSoftware/intention/compare/v0.8.1...v0.9.0) (2026-07-19)
