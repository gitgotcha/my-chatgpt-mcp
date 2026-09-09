// T05: Windows-user scoped secret storage.
// Values are encrypted before they touch disk. The default protector delegates
// to Windows DPAPI through a short-lived PowerShell process; tests may inject a
// deterministic protector without ever weakening the production path.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

const KEY = /^[A-Za-z0-9._-]{1,200}$/;

function ensureKey(key) {
  if (typeof key !== "string" || !KEY.test(key)) throw fail("invalid_secure_key");
  return key;
}

function psBinary() {
  if (process.platform !== "win32") throw fail("secure_store_unavailable");
  return process.env.ComSpec ? "powershell.exe" : "powershell.exe";
}

function runPowerShell(script, input) {
  try {
    return execFileSync(psBinary(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      input,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch (cause) {
    throw fail("secure_store_unavailable", { cause: String(cause?.message ?? "") });
  }
}

export function createWindowsDpapiProtector() {
  return {
    protect(value) {
      if (typeof value !== "string") throw fail("invalid_secure_value");
      return runPowerShell(
        "$plain=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $plain -AsPlainText -Force | ConvertFrom-SecureString",
        value
      );
    },
    unprotect(value) {
      if (typeof value !== "string") throw fail("invalid_secure_value");
      return runPowerShell(
        "$enc=[Console]::In.ReadToEnd(); $sec=ConvertTo-SecureString -String $enc; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }",
        value
      );
    }
  };
}

function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs are inherited. */ }
    renameSync(temporary, path);
  } catch (cause) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw fail("secure_store_unavailable", { cause: String(cause?.message ?? "") });
  }
}

export function createSecureStore({ root, protector } = {}) {
  if (typeof root !== "string" || !root.trim()) throw fail("invalid_secure_root");
  mkdirSync(root, { recursive: true });
  const crypto = protector ?? createWindowsDpapiProtector();
  if (typeof crypto?.protect !== "function" || typeof crypto?.unprotect !== "function") throw fail("invalid_secure_protector");

  const pathFor = (key) => join(root, ensureKey(key));
  return {
    set(key, value) {
      ensureKey(key);
      if (typeof value !== "string") throw fail("invalid_secure_value");
      const encoded = crypto.protect(value);
      if (typeof encoded !== "string" || !encoded) throw fail("secure_store_unavailable");
      atomicWrite(pathFor(key), encoded);
    },
    get(key) {
      ensureKey(key);
      const path = pathFor(key);
      try {
        const encoded = readFileSync(path, "utf8");
        return crypto.unprotect(encoded);
      } catch (cause) {
        if (cause?.code === "ENOENT") return null;
        if (cause?.code === "secure_store_unavailable") throw cause;
        throw fail("secure_store_unavailable", { cause: String(cause?.message ?? "") });
      }
    },
    remove(key) {
      ensureKey(key);
      try { unlinkSync(pathFor(key)); } catch (cause) {
        if (cause?.code !== "ENOENT") throw fail("secure_store_unavailable", { cause: String(cause?.message ?? "") });
      }
    },
    has(key) {
      return this.get(key) !== null;
    }
  };
}
