/**
 * Bracket re-exports — the bracket implementation lives in ./manage.js
 * alongside the other management lib functions (single source of truth);
 * this module is the dedicated home for the bracket API so callers can
 * import it as `../lib/bracket.js`.
 */
export {
  createBracket,
  getBracket,
  isPowerOfTwo,
  reportMatch,
  seasonStandings,
  type BracketState,
  type MatchRow,
  type StandingEntry,
} from "./manage.js";
