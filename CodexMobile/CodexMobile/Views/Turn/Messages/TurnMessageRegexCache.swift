// FILE: TurnMessageRegexCache.swift
// Purpose: Shared regex patterns for turn message parsing and formatting.
// Layer: Infrastructure
// Exports: TurnMessageRegexCache
// Depends on: Foundation

import Foundation

nonisolated enum TurnMessageRegexCache {
    static let inlineAction = try? NSRegularExpression(
        pattern: #"(?i)^(edited|updated|added|created|deleted|removed|renamed|moved)\s+(.+?)$"#
    )
    static let inlineTotals = try? NSRegularExpression(
        pattern: #"[+\u{FF0B}]\s*(\d+)\s*[-\u{2212}\u{2013}\u{2014}\u{FE63}\u{FF0D}]\s*(\d+)"#
    )
    static let trailingInlineTotals = try? NSRegularExpression(
        pattern: #"\s*[+\u{FF0B}]\s*\d+\s*[-\u{2212}\u{2013}\u{2014}\u{FE63}\u{FF0D}]\s*\d+\s*$"#
    )
    static let trailingLineColumn = try? NSRegularExpression(pattern: #":\d+(?::\d+)?$"#)
    static let fileLikeToken = try? NSRegularExpression(pattern: #"[A-Za-z0-9_+.-]+\.[A-Za-z0-9]+$"#)
    static let heading = try? NSRegularExpression(pattern: #"(?m)^#{1,6}\s+(.+)$"#)
    static let genericPath = try? NSRegularExpression(
        pattern: #"(?:[A-Za-z]:[\\/][^\s`"'<>]+|\/[^\s`"'<>]+|~\/[^\s`"'<>]+|\.{1,2}\/[^\s`"'<>]+|[A-Za-z0-9._+\-]+(?:\/[A-Za-z0-9._+\-]+)+)(?::\d+(?::\d+)?)?"#
    )
    static let inlineCodeContent = try? NSRegularExpression(pattern: #"`([^`\n]+)`"#)
    static let markdownLinkRange = try? NSRegularExpression(pattern: #"\[[^\]]+\]\([^)]+\)"#)
    static let inlineCodeRange = try? NSRegularExpression(pattern: #"`[^`]+`"#)
    static let userMentionToken = try? NSRegularExpression(
        // File mentions may contain spaces, but skills remain single-token `$name` or `/name` values.
        pattern: #"(?<![A-Za-z0-9_])(?:(@)((?:[^@$\n]+?\.[A-Za-z0-9]+)|(?:[^\s@$]+))|([$/])([^\s@$/]+))(?=[\s,.;:!?)\]}>]|$)"#
    )
    static let filenameWithLine = try? NSRegularExpression(pattern: #"^(.*\.[A-Za-z0-9]+)(?::|#L)(\d+)(?::\d+|-L?\d+)?$"#)
    static let inlineEditingRow = try? NSRegularExpression(
        pattern: #"(?i)^(edited|updated|added|created|deleted|removed|renamed|moved)\s+.+\s+[+\u{FF0B}]\s*\d+\s*[-\u{2212}\u{2013}\u{2014}\u{FE63}\u{FF0D}]\s*\d+\s*$"#
    )
    static let collapsibleNewlines = try? NSRegularExpression(pattern: #"\n{3,}"#)
    static let thinkingSummaryLine = try? NSRegularExpression(pattern: #"^\s*\*\*(.+?)\*\*\s*$"#)

    // ─── Shared Helpers ─────────────────────────────────────────────

    static func parseMarkdownLink(from token: String) -> (label: String, destination: String)? {
        let nsToken = token as NSString
        guard let match = markdownLinks(in: token).first,
              match.range == NSRange(location: 0, length: nsToken.length),
              !match.isImage else {
            return nil
        }
        let label = nsToken.substring(with: match.labelRange)
        let destination = nsToken.substring(with: match.destinationRange)
        return (label: label, destination: destination)
    }

    static func markdownLinkRanges(in line: String) -> [NSRange] {
        markdownLinks(in: line).map(\.range)
    }

    struct MarkdownLinkMatch {
        let range: NSRange
        let labelRange: NSRange
        let destinationRange: NSRange
        let isImage: Bool
    }

    // A small scanner keeps parentheses and angle-bracket destinations intact; a flat
    // regex ends at the first ')' and can accidentally linkify the rest of a filename.
    static func markdownLinks(in line: String) -> [MarkdownLinkMatch] {
        let text = line as NSString
        var links: [MarkdownLinkMatch] = []
        var cursor = 0
        while cursor < text.length {
            let opening = text.range(of: "[", range: NSRange(location: cursor, length: text.length - cursor))
            guard opening.location != NSNotFound else { break }
            let start = opening.location
            cursor = start + 1
            guard !isEscaped(start, in: text) else { continue }
            var labelEnd = start + 1
            var labelDepth = 1
            while labelEnd < text.length {
                let character = text.character(at: labelEnd)
                if !isEscaped(labelEnd, in: text) {
                    if character == 91 { labelDepth += 1 }
                    if character == 93 { labelDepth -= 1 }
                }
                if labelDepth == 0 { break }
                labelEnd += 1
            }
            guard labelEnd + 1 < text.length, text.character(at: labelEnd + 1) == 40 else { continue }
            let bodyStart = labelEnd + 2
            var end = bodyStart
            var depth = 0
            var angleEnd: Int?
            var titleQuote: UInt16?
            let isAngle = bodyStart < text.length && text.character(at: bodyStart) == 60
            let bodyPrefix = text.substring(with: NSRange(location: bodyStart, length: min(3, text.length - bodyStart)))
            let isWindowsPath = bodyPrefix.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil
            while end < text.length {
                let character = text.character(at: end)
                let escaped = !isWindowsPath && isEscaped(end, in: text)
                if isAngle && angleEnd == nil {
                    if character == 62 && !escaped { angleEnd = end }
                } else if !escaped {
                    if let quote = titleQuote {
                        if character == quote { titleQuote = nil }
                    } else if (character == 34 || character == 39) && end > bodyStart
                        && (text.character(at: end - 1) == 32 || text.character(at: end - 1) == 9) {
                        titleQuote = character
                    } else {
                        if character == 40 { depth += 1 }
                        if character == 41 {
                            if depth == 0 { break }
                            depth -= 1
                        }
                    }
                }
                end += 1
            }
            guard end < text.length, !isAngle || angleEnd != nil else { continue }
            let isImage = start > 0 && text.character(at: start - 1) == 33 && !isEscaped(start - 1, in: text)
            let rangeStart = isImage ? start - 1 : start
            let destinationStart = isAngle ? bodyStart + 1 : bodyStart
            var destinationEnd = isAngle ? angleEnd! : end
            if !isAngle {
                let body = text.substring(with: NSRange(location: bodyStart, length: end - bodyStart))
                if let title = body.range(of: #"\s+["'][^"']*["']\s*$"#, options: .regularExpression) {
                    destinationEnd = bodyStart + (String(body[..<title.lowerBound]) as NSString).length
                }
            }
            links.append(MarkdownLinkMatch(
                range: NSRange(location: rangeStart, length: end - rangeStart + 1),
                labelRange: NSRange(location: start + 1, length: labelEnd - start - 1),
                destinationRange: NSRange(location: destinationStart, length: destinationEnd - destinationStart),
                isImage: isImage
            ))
            cursor = end + 1
        }
        return links
    }

    private static func isEscaped(_ index: Int, in text: NSString) -> Bool {
        var preceding = index - 1
        var count = 0
        while preceding >= 0 && text.character(at: preceding) == 92 {
            count += 1
            preceding -= 1
        }
        return count % 2 == 1
    }

    static func inlineCodeRanges(in line: String) -> [NSRange] {
        guard let regex = inlineCodeRange else { return [] }
        let nsLine = line as NSString
        return regex.matches(in: line, range: NSRange(location: 0, length: nsLine.length)).map(\.range)
    }

    static func rangeOverlaps(_ range: NSRange, protectedRanges: [NSRange]) -> Bool {
        for protectedRange in protectedRanges where NSIntersectionRange(range, protectedRange).length > 0 {
            return true
        }
        return false
    }

    static func replaceMatches(in text: String, regex: NSRegularExpression?, template: String) -> String {
        guard let regex else { return text }
        let fullRange = NSRange(location: 0, length: (text as NSString).length)
        return regex.stringByReplacingMatches(in: text, range: fullRange, withTemplate: template)
    }

    static func removingTrailingLineColumnSuffix(from token: String) -> String {
        guard let regex = trailingLineColumn else {
            return token
        }

        let fullRange = NSRange(location: 0, length: (token as NSString).length)
        guard let match = regex.firstMatch(in: token, range: fullRange),
              match.range.location != NSNotFound,
              let range = Range(match.range, in: token) else {
            return token
        }

        var normalizedToken = token
        normalizedToken.removeSubrange(range)
        return normalizedToken
    }
}

// Shared heuristics for deciding whether an `@token` is plausibly a file/path
// reference instead of copied terminal syntax such as `@scope/pkg:build`.
enum TurnFileMentionHeuristics {
    // Keeps common extensionless files mentionable without reopening the door to arbitrary
    // terminal handles such as `@workspace` or `@remodex`.
    private static let allowedExtensionlessFileNames: Set<String> = [
        ".env",
        ".env.example",
        ".gitignore",
        ".node-version",
        ".nvmrc",
        "Brewfile",
        "Cartfile",
        "Dangerfile",
        "Dockerfile",
        "Gemfile",
        "LICENSE",
        "Makefile",
        "Podfile",
        "Procfile",
        "README",
        "Rakefile",
    ]

    static func isAllowedAutocompleteQuery(_ query: String) -> Bool {
        isAllowedFileLikeToken(query)
    }

    static func isAllowedInlineMentionToken(_ token: String) -> Bool {
        isAllowedFileLikeToken(token)
    }

    private static func isAllowedFileLikeToken(_ token: String) -> Bool {
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else {
            return false
        }

        guard !containsUnsupportedColonSyntax(trimmedToken) else {
            return false
        }

        if looksPathLike(trimmedToken) {
            return true
        }

        if allowedExtensionlessFileNames.contains(trimmedToken) {
            return true
        }

        return false
    }

    private static func looksPathLike(_ token: String) -> Bool {
        let normalizedToken = TurnMessageRegexCache.removingTrailingLineColumnSuffix(from: token)
        return normalizedToken.contains("/")
            || normalizedToken.contains("\\")
            || normalizedToken.contains(".")
    }

    // Keeps `foo.swift:42` valid while rejecting task labels like `pkg/build:watch`.
    private static func containsUnsupportedColonSyntax(_ token: String) -> Bool {
        var normalizedToken = TurnMessageRegexCache.removingTrailingLineColumnSuffix(from: token)
        if hasWindowsDrivePrefix(normalizedToken) {
            normalizedToken.removeFirst(2)
        }
        return normalizedToken.contains(":")
    }

    private static func hasWindowsDrivePrefix(_ token: String) -> Bool {
        guard token.count >= 3 else { return false }
        let characters = Array(token)
        return characters[0].isLetter && characters[1] == ":" && (characters[2] == "\\" || characters[2] == "/")
    }
}
