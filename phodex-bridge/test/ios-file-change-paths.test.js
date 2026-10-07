const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("iOS file-change identity matches Windows paths without changing POSIX filenames", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 60000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-swift-file-change-paths-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../CodexMobile/CodexMobile/Views/Turn/Diff/TurnPerFileDiffParser.swift"), "utf8");
  const start = source.indexOf("enum FileChangePathIdentity {");
  const end = source.indexOf("\nenum PerFileDiffParser {", start);
  assert.ok(start >= 0 && end > start, "compile the complete production identity helper");
  const harness = path.join(directory, "FileChangePaths.swift");
  fs.writeFileSync(harness, `import Foundation\n${source.slice(start, end)}\n` + String.raw`
let cases: [(String, String, Bool)] = [
    ("D:/Projects/Demo/Sources/App.swift", "Sources/App.swift", true),
    (#"D:\Projects\Demo\Sources\App.swift"#, "Sources/App.swift", true),
    (#"D:\Projects\Demo\Sources\App.swift"#, #"Sources\App.swift"#, true),
    ("D:/Projects/Demo/Sources/App.swift", #"Sources\App.swift"#, true),
    (#"D:\Projects\Demo\Sources\App.swift"#, "d:/projects/demo/Sources/App.swift", true),
    ("D:/Projects/Demo/Sources/App.swift", "Tests/App.swift", false),
    ("D:/Projects/Demo/Sources/App.swift", "App.swift", false),
    ("D:/Projects/Demo/Sources/App.swift", "C:/Projects/Demo/Sources/App.swift", false),
    ("D:Projects/Demo/Sources/App.swift", "Sources/App.swift", false),
    ("C:relative", "relative", false),
    ("/repo/Sources/App.swift", "Sources/App.swift", true),
    ("/repo/Sources/App.swift", "./Sources/App.swift:12:3", true),
    ("/repo/Sources/App.swift", "a/Sources/App.swift", true),
    ("/repo/Sources/App.swift", "Tests/App.swift", false),
    ("/repo/Sources/App.swift", "App.swift", false),
    (#"/repo/Sources/App\name.swift"#, #"Sources/App\name.swift"#, true),
    (#"/repo/Sources/App\name.swift"#, "Sources/App/name.swift", false),
    (#"Sources\App.swift"#, "Sources/App.swift", false),
    ("", "Sources/App.swift", false),
]
for (lhs, rhs, expected) in cases {
    precondition(FileChangePathIdentity.representsSameFile(lhs, rhs) == expected, "mismatch: \(lhs) versus \(rhs)")
    precondition(FileChangePathIdentity.representsSameFile(rhs, lhs) == expected, "reverse mismatch: \(rhs) versus \(lhs)")
}
precondition(FileChangePathIdentity.preferredDisplayPath("D:/Projects/Demo/Sources/App.swift", "Sources/App.swift") == "Sources/App.swift")
print("file-change path checks passed")
`);
  const binary = path.join(directory, "file-change-paths");
  execFileSync("xcrun", ["swiftc", "-module-cache-path", path.join(directory, "cache"), harness, "-o", binary],
    { timeout: 45000 });
  const output = execFileSync(binary, { encoding: "utf8", timeout: 10000 });
  assert.match(output, /file-change path checks passed/);
});
