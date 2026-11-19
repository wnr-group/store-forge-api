/**
 * One corpus of Razorpay Key IDs with the expected verdict of the approved pattern `^rzp_(test|live)_[A-Za-z0-9]{8,}$`.
 * The unit spec checks the API pattern against it and the database spec checks the table's CHECK constraint against the
 * SAME list, so the two can never drift apart unnoticed (AC-DB-06).
 */
export const KEY_ID_CORPUS: readonly (readonly [string, boolean])[] = [
  ['rzp_test_abcdefgh', true],
  ['rzp_live_ABCDEFGH12', true],
  ['rzp_test_12345678', true],
  [`rzp_live_${'a1'.repeat(40)}`, true],
  ['rzp_test_abcdefg', false],
  ['rzp_demo_abcdefgh', false],
  ['RZP_test_abcdefgh', false],
  ['rzp_test_abcd efgh', false],
  ['rzp_test_abcdefgh\n', false],
  [' rzp_test_abcdefgh', false],
  ['rzp_test_abcdefg_', false],
  ['rzp_test_abcdéfgh', false],
  ['rzp_live_', false],
  ['', false],
];
