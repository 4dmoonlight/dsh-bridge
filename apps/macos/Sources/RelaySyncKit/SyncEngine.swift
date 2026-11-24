import Foundation

public struct SyncReport: Sendable {
    public var pushed: Int
    public var skipped: Int
    public var removed: Int
    public var scanned: Int
}

/// Drives the two halves of the relay protocol from the Mac:
/// host mode pushes local DSH sessions and answers live relay commands;
/// client mode reads sessions other devices pushed.
public final class SyncEngine: @unchecked Sendable {
    public let reader: DSHReader
    public let client: RelayClient

    public init(reader: DSHReader, client: RelayClient) {
        self.reader = reader
        self.client = client
    }

    /// Read up to limit recent sessions and push them.
    public func push(limit: Int = 50, full: Bool = false, maxMessages: Int = 200) async throws -> SyncReport {
        let sessions = try reader.readRecent(limit: limit).map { $0.trimmed(maxMessages: maxMessages) }
        guard !sessions.isEmpty else {
            return SyncReport(pushed: 0, skipped: 0, removed: 0, scanned: 0)
        }
        let response = try await client.sync(sessions: sessions, full: full)
        return SyncReport(
            pushed: response.accepted.count,
            skipped: response.skipped.count,
            removed: response.removed.count,
            scanned: sessions.count
        )
    }

    /// Host loop: keep a command poll parked and re-push periodically until cancelled.
    public func serveHost(
        pushEverySeconds: Double = 30,
        pollWaitSeconds: Int = 20,
        onLog: @escaping @Sendable (String) -> Void = { _ in }
    ) async {
        var lastPush = Date.distantPast
        while !Task.isCancelled {
            do {
                if Date().timeIntervalSince(lastPush) > pushEverySeconds {
                    let report = try await push()
                    lastPush = Date()
                    onLog("pushed \(report.pushed) session(s), skipped \(report.skipped), scanned \(report.scanned)")
                }
                let command = try await client.pollHostCommand(waitSeconds: pollWaitSeconds)
                guard let command else { continue }
                onLog("relay command " + command.method + " (" + command.id + ")")
                if command.method == "session.fetch", let sessionId = command.params?.sessionId {
                    let session = try? reader.readSession(id: sessionId)
                    try await client.reportHostResult(commandId: command.id, session: session?.trimmed())
                } else {
                    try await client.reportHostResult(commandId: command.id, session: nil)
                }
            } catch {
                onLog("host loop error: " + String(describing: error))
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
}
