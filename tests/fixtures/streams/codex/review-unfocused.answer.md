The changed loop bound introduces an out-of-bounds read that breaks numeric summation, including empty arrays. Both cases were verified with Node.js.

Review comment:

- [P1] Stop iteration before the array length — <scratch>/codex/review-repo/calc.js:3-3
  The inclusive bound reads `items[items.length]`, which is `undefined` for ordinary arrays, causing numeric sums to become `NaN`. For example, both `sum([1, 2, 3])` and `sum([])` now return `NaN` instead of `6` and `0`. Restore the strict `<` bound.