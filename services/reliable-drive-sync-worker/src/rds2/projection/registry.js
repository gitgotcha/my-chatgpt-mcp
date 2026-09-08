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

export function reducerForScope({ namespace, projectionName } = {}, overrides = {}) {
  if (typeof overrides.reducerForScope === "function") {
    return overrides.reducerForScope({ namespace, projectionName });
  }
  if (namespace === "algorithm" && projectionName === "learning") return algorithmReducer;
  if (namespace === "profile") return genericProfileReducer;
  if (namespace === "interview" && projectionName === "interview") return interviewReducer;
  if (namespace === "resume-knowledge" && projectionName === "resume-knowledge") return resumeKnowledgeReducer;
  return unsupportedReducer;
}

export { unsupportedReducer };

