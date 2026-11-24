import Foundation

public enum DSHReaderError: Error, CustomStringConvertible {
    case rootMissing(String)
    case zstdMissing
    case decompressFailed(String)
    case unreadable(String)

    public var description: String {
        switch self {
        case .rootMissing(let path):
            return "DSH sessions directory not found: " + path
        case .zstdMissing:
            return "zstd is required to read .zstd session files (brew install zstd)"
        case .decompressFailed(let message):
            return "zstd failed: " + message
        case .unreadable(let message):
            return "cannot read session: " + message
        }
    }
}

/// Reads DeepSeek Harness session files (v4 JSONL, optionally zstd-compressed)
/// and maps them onto the relay session model.
///
/// The on-disk format is owned by DSH and may change; this adapter is best-effort
/// and only consumes: the session header, session/title, user/message (text parts
/// from real user turns) and assistant/message (text parts only).
public struct DSHReader {
    public var root: URL
    public var zstdCommand: String

    public init(root: URL, zstdCommand: String = "zstd") {
        self.root = root
        self.zstdCommand = zstdCommand
    }

    public static func defaultRoot() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh")
            .appendingPathComponent("sessions")
    }

    public struct SessionFile: Hashable {
        public var url: URL
        public var sessionId: String
        public var modified: Date
    }

    public func sessionFiles() throws -> [SessionFile] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: root.path) else {
            throw DSHReaderError.rootMissing(root.path)
        }
        var files: [SessionFile] = []
        let workspaces = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        for workspace in workspaces where workspace.hasDirectoryPath {
            let sessions = (try? fm.contentsOfDirectory(at: workspace, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            for sessionDir in sessions where sessionDir.hasDirectoryPath {
                for name in ["session.v4.jsonl.zstd", "session.v4.jsonl", "session.jsonl"] {
                    let candidate = sessionDir.appendingPathComponent(name)
                    guard fm.fileExists(atPath: candidate.path) else { continue }
                    let modified = (try? candidate.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                    files.append(
                        SessionFile(
                            url: candidate,
                            sessionId: sessionDir.lastPathComponent,
                            modified: modified
                        )
                    )
                    break
                }
            }
        }
        return files.sorted { $0.modified > $1.modified }
    }

    public func readRecent(limit: Int = 50) throws -> [RelaySession] {
        var result: [RelaySession] = []
        for file in try sessionFiles().prefix(limit) {
            if let session = try? read(file.url) {
                result.append(session)
            }
        }
        return result
    }

    public func readSession(id: String) throws -> RelaySession {
        let files = try sessionFiles()
        if let match = files.first(where: { $0.sessionId == id }) {
            return try read(match.url)
        }
        // Fall back to scanning headers when the directory name differs from the session id.
        for file in files.prefix(200) {
            if let session = try? read(file.url), session.id == id {
                return session
            }
        }
        throw DSHReaderError.unreadable("session " + id + " not found under " + root.path)
    }

    // MARK: - Parsing

    public func read(_ url: URL) throws -> RelaySession {
        let data = try load(url)
        guard let text = String(data: data, encoding: .utf8) else {
            throw DSHReaderError.unreadable("not UTF-8: " + url.lastPathComponent)
        }

        var header: [String: Any]?
        var title: String?
        var messages: [RelayMessage] = []
        var lastEventMillis: Double?

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let lineData = rawLine.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let type = object["type"] as? String
            else { continue }

            if let time = object["time"] as? Double { lastEventMillis = time }
            let payload = object["data"] as? [String: Any]

            switch type {
            case "session":
                header = object
            case "session/title":
                if let value = payload?["title"] as? String, !value.isEmpty { title = value }
            case "user/message":
                let source = payload?["source"] as? [String: Any]
                let kind = source?["kind"] as? String
                if let kind, kind != "user" { continue }
                let text = extractText(payload?["content"])
                if !text.isEmpty {
                    messages.append(RelayMessage(role: "user", text: text, createdAt: isoString(lastEventMillis)))
                }
            case "assistant/message":
                let message = payload?["message"] as? [String: Any]
                let text = extractText(message?["content"], allowed: ["text"])
                if !text.isEmpty {
                    messages.append(RelayMessage(role: "assistant", text: text, createdAt: isoString(lastEventMillis)))
                }
            default:
                continue
            }
        }

        guard let header else {
            throw DSHReaderError.unreadable("no session header in " + url.lastPathComponent)
        }
        let id = (header["id"] as? String) ?? url.deletingLastPathComponent().lastPathComponent
        let cwd = (header["cwd"] as? String) ?? ""
        let createdAt = isoString(header["createdAt"] as? Double) ?? isoString(lastEventMillis) ?? isoNow()
        let updatedAt = isoString(lastEventMillis) ?? createdAt
        let resolvedTitle = title ?? fallbackTitle(messages: messages, id: id)

        return RelaySession(
            id: id,
            title: resolvedTitle,
            workspace: cwd,
            engine: "dsh",
            createdAt: createdAt,
            updatedAt: updatedAt,
            messages: messages
        )
    }

    private func load(_ url: URL) throws -> Data {
        if url.pathExtension != "zstd" {
            return try Data(contentsOf: url)
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [zstdCommand, "-dc", url.path]
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            throw DSHReaderError.zstdMissing
        }
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let errorData = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(data: errorData, encoding: .utf8) ?? "exit " + String(process.terminationStatus)
            if message.contains("not found") || message.contains("No such file") {
                throw DSHReaderError.zstdMissing
            }
            throw DSHReaderError.decompressFailed(message.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return output
    }

    private func extractText(_ content: Any?, allowed: Set<String> = ["text"]) -> String {
        guard let parts = content as? [[String: Any]] else { return "" }
        var chunks: [String] = []
        for part in parts {
            guard let kind = part["type"] as? String, allowed.contains(kind) else { continue }
            if let text = part["text"] as? String, !text.isEmpty { chunks.append(text) }
        }
        return chunks.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func fallbackTitle(messages: [RelayMessage], id: String) -> String {
        if let first = messages.first(where: { $0.role == "user" }), !first.text.isEmpty {
            let line = first.text.split(separator: "\n").first.map(String.init) ?? first.text
            return String(line.prefix(80))
        }
        return id
    }

    private func isoString(_ millis: Double?) -> String? {
        guard let millis else { return nil }
        let date = Date(timeIntervalSince1970: millis / 1000)
        return ISO8601DateFormatter.relay.string(from: date)
    }

    private func isoNow() -> String {
        ISO8601DateFormatter.relay.string(from: Date())
    }
}

extension ISO8601DateFormatter {
    static let relay: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
