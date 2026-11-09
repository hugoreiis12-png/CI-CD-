// S2: only real test locations are exempt — whole path segments or *.test.* /
// *.spec.* names. A substring match let "latest/", "contest.js" or
// "attestation.mjs" skip every check.
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|__fixtures__|testdata)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/i;

export const isTestPath = (path) => TEST_PATH.test(path);
