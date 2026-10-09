const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("iOS local markdown links preserve Windows and binary-document paths", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 60000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-swift-workspace-links-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceDirectory = path.resolve(__dirname, "../../CodexMobile/CodexMobile/Views/Turn/Messages");
  const sources = ["WorkspaceFileLinkResolver.swift", "MarkdownTextFormatter.swift",
    "TurnMessageRegexCache.swift", "TurnMarkdownModels.swift"].map((name) => path.join(sourceDirectory, name));
  const harness = path.join(directory, "main.swift");
  // Compile the production formatter and resolver; only unrelated cache/skill dependencies
  // are replaced so this check needs Foundation rather than the full iOS application.
  fs.writeFileSync(harness, String.raw`
import Foundation

enum MarkdownRenderableTextCache {
    static func rendered(raw: String, profile: MarkdownRenderProfile, builder: () -> String) -> String { builder() }
}
enum SkillReferenceFormatter {
    static func replacingSkillReferences(in text: String, style: SkillReferenceReplacementStyle) -> String { text }
}

func render(_ source: String, profile: MarkdownRenderProfile = .assistantProse) -> String {
    MarkdownTextFormatter.renderableText(from: source, profile: profile, usesCache: false)
}
func checkLink(_ source: String, path: String, profile: MarkdownRenderProfile = .assistantProse) {
    let rendered = render(source, profile: profile)
    let attributed = try! AttributedString(markdown: rendered)
    let urls = attributed.runs.compactMap { $0.link }
    precondition(urls.count == 1, "one clickable link expected: \(rendered)")
    precondition(urls[0].scheme == "remodex-file", "internal scheme expected: \(rendered)")
    precondition(WorkspaceFileLinkResolver.localPath(from: urls[0]) == path, "wrong path: \(rendered)")
    precondition(render(rendered, profile: profile) == rendered, "normalization must be idempotent")
}

let localURLs: [(String, String)] = [
    ("file:///tmp/example.swift", "/tmp/example.swift"),
    ("file:///tmp/report%25%20%23.docx?plain=1#L42", "/tmp/report% #.docx"),
    ("file:///C:/Reports/Review%20%232.docx?download=1#L7", "C:/Reports/Review #2.docx"),
    ("/repo/report.docx", "/repo/report.docx"),
    ("README.md", "README.md"),
    ("Sources/App.swift:42:7", "Sources/App.swift"),
    ("Sources/App.swift#L42", "Sources/App.swift"),
    ("Sources/App.swift?plain=1", "Sources/App.swift"),
    ("Dockerfile", "Dockerfile"),
    ("C:/Reports/Review.docx:12", "C:/Reports/Review.docx"),
    ("C:%5CReports%5CReview.docx", #"C:\Reports\Review.docx"#),
    ("sandbox:/mnt/data/Review.docx", "/mnt/data/Review.docx"),
]
for (source, expected) in localURLs {
    precondition(WorkspaceFileLinkResolver.localPath(from: URL(string: source)!) == expected, "URL mismatch: \(source)")
}

let rawPaths = [
    #"E:\Documents\作品 #1%20 (最终).docx"#,
    "C:/Reports/Review%20.docx",
    "/tmp/报告 #1%20 (最终).pdf",
    "../output/report?draft=1.docx",
    #"reports\作品.xlsx"#,
]
for path in rawPaths {
    precondition(WorkspaceFileLinkResolver.localPath(fromRawDestination: path) == path)
    let internalURL = WorkspaceFileLinkResolver.internalURL(for: path)!
    precondition(WorkspaceFileLinkResolver.localPath(from: internalURL) == path, "path must survive one round trip")
}
precondition(WorkspaceFileLinkResolver.localPath(fromRawDestination: "sandbox:/mnt/data/100%20.docx") == "/mnt/data/100%20.docx")
precondition(WorkspaceFileLinkResolver.localPath(fromRawDestination: #"C:\Reports\App.swift:12:3"#) == #"C:\Reports\App.swift"#)
precondition(WorkspaceFileLinkResolver.localPath(fromRawDestination: "/tmp/App.swift#L12-L19") == "/tmp/App.swift")
precondition(WorkspaceFileLinkResolver.localPath(fromRawDestination: "output.v1/report.custom") == "output.v1/report.custom")
precondition(WorkspaceFileLinkResolver.preferredPreviewKind(for: "report.docx") == .download)
precondition(WorkspaceFileLinkResolver.preferredPreviewKind(for: "archive.zip") == .download)
precondition(WorkspaceFileLinkResolver.preferredPreviewKind(for: "Sources/App.swift") == .textFirst)
precondition(WorkspaceFileLinkResolver.preferredPreviewKind(for: "Dockerfile") == .textFirst)
precondition(WorkspaceFileLinkResolver.preferredPreviewKind(for: "assets/logo.svg") == .imageFirst)
precondition(WorkspaceFileLinkResolver.displayFileName(for: rawPaths[0]) == "作品 #1%20 (最终).docx")
precondition(WorkspaceFileLinkResolver.displayFileName(for: #"reports\作品.xlsx"#) == "作品.xlsx")

let remoteTargets = [
    "https://example.com/report.docx", "http://example.com/App.swift", "mailto:test@example.com",
    "#section", "//server/share/file.docx", #"\\server\share\file.docx"#,
    "file://server/share/file.docx", "example.com", "example.com/App.swift", "C:relative.docx",
]
for target in remoteTargets {
    precondition(WorkspaceFileLinkResolver.localPath(fromRawDestination: target) == nil, "remote target: \(target)")
    if let url = URL(string: target) {
        precondition(WorkspaceFileLinkResolver.localPath(from: url) == nil, "remote URL: \(target)")
    }
}

checkLink("[作品介绍](<" + rawPaths[0] + ">)", path: rawPaths[0])
checkLink("[作品介绍](<" + rawPaths[0] + ">)", path: rawPaths[0], profile: .userProse)
checkLink("[作品介绍](E:/Documents/作品.docx)", path: "E:/Documents/作品.docx")
checkLink("[文档](/tmp/report(2026 (final)).docx)", path: "/tmp/report(2026 (final)).docx")
checkLink("[文档](<../output/report #1%20 (最终).docx> \"作品介绍 )\")", path: "../output/report #1%20 (最终).docx")
checkLink("[文档](file:///C:/Reports/Review%20%232.docx#L7)", path: "C:/Reports/Review #2.docx")
checkLink("[文档](sandbox:/mnt/data/report.docx)", path: "/mnt/data/report.docx")
checkLink("[文档](README.md)", path: "README.md")
checkLink("File: " + rawPaths[0], path: rawPaths[0])
checkLink("Read C:/Reports/Review.docx next.", path: "C:/Reports/Review.docx")
checkLink("Read " + "\u{0060}" + #"C:\Reports\App.swift:12"# + "\u{0060}", path: #"C:\Reports\App.swift"#)

let unchanged = [
    "[website](https://example.com/report(2026).docx#section)",
    "[email](mailto:test@example.com)", "[anchor](#section)",
    "[server](//server/share/report.docx)", #"[server](\\server\share\report.docx)"#,
    "![image](/tmp/report.png)",
    "literal " + "\u{0060}" + "[doc](/tmp/report.docx)" + "\u{0060}",
    String(repeating: "\u{0060}", count: 3) + "\n[doc](/tmp/report.docx)\n" + String(repeating: "\u{0060}", count: 3),
    "~~~text\n[doc](C:/Reports/Review.docx)\n~~~",
]
for source in unchanged {
    precondition(render(source) == source, "must remain literal: \(source)")
}
let userPath = "please read " + "\u{0060}" + "C:/Reports/Review.docx" + "\u{0060}"
precondition(render(userPath, profile: .userProse) == userPath)
let command = "\u{0060}" + "node --test phodex-bridge/test/bridge.test.js" + "\u{0060}"
precondition(render(command) == command)
print("workspace-file link checks passed")
`);
  const binary = path.join(directory, "workspace-file-links");
  execFileSync("xcrun", ["swiftc", "-module-cache-path", path.join(directory, "cache"),
    ...sources, harness, "-o", binary], { timeout: 45000 });
  const output = execFileSync(binary, { encoding: "utf8", timeout: 10000 });
  assert.match(output, /workspace-file link checks passed/);
});
