// Cross-platform Gradle wrapper runner for the Android build.
//
// The gradlew executable bit is not carried by every push path (the GitHub
// snapshot push used for this repo explicitly excludes file modes, and the
// contents API always creates files as 100644), so this script sets the bit
// itself on POSIX before spawning ./gradlew, and uses gradlew.bat on Windows.
// `node scripts/run-gradlew.mjs --dry-run [args]` prints the command without
// running it. Requires an Android SDK for a real build; without one Gradle
// fails at SDK detection, which is expected.
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const androidDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "android");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const gradleArgs = args.filter((arg) => arg !== "--dry-run");
const isWindows = process.platform === "win32";
const wrapper = isWindows ? "gradlew.bat" : "gradlew";
const wrapperPath = path.join(androidDir, wrapper);

if (!isWindows) {
  try {
    await chmod(wrapperPath, 0o755);
  } catch {
    // Bit already set, or the filesystem is read-only: spawning below reports.
  }
}

if (dryRun) {
  console.log(`Would run: ${wrapper} ${gradleArgs.join(" ") || "assembleDebug"} (cwd: ${androidDir})`);
  process.exit(0);
}

const child = spawn(wrapperPath, gradleArgs.length ? gradleArgs : ["assembleDebug"], {
  cwd: androidDir,
  stdio: "inherit",
  shell: isWindows
});
child.on("error", (error) => {
  console.error(`Could not start ${wrapper}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
