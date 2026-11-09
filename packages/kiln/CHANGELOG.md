# Changelog

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
