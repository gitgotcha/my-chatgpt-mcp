// V2 projection reducer registry.  Queue messages select a task entry point;
// the task's authoritative scope selects the reducer.  No caller-provided
// message field can switch an algorithm task into another domain.
import { algorithmReducer } from "./algorithm.js";
import { genericProfileReducer } from "./generic-profile.js";
import { interviewReducer } from "./interview.js";
import { resumeKnowledgeReducer } from "./resume-knowledge.js";

const UNSUPPORTED_CODE = "unsupported_projection_domain";

const unsupportedReducer = Object.freeze({
  reads() { return []; },
  plan() {
    const error = new Error(UNSUPPORTED_CODE);
    error.code = UNSUPPORTED_CODE;
    throw error;
  },
  planPageReads() { return { reads: [] }; },
  buildPage() {
    const error = new Error(UNSUPPORTED_CODE);
    error.code = UNSUPPORTED_CODE;
    throw error;
  }
});

export function reducerForScope(scope = {}, overrides = {}) {
  const { namespace, projectionName } = scope;
  // Queue consumers pass the authoritative D1 task row, whose columns use
  // snake_case. HTTP/test callers commonly use the camelCase scope DTO. Both
  // spellings describe the same scope; normalize at this boundary so a valid
  // algorithm task cannot fall through to unsupported_projection_domain.
  const scopeProjectionName = projectionName ?? scope.projection_name;
  if (typeof overrides.reducerForScope === "function") {
    return overrides.reducerForScope({ namespace, projectionName: scopeProjectionName });
  }
  if (namespace === "algorithm" && scopeProjectionName === "learning") return algorithmReducer;
  if (namespace === "profile") return genericProfileReducer;
  if (namespace === "interview" && scopeProjectionName === "interview") return interviewReducer;
  if (namespace === "resume-knowledge" && scopeProjectionName === "resume-knowledge") return resumeKnowledgeReducer;
  return unsupportedReducer;
}

export { unsupportedReducer };
