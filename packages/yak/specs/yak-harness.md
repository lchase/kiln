# yak-harness — spec

**Moved.** The yak-harness spec and its design trail now live in their
own repo:

- Spec — https://github.com/lchase/yak-harness/blob/main/docs/spec.md
- Design trail (map + decision tickets + prototype) —
  https://github.com/lchase/yak-harness/tree/main/docs/design

yak-harness is a standalone package that consumes yak only through the
documented CLI and the on-disk journal / `pending/` contract. Related
engine requests it would benefit from: #22, #23, #24.
