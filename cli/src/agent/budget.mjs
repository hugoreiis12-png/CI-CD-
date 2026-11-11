/**
 * How long one question may wait for the model. A simple question gets the
 * configured budget (llm.timeoutMs, 60 s by default); an analysis of the
 * project, local or remote, gets up to COMPLEX_TIMEOUT_MS.
 */
export const COMPLEX_TIMEOUT_MS = 600_000;
const COMPLEX_LENGTH = 100;
const COMPLEX_WORDS = /analis|compar|revis|tudo|todo|remot|resum|diagn|depur|investig|verific|confer|por que|porque|problema/i;

/** @param {string} question */
export const isComplexQuestion = (question) => question.length > COMPLEX_LENGTH || COMPLEX_WORDS.test(question);

/**
 * @param {string} question
 * @param {number} simpleMs budget for simple questions (llm.timeoutMs)
 * @returns {number} ms for each model call of this question
 */
export const budgetFor = (question, simpleMs) => (isComplexQuestion(question) ? Math.max(simpleMs, COMPLEX_TIMEOUT_MS) : simpleMs);
