// FILE: WorkspaceFileLinkResolver.swift
// Purpose: Resolves local markdown destinations without treating Windows drives as URL schemes.
// Layer: Turn UI rendering support
// Exports: WorkspaceFileLinkResolver, WorkspaceLinkedFilePreviewKind
// Depends on: Foundation

import Foundation

enum WorkspaceLinkedFilePreviewKind: Equatable {
    case imageFirst
    case textFirst
    case download
}

enum WorkspaceFileLinkResolver {
    private static let textFileExtensions: Set<String> = [
        "bash", "c", "cc", "cjs", "cpp", "cs", "css", "go", "h", "html", "java",
        "js", "json", "jsx", "kt", "m", "md", "mjs", "mm", "py", "rb", "rs",
        "scss", "sh", "sql", "swift", "toml", "ts", "tsx", "txt", "xml", "yaml",
        "yml", "zsh"
    ]
    private static let imageFileExtensions: Set<String> = [
        "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "webp"
    ]
    private static let extensionlessFileNames: Set<String> = [
        ".env", ".gitignore", "dockerfile", "gemfile", "license", "makefile", "podfile", "readme"
    ]
    private static let webHostSuffixes: Set<String> = [
        "com", "org", "net", "io", "dev", "app", "edu", "gov", "cn", "uk"
    ]

    static func localPath(from url: URL) -> String? {
        if url.scheme?.lowercased() == "remodex-file" {
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  components.host == "open",
                  let paths = components.queryItems?.filter({ $0.name == "path" }),
                  paths.count == 1,
                  let value = paths.first?.value else {
                return nil
            }
            return normalizedPath(value)
        }

        if url.isFileURL {
            guard url.host == nil || url.host == "" || url.host?.lowercased() == "localhost" else {
                return nil
            }
            var path = url.path
            // file:///C:/... is a Windows file URL, rather than a POSIX path with a drive folder.
            if path.hasPrefix("/"), hasWindowsDrivePrefix(String(path.dropFirst())) {
                path.removeFirst()
            }
            return normalizedPath(path)
        }

        if url.scheme?.lowercased() == "sandbox" {
            let raw = url.absoluteString.removingPercentEncoding ?? url.absoluteString
            return localPath(fromRawDestination: raw)
        }

        let decodedValue = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        guard url.scheme == nil || hasWindowsDrivePrefix(decodedValue) else {
            return nil
        }
        if hasWindowsDrivePrefix(decodedValue) {
            return normalizedPath(decodedValue)
        }
        guard url.host == nil || url.host == "" else { return nil }
        // Legacy relative URL links use URL query/fragment semantics. New links carry the
        // complete path in an encoded query item, preserving literal '?' and '#' filenames.
        return normalizedPath(url.path)
    }

    static func localPath(fromRawDestination destination: String) -> String? {
        var value = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("<"), value.hasSuffix(">") {
            value = String(value.dropFirst().dropLast())
        }
        if value.lowercased().hasPrefix("file:") || value.lowercased().hasPrefix("remodex-file:") {
            guard let url = URL(string: value) else { return nil }
            return localPath(from: url)
        }
        if value.lowercased().hasPrefix("sandbox:") {
            value = String(value.dropFirst("sandbox:".count))
        }
        return normalizedPath(value)
    }

    static func internalURL(for path: String) -> URL? {
        guard let normalized = normalizedPath(path),
              let encoded = normalized.addingPercentEncoding(
                withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
              ) else {
            return nil
        }
        return URL(string: "remodex-file://open?path=\(encoded)")
    }

    static func displayFileName(for path: String) -> String {
        let usesWindowsSeparators = hasWindowsDrivePrefix(path) || (!path.contains("/") && path.contains("\\"))
        let normalized = usesWindowsSeparators ? path.replacingOccurrences(of: "\\", with: "/") : path
        return (normalized as NSString).lastPathComponent
    }

    static func preferredPreviewKind(for path: String) -> WorkspaceLinkedFilePreviewKind {
        let fileName = displayFileName(for: path).lowercased()
        let fileExtension = (fileName as NSString).pathExtension
        if textFileExtensions.contains(fileExtension) || extensionlessFileNames.contains(fileName) {
            return .textFirst
        }
        return imageFileExtensions.contains(fileExtension) ? .imageFirst : .download
    }

    private static func normalizedPath(_ value: String) -> String? {
        let trimmed = stripLineSuffix(from: value).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("#"),
              !trimmed.hasPrefix("//"),
              !trimmed.hasPrefix("\\\\"),
              !trimmed.contains("\n"), !trimmed.contains("\r"), !trimmed.contains("\0") else {
            return nil
        }
        if hasWindowsDrivePrefix(trimmed) { return trimmed }
        guard trimmed.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) == nil else {
            return nil
        }
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("./") || trimmed.hasPrefix("../") || trimmed.hasPrefix("~/") {
            return trimmed
        }

        let firstComponent = trimmed.split(separator: "/", maxSplits: 1).first.map(String.init) ?? trimmed
        let hostSuffix = (firstComponent as NSString).pathExtension.lowercased()
        guard !webHostSuffixes.contains(hostSuffix) else { return nil }
        let fileName = displayFileName(for: trimmed).lowercased()
        return trimmed.contains("/") || trimmed.contains("\\") || extensionlessFileNames.contains(fileName) || !(fileName as NSString).pathExtension.isEmpty
            ? trimmed : nil
    }

    private static func hasWindowsDrivePrefix(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil
    }

    private static func stripLineSuffix(from value: String) -> String {
        var normalized = value
        if let range = normalized.range(of: #"(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$"#, options: .regularExpression) {
            normalized.removeSubrange(range)
        }
        return normalized
    }
}
