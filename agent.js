/* global process */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MAX_ROLLBACKS = 1;
const WINDOWS = process.platform === "win32";

function notify(message) {
  console.log(`[agent] ${message}`);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    shell: WINDOWS,
    timeout: 10 * 60 * 1000,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output) console.log(output.trimEnd());

  if (result.error) {
    return { ok: false, reason: result.error.message, output };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `command exited with status ${result.status}`,
      output,
    };
  }
  return { ok: true, output };
}

function npm(command, ...args) {
  return runCommand(WINDOWS ? "npm.cmd" : "npm", [command, ...args]);
}

function vercel(args) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return { ok: false, reason: "VERCEL_TOKEN is not set" };
  }
  return runCommand(
    WINDOWS ? "vercel.cmd" : "vercel",
    [...args, "--token", token],
  );
}

async function runTests() {
  notify("Tool: runTests()");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  if (!packageJson.scripts?.test) {
    notify("No test script is configured; skipping tests.");
    return { ok: true };
  }

  const result = npm("run", "test");
  return result.ok ? result : { ok: false, reason: "tests failed" };
}

async function lintCode() {
  notify("Tool: lintCode()");
  const result = runCommand(
    WINDOWS ? "npx.cmd" : "npx",
    ["eslint", "src", "--max-warnings", "0"],
  );
  return result.ok ? result : { ok: false, reason: "lint errors" };
}

async function buildApp() {
  notify("Tool: buildApp()");
  const result = npm("run", "build");
  return result.ok ? result : { ok: false, reason: "build failed" };
}

async function checkPWA() {
  notify("Tool: checkPWA()");
  const requiredFiles = ["dist/manifest.json", "dist/service-worker.js"];
  const missingFiles = requiredFiles.filter((file) => !existsSync(file));

  if (missingFiles.length > 0) {
    return {
      ok: false,
      reason: `missing PWA build files: ${missingFiles.join(", ")}`,
    };
  }
  return { ok: true };
}

async function deploy() {
  notify("Tool: deploy()");
  const linkedProject = existsSync(".vercel/project.json");
  const projectIdsAvailable =
    process.env.VERCEL_ORG_ID && process.env.VERCEL_PROJECT_ID;
  if (!linkedProject && !projectIdsAvailable) {
    return {
      ok: false,
      reason:
        "Vercel project is not linked; run `vercel link` and commit .vercel/project.json, or configure VERCEL_ORG_ID and VERCEL_PROJECT_ID",
    };
  }

  const result = vercel(["deploy", "--prod", "--yes"]);
  if (!result.ok) {
    return { ok: false, reason: `deployment failed: ${result.reason}` };
  }

  const urls = result.output.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  const url = urls.at(-1)?.replace(/[),.;]+$/, "");
  if (!url) {
    return {
      ok: false,
      reason: "deployment succeeded but the CLI did not report a URL",
    };
  }

  notify(`Deployment URL: ${url}`);
  return { ok: true, url };
}

async function checkHealth(url) {
  notify(`Tool: checkHealth(${url})`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return response.status === 200
      ? { ok: true }
      : { ok: false, reason: `health check returned HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      reason: `health check request failed: ${error.message}`,
    };
  }
}

async function rollback() {
  notify("Tool: rollback()");
  const result = vercel(["rollback", "--yes"]);
  return result.ok ? result : { ok: false, reason: `rollback failed: ${result.reason}` };
}

async function runAgent() {
  notify("Starting deployment checks.");

  for (const [name, tool] of [
    ["tests", runTests],
    ["lint", lintCode],
    ["build", buildApp],
    ["PWA validation", checkPWA],
  ]) {
    const result = await tool();
    if (!result.ok) {
      notify(`${name} failed: ${result.reason}. Deployment stopped.`);
      return false;
    }
  }

  const deployment = await deploy();
  if (!deployment.ok) {
    notify(`${deployment.reason}. Deployment stopped.`);
    return false;
  }

  let health = await checkHealth(deployment.url);
  let rollbackCount = 0;
  while (!health.ok) {
    notify(`Health check failed: ${health.reason}`);
    if (rollbackCount >= MAX_ROLLBACKS) {
      notify("Maximum rollbacks reached. Escalating to a human.");
      return false;
    }

    rollbackCount += 1;
    const rollbackResult = await rollback();
    if (!rollbackResult.ok) {
      notify(`${rollbackResult.reason}. Escalating to a human.`);
      return false;
    }
    health = await checkHealth(deployment.url);
  }

  notify("=== Agent finished: SUCCESS ===");
  notify(`Live URL: ${deployment.url}`);
  return true;
}

runAgent()
  .then((success) => {
    if (!success) process.exitCode = 1;
  })
  .catch((error) => {
    notify(`Unexpected agent error: ${error.message}`);
    process.exitCode = 1;
  });