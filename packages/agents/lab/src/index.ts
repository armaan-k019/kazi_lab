export {
  runCrossDomainSynthesis,
  type CrossDomainResult,
} from "./cross-domain";
export {
  runCrossDomainCritique,
  type CrossDomainCritiqueResult,
} from "./cross-domain-critic";
// Shared helpers reused by the Experimentalist (library assembly + the
// balanced-brace JSON extractor), so grounding and parsing stay identical.
export { extractJsonObject } from "./json";
export {
  assembleLibrary,
  type LibraryAssembly,
} from "./cross-domain";
