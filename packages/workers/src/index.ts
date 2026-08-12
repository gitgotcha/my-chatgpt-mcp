import { D1JobRepository, type D1Database } from "./db.js";
import { createIngressHandler, type WorkerEnvironment } from "./ingress.js";

export interface Environment extends WorkerEnvironment {
  DB: D1Database;
}

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    return createIngressHandler(env, new D1JobRepository(env.DB))(request);
  }
};
