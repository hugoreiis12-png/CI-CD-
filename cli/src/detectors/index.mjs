import {
  detectNode, detectPython, detectGo, detectRust,
  detectJvm, detectDotnet, detectRuby, detectPhp,
} from "./languages.mjs";
import { detectInfra } from "./infra.mjs";

// Add new detectors here. Signature: (root, fingerprint) => finding | null
export const detectors = [
  detectNode, detectPython, detectGo, detectRust,
  detectJvm, detectDotnet, detectRuby, detectPhp, detectInfra,
];
