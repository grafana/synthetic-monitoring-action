import { execFileSync } from "node:child_process";

export function ghApiGet(path: string): string {
  return execFileSync("gh", ["api", path, "--paginate"], { encoding: "utf8" });
}

export function ghApiWrite(path: string, method: string, body: Record<string, unknown>): void {
  execFileSync("gh", ["api", path, "-X", method, "--input", "-"], {
    encoding: "utf8",
    input: JSON.stringify(body),
  });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}
