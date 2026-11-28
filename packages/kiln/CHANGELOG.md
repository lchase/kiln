# Changelog

## [0.26.0](https://github.com/lchase/kiln/compare/kiln-v0.25.1...kiln-v0.26.0) (2026-11-28)


### Features

* collapsible sidebar that shrinks to an icon rail ([#121](https://github.com/lchase/kiln/issues/121)) ([d4aa920](https://github.com/lchase/kiln/commit/d4aa920d1efeabf1ae7ea8e56da2941b8f8f5491))
* phase chain on the job page, with parallel steps grouped ([#122](https://github.com/lchase/kiln/issues/122)) ([4f92e0c](https://github.com/lchase/kiln/commit/4f92e0c96d81f88300071574fb30b9a146d15e14))

## [0.25.1](https://github.com/lchase/kiln/compare/kiln-v0.25.0...kiln-v0.25.1) (2026-11-28)


### Bug Fixes

* do not block on a FIFO in the artifacts folder, and bound the read ([#119](https://github.com/lchase/kiln/issues/119)) ([ea12e1c](https://github.com/lchase/kiln/commit/ea12e1cf3880d35f12a84bf4a133914897a4a036))

## [0.25.0](https://github.com/lchase/kiln/compare/kiln-v0.24.0...kiln-v0.25.0) (2026-11-28)


### Features

* Artifacts column on the job page, grouped by round ([#118](https://github.com/lchase/kiln/issues/118)) ([b1cf49c](https://github.com/lchase/kiln/commit/b1cf49c4a2f8b733366e95a36e1eb7a259cb3689))
* clearer decision and failure pages ([#115](https://github.com/lchase/kiln/issues/115)) ([bb96ba5](https://github.com/lchase/kiln/commit/bb96ba59123ff9d67309e5cfd02a8687a110d355))
* keyboard navigation for the job lists and board ([#116](https://github.com/lchase/kiln/issues/116)) ([d0bc379](https://github.com/lchase/kiln/commit/d0bc379de1a64833d468aeaa326ce8d149bab6f1))
* Retry all and Remove finished cleanup buttons ([#117](https://github.com/lchase/kiln/issues/117)) ([ff28baa](https://github.com/lchase/kiln/commit/ff28baa290ea6355be7bc3df7d7bf86ab1435c6d))


### Bug Fixes

* stats cost by workflow, quieter finished rows, bundled fonts, accent contrast ([#113](https://github.com/lchase/kiln/issues/113)) ([ebc2096](https://github.com/lchase/kiln/commit/ebc2096f243403dd935425fda70e52721207c257))

## [0.24.0](https://github.com/lchase/kiln/compare/kiln-v0.23.0...kiln-v0.24.0) (2026-11-28)


### Features

* clearer board, job page, and text contrast from a UI review ([#111](https://github.com/lchase/kiln/issues/111)) ([5cc374c](https://github.com/lchase/kiln/commit/5cc374c7f3d888c5cf943c437128e980b97fca8b))

## [0.23.0](https://github.com/lchase/kiln/compare/kiln-v0.22.0...kiln-v0.23.0) (2026-11-27)


### Features

* limits and sandbox settings in plain language ([#109](https://github.com/lchase/kiln/issues/109)) ([91a8eb5](https://github.com/lchase/kiln/commit/91a8eb55706262c596654c39b5f50cc59ab60f6b))

## [0.22.0](https://github.com/lchase/kiln/compare/kiln-v0.21.1...kiln-v0.22.0) (2026-11-27)


### Features

* settings sections down the side, and a bar for unsaved changes ([#101](https://github.com/lchase/kiln/issues/101)) ([b25f5ac](https://github.com/lchase/kiln/commit/b25f5accb668e448d64d32972a306875b3076556))

## [0.21.1](https://github.com/lchase/kiln/compare/kiln-v0.21.0...kiln-v0.21.1) (2026-11-27)


### Bug Fixes

* stop agent steps from loading the operator's user Claude setup ([#98](https://github.com/lchase/kiln/issues/98)) ([a10c81f](https://github.com/lchase/kiln/commit/a10c81ff4f39fdedac173d9bd0e5b860b929e727))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @lchase/yak bumped from 0.10.1 to 0.10.2

## [0.21.0](https://github.com/lchase/kiln/compare/kiln-v0.20.1...kiln-v0.21.0) (2026-11-27)


### Features

* show a board action in progress and post it once ([#89](https://github.com/lchase/kiln/issues/89)) ([2558a75](https://github.com/lchase/kiln/commit/2558a754db78e26ed5548e56852954621db0830d))


### Bug Fixes

* keep the board responsive while jobs run ([#93](https://github.com/lchase/kiln/issues/93)) ([5e16d8a](https://github.com/lchase/kiln/commit/5e16d8ae5af6f7cc49e4f631f950bc36e6218fe3))

## [0.20.1](https://github.com/lchase/kiln/compare/kiln-v0.20.0...kiln-v0.20.1) (2026-11-26)


### Bug Fixes

* stop the board calling gh pr view on every request ([#86](https://github.com/lchase/kiln/issues/86)) ([db7a09f](https://github.com/lchase/kiln/commit/db7a09f851f6cd725d51067100bfef24ab0c9273))

## [0.20.0](https://github.com/lchase/kiln/compare/kiln-v0.19.1...kiln-v0.20.0) (2026-11-26)


### Features

* show workflow steps and running liveness on the board ([#71](https://github.com/lchase/kiln/issues/71)) ([096f015](https://github.com/lchase/kiln/commit/096f015b7338290ec015a4ac49baa16a26446db5))


### Bug Fixes

* require Node 22.12 or later ([#83](https://github.com/lchase/kiln/issues/83)) ([fe465a0](https://github.com/lchase/kiln/commit/fe465a08e75c9a55d0faf431aed9a26f75ccec9f))
* take the shell away from the pull request review agent ([#73](https://github.com/lchase/kiln/issues/73)) ([fe654db](https://github.com/lchase/kiln/commit/fe654dbb136392b43f06abbf20136abec851f5c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @lchase/yak bumped from 0.10.0 to 0.10.1

## [0.19.1](https://github.com/lchase/kiln/compare/kiln-v0.19.0...kiln-v0.19.1) (2026-11-16)


### Bug Fixes

* space repo status groups with the shared job list ([#68](https://github.com/lchase/kiln/issues/68)) ([7dc64c9](https://github.com/lchase/kiln/commit/7dc64c98f99ddb53a222ea3cf867643eb594f97c))
* surface a job blocked on a missing test command ([#69](https://github.com/lchase/kiln/issues/69)) ([d108a0e](https://github.com/lchase/kiln/commit/d108a0e6dacf05fa6c4f1d656b9a10296821ffc2))

## [0.19.0](https://github.com/lchase/kiln/compare/kiln-v0.18.0...kiln-v0.19.0) (2026-11-15)


### Features

* print kiln and yak versions at serve startup ([#63](https://github.com/lchase/kiln/issues/63)) ([9aaecab](https://github.com/lchase/kiln/commit/9aaecab7dee2f64a2253cf1875688a194af8b2c5))

## [0.18.0](https://github.com/lchase/kiln/compare/kiln-v0.17.0...kiln-v0.18.0) (2026-11-10)


### Features

* load local workflows, prompts, and skills from the kiln home ([#61](https://github.com/lchase/kiln/issues/61)) ([bed58e8](https://github.com/lchase/kiln/commit/bed58e8ca9f060c991470f80cedad6b930e2d937))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @lchase/yak bumped from 0.9.0 to 0.10.0

## [0.17.0](https://github.com/lchase/kiln/compare/kiln-v0.16.0...kiln-v0.17.0) (2026-11-09)


### Features

* add sidebar icons and a status footer ([#59](https://github.com/lchase/kiln/issues/59)) ([d9440ea](https://github.com/lchase/kiln/commit/d9440ea7dc76ca7d535fe8c553edd813f0e1f7e2))

## [0.16.0](https://github.com/lchase/kiln/compare/kiln-v0.15.0...kiln-v0.16.0) (2026-11-09)


### Features

* board style guide and Add job form ([#56](https://github.com/lchase/kiln/issues/56)) ([88be01e](https://github.com/lchase/kiln/commit/88be01ed0f4a6e564a7261fd12b52fe0e951f7fd))

## [0.15.0](https://github.com/lchase/kiln/compare/kiln-v0.14.0...kiln-v0.15.0) (2026-11-09)


### Features

* readable inbox, pipeline view, and job detail ([#54](https://github.com/lchase/kiln/issues/54)) ([268881a](https://github.com/lchase/kiln/commit/268881ae7a6389691cf58a06a3c77dfdc0d21a54))

## [0.14.0](https://github.com/lchase/kiln/compare/kiln-v0.13.0...kiln-v0.14.0) (2026-11-09)


### Features

* opt-in label and caps for review requests ([#52](https://github.com/lchase/kiln/issues/52)) ([d244bb7](https://github.com/lchase/kiln/commit/d244bb7ceb6a9f3b9465cc760f0dfca5a7e3d071))

## [0.13.0](https://github.com/lchase/kiln/compare/kiln-v0.12.0...kiln-v0.13.0) (2026-11-09)


### Features

* post approved review drafts to GitHub ([#50](https://github.com/lchase/kiln/issues/50)) ([134df9b](https://github.com/lchase/kiln/commit/134df9b27c33056a8bb4052fd187d292bc9d9910))

## [0.12.0](https://github.com/lchase/kiln/compare/kiln-v0.11.0...kiln-v0.12.0) (2026-11-03)


### Features

* add triggers, an event router, and hourly review drafts ([#48](https://github.com/lchase/kiln/issues/48)) ([ea4ec98](https://github.com/lchase/kiln/commit/ea4ec985f15d1412788c51fffbd87e619f1e45a3))

## [0.11.0](https://github.com/lchase/kiln/compare/kiln-v0.10.0...kiln-v0.11.0) (2026-11-03)


### Features

* replace the kanban with a sidebar board ([#46](https://github.com/lchase/kiln/issues/46)) ([bb8d6af](https://github.com/lchase/kiln/commit/bb8d6afe91d9a523576f426941a3567c4131e48a))

## [0.10.0](https://github.com/lchase/kiln/compare/kiln-v0.9.0...kiln-v0.10.0) (2026-11-03)


### Features

* add loop breakers, caps, cost, pause, and revise with note ([#43](https://github.com/lchase/kiln/issues/43)) ([d992512](https://github.com/lchase/kiln/commit/d9925129a722256d705029770f5399e477313f13))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @lchase/yak bumped from 0.8.0 to 0.9.0

## [0.9.0](https://github.com/lchase/kiln/compare/kiln-v0.8.0...kiln-v0.9.0) (2026-11-03)


### Features

* append-only event log, intervention ledger, and PR evidence ([#38](https://github.com/lchase/kiln/issues/38)) ([a8e51eb](https://github.com/lchase/kiln/commit/a8e51ebe2f563730b9e1a25931f730442398d4e1))

## [0.8.0](https://github.com/lchase/kiln/compare/kiln-v0.7.0...kiln-v0.8.0) (2026-11-03)


### Features

* add fan-out research / fan-in synthesis pattern ([261ddcb](https://github.com/lchase/kiln/commit/261ddcb71b27537353097d8a2aa2ae8f74a55a3a))

## [0.7.0](https://github.com/lchase/kiln/compare/kiln-v0.6.1...kiln-v0.7.0) (2026-11-02)


### Features

* add jobs from the serve board ([#30](https://github.com/lchase/kiln/issues/30)) ([1934a77](https://github.com/lchase/kiln/commit/1934a772137d3e3207bf07c218a0d6a42332c270))
* settings UI for kiln serve ([#32](https://github.com/lchase/kiln/issues/32)) ([21c5a4a](https://github.com/lchase/kiln/commit/21c5a4a8bfd8c3606f464891611831d32ce89bea))


### Bug Fixes

* stop auth retries and name pull requests ([#29](https://github.com/lchase/kiln/issues/29)) ([dab9e8b](https://github.com/lchase/kiln/commit/dab9e8b6cd7e21c7e020c99bcdea8d87734bbf09))

## [0.6.1](https://github.com/lchase/kiln/compare/kiln-v0.6.0...kiln-v0.6.1) (2026-10-27)


### Bug Fixes

* bump @lchase/yak to 0.8.0 so sandbox allowlists reach the proxy ([#27](https://github.com/lchase/kiln/issues/27)) ([14522b3](https://github.com/lchase/kiln/commit/14522b396b94fd2ade01e4ce935774c87f01f992))

## [0.6.0](https://github.com/lchase/kiln/compare/kiln-v0.5.0...kiln-v0.6.0) (2026-10-27)


### Features

* run opted-in agent steps in yak's Docker sandbox ([#25](https://github.com/lchase/kiln/issues/25)) ([2049c1a](https://github.com/lchase/kiln/commit/2049c1ab4d0828539364e154744e656f98989a31))

## [0.5.0](https://github.com/lchase/kiln/compare/kiln-v0.4.0...kiln-v0.5.0) (2026-10-27)


### Features

* feed pull request failures back into a bounded fix ([#23](https://github.com/lchase/kiln/issues/23)) ([d3f6f74](https://github.com/lchase/kiln/commit/d3f6f74e1f0bda3700fbd55e390df4eb0c6f65ca))

## [0.4.0](https://github.com/lchase/kiln/compare/kiln-v0.3.0...kiln-v0.4.0) (2026-10-27)


### Features

* factory-style operator board for kiln serve ([#19](https://github.com/lchase/kiln/issues/19)) ([bbb271e](https://github.com/lchase/kiln/commit/bbb271e0738d392dbc9e92d84026634796591de2))
* retry stalled, crashed, and orphaned kiln runs ([#20](https://github.com/lchase/kiln/issues/20)) ([c5d4f5b](https://github.com/lchase/kiln/commit/c5d4f5b6307ba60046b5120592ace374d102f1cb))

## [0.3.0](https://github.com/lchase/kiln/compare/kiln-v0.2.0...kiln-v0.3.0) (2026-10-25)


### Features

* add kiln serve local job UI ([#16](https://github.com/lchase/kiln/issues/16)) ([be282d2](https://github.com/lchase/kiln/commit/be282d25c86baaca5e63385753f165c8ea319f64))
* add the investigation workflow ([#17](https://github.com/lchase/kiln/issues/17)) ([50bf933](https://github.com/lchase/kiln/commit/50bf933950928a46deac7c093dc9199346a930cb))

## [0.2.0](https://github.com/lchase/kiln/compare/kiln-v0.1.1...kiln-v0.2.0) (2026-10-25)


### Features

* keep kiln state in one machine-level home ([#14](https://github.com/lchase/kiln/issues/14)) ([4929bfe](https://github.com/lchase/kiln/commit/4929bfe2f22dd59f8a3138ad073e4a3d53bea1fc))

## [0.1.1](https://github.com/lchase/kiln/compare/kiln-v0.1.0...kiln-v0.1.1) (2026-10-25)


### Bug Fixes

* bump @lchase/yak to 0.7.1 to clear zod audit advisory ([#12](https://github.com/lchase/kiln/issues/12)) ([0888e5a](https://github.com/lchase/kiln/commit/0888e5ab2ab897735f8f1fbf797f3eb37ab3e306))
