// Rótulos em PT-BR para a saída humana da CLI. Valores em JSON (severity,
// verdict, rule) continuam em inglês: são identificadores, não mensagens.

/** @type {Record<string, string>} */
const SEVERITY = { critical: "CRÍTICA", high: "ALTA", medium: "MÉDIA", low: "BAIXA", unknown: "DESCONHECIDA" };

/** @param {string} severity */
export const severityLabel = (severity) => SEVERITY[severity] ?? severity.toUpperCase();
