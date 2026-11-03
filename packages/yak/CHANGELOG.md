# Changelog

## [0.8.0](https://github.com/lchase/yak/compare/yak-v0.7.1...yak-v0.8.0) (2026-10-27)


### Features

* pass agent allowedDomains into the sandbox proxy ([#53](https://github.com/lchase/yak/issues/53)) ([5fe2c6a](https://github.com/lchase/yak/commit/5fe2c6a9b60ad26ffc396b19a65199f7939a6fb9))

## [0.7.1](https://github.com/lchase/yak/compare/yak-v0.7.0...yak-v0.7.1) (2026-10-25)


### Bug Fixes

* **deps:** clear npm audit via vitest 5 and zod 4 ([#51](https://github.com/lchase/yak/issues/51)) ([decc40c](https://github.com/lchase/yak/commit/decc40c5123ff6e912986f2f3080cc963198a25a))

## [0.7.0](https://github.com/lchase/yak/compare/yak-v0.6.1...yak-v0.7.0) (2026-10-25)


### Features

* fork worktree isolation from a given commit with --from ([#49](https://github.com/lchase/yak/issues/49)) ([5e74b4b](https://github.com/lchase/yak/commit/5e74b4b1039e1d1c4fd33acd710873019651ed73))

## [0.6.1](https://github.com/lchase/yak/compare/yak-v0.6.0...yak-v0.6.1) (2026-10-25)


### Bug Fixes

* ignore null and undefined when collecting prompt roots ([#47](https://github.com/lchase/yak/issues/47)) ([73c1806](https://github.com/lchase/yak/commit/73c18063f9119d04daf3f3911e41be37dc5a844f))

## [0.6.0](https://github.com/lchase/yak/compare/yak-v0.5.0...yak-v0.6.0) (2026-10-25)


### Features

* run independent loop body steps in parallel ([#45](https://github.com/lchase/yak/issues/45)) ([4c3ec6b](https://github.com/lchase/yak/commit/4c3ec6b379b1098cbd08e4ffea0365881fe3d510))

## [Unreleased]

### Features

* `yak run --isolation worktree --from <ref>` forks the run worktree from a resolved commit (`ExecuteOptions.from`). The commit is stored on `run.started` as `worktreeBase`; resume reuses it and does not re-resolve the ref. Omitting `--from` still forks from `HEAD`
* a loop body can run independent steps in parallel via optional `concurrency` (effective cap 1 keeps declared order)

### Bug Fixes

* prompt placeholders do not treat jexl `null` and `undefined` as artifact roots (`{{ verify.exitCode == null }}`, `{{ x || undefined }}`); a misspelled identifier is still rejected
* a loop body whose effective concurrency is 1 runs in declared order, so a later step does not jump an earlier sibling that is still waiting
* prompt placeholders validate every identifier outside string literals (`{{ !x }}`, `{{ x || secrity }}`, `{{ fn(x) }}`); names after `.` and jexl `|` transforms are not roots

## [0.5.0](https://github.com/lchase/yak/compare/yak-v0.4.1...yak-v0.5.0) (2026-09-08)


### Features

* a loop step's `produces` writes its own artifact ([#35](https://github.com/lchase/yak/issues/35)) ([#44](https://github.com/lchase/yak/issues/44)) ([cfaa280](https://github.com/lchase/yak/commit/cfaa2804cd646064c12f5e44078abea80c407677))
* yak cancel &lt;run-id&gt; — supported engine-side termination of a live run ([#24](https://github.com/lchase/yak/issues/24)) ([#42](https://github.com/lchase/yak/issues/42)) ([9ea9ac7](https://github.com/lchase/yak/commit/9ea9ac72fb40a9ac94399328635ba536428083ca))

## [0.4.1](https://github.com/lchase/yak/compare/yak-v0.4.0...yak-v0.4.1) (2026-09-08)


### Bug Fixes

* reject expressions that misread a non-identifier artifact name ([#36](https://github.com/lchase/yak/issues/36)) ([#40](https://github.com/lchase/yak/issues/40)) ([9d2ae60](https://github.com/lchase/yak/commit/9d2ae606cc353b7c3c02b5e428d9aa4212db0733))

## [0.4.0](https://github.com/lchase/yak/compare/yak-v0.3.1...yak-v0.4.0) (2026-09-08)


### Features

* yak run --tag &lt;string&gt; — caller-supplied correlation tag ([#37](https://github.com/lchase/yak/issues/37)) ([d302acb](https://github.com/lchase/yak/commit/d302acbbbbbe3dba70f2764bfd917ce71e8bcaeb)), closes [#22](https://github.com/lchase/yak/issues/22)
* yak run prints the run id to stderr at launch ([#39](https://github.com/lchase/yak/issues/39)) ([8dfde90](https://github.com/lchase/yak/commit/8dfde9037d02341859cbd503f50750cef919dc0d)), closes [#23](https://github.com/lchase/yak/issues/23)

## [0.3.1](https://github.com/lchase/yak/compare/yak-v0.3.0...yak-v0.3.1) (2026-09-07)


### Bug Fixes

* yak --version reports the real version, not a hardcoded 0.0.1 ([#32](https://github.com/lchase/yak/issues/32)) ([0807dc7](https://github.com/lchase/yak/commit/0807dc7ad24b435b667bc7a541c541e462183f22))

## [0.3.0](https://github.com/lchase/yak/compare/yak-v0.2.1...yak-v0.3.0) (2026-09-07)


### Features

* yak run --input — pass workflow input at launch ([#28](https://github.com/lchase/yak/issues/28)) ([1836fe0](https://github.com/lchase/yak/commit/1836fe04b06fef8c95a73a9c514de8c678e2c630))

## [0.2.1](https://github.com/lchase/yak/compare/yak-v0.2.0...yak-v0.2.1) (2026-08-27)


### Bug Fixes

* stop cropping the tagline off the mascot header image ([#20](https://github.com/lchase/yak/issues/20)) ([b95e52f](https://github.com/lchase/yak/commit/b95e52fcaddecca6000528c4b26ec4944d1ec3bf))

## [0.2.0](https://github.com/lchase/yak/compare/yak-v0.1.2...yak-v0.2.0) (2026-08-27)


### Features

* add fan-out research / fan-in synthesis pattern ([b462473](https://github.com/lchase/yak/commit/b462473b2c92c534f0280a46ee19117b171aedae))


### Bug Fixes

* mascot header image cropped through the y's descender ([#19](https://github.com/lchase/yak/issues/19)) ([c78a59a](https://github.com/lchase/yak/commit/c78a59a0af1338542fa6539d6090a3e7a58b0813))

## [0.1.2](https://github.com/lchase/yak/compare/yak-v0.1.1...yak-v0.1.2) (2026-08-26)


### Bug Fixes

* add missing name/version to docs-site workflow examples ([#14](https://github.com/lchase/yak/issues/14)) ([691de3c](https://github.com/lchase/yak/commit/691de3c1c04feb3e0f6c3a8844eb4eaa3c87dca9))
