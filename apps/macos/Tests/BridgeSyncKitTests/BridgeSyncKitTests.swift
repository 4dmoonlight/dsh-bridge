import XCTest
@testable import BridgeSyncKit

final class BridgeSyncKitTests: XCTestCase {
    func testSyncRequestUsesProtocolKey() throws {
        let request = SyncRequest(
            full: true,
            sessions: [
                HubSession(
                    id: "s1",
                    title: "t",
                    workspace: "/tmp",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    messages: [HubMessage(role: "user", text: "hi")]
                )
            ],
            deleted: []
        )
        let data = try JSONEncoder().encode(request)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["protocol"] as? String, "bridge/1")
        XCTAssertEqual(object?["full"] as? Bool, true)
    }

    func testTrimmedKeepsTheTailAndClipsText() {
        let messages = (0..<10).map { HubMessage(role: "user", text: String(repeating: "x", count: 20) + "\($0)") }
        let session = HubSession(
            id: "s1",
            title: "t",
            workspace: "/tmp",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            messages: messages
        )
        let trimmed = session.trimmed(maxMessages: 3, maxText: 10)
        XCTAssertEqual(trimmed.messages.count, 3)
        XCTAssertTrue(trimmed.messages.last?.text.hasSuffix("[truncated]") ?? false)
        XCTAssertTrue(trimmed.messages.last?.text.hasPrefix("xxxxxxxxxx") ?? false)
    }

    func testConfigStoreRoundTrip() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = ConfigStore(path: directory.appendingPathComponent("macos.json"))
        XCTAssertNil(try store.load())
        let config = MacConfig(
            hubURL: "http://127.0.0.1:8787",
            instanceToken: "secret",
            deviceName: "mac",
            deviceId: "dev_1",
            deviceToken: "dev_1.secret"
        )
        try store.save(config)
        let loaded = try XCTUnwrap(try store.load())
        XCTAssertEqual(loaded.hubURL, config.hubURL)
        XCTAssertEqual(loaded.deviceToken, "dev_1.secret")
        XCTAssertEqual(loaded.tokenForSync, "dev_1.secret")
        let attributes = try FileManager.default.attributesOfItem(atPath: store.path.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try? FileManager.default.removeItem(at: directory)
    }

    func testDSHReaderParsesV4JSONL() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sessionDir = root.appendingPathComponent("--workspace--").appendingPathComponent("session-abc")
        try FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
        let file = sessionDir.appendingPathComponent("session.v4.jsonl")
        let lines = [
            #"{"type":"session","version":4,"id":"session-abc","createdAt":1767225600000,"cwd":"/Users/me/Dev","origin":"user"}"#,
            #"{"type":"session/title","time":1767225601000,"data":{"title":"Fix the hub"}}"#,
            #"{"type":"user/message","seq":1,"time":1767225602000,"data":{"content":[{"type":"text","text":"please sync sessions"}],"source":{"kind":"user"}}}"#,
            #"{"type":"user/message","seq":2,"time":1767225602500,"data":{"content":[{"type":"text","text":"injected context"}],"source":{"kind":"system-reminder"}}}"#,
            #"{"type":"assistant/message","seq":3,"time":1767225603000,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"think"},{"type":"text","text":"on it"}]}}}"#,
            #"{"type":"tool/call","seq":4,"time":1767225603500,"data":{"name":"read"}}"#
        ]
        try lines.joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)

        let reader = DSHReader(root: root)
        let session = try reader.readSession(id: "session-abc")
        XCTAssertEqual(session.id, "session-abc")
        XCTAssertEqual(session.title, "Fix the hub")
        XCTAssertEqual(session.workspace, "/Users/me/Dev")
        XCTAssertEqual(session.messages.map(\.role), ["user", "assistant"])
        XCTAssertEqual(session.messages[0].text, "please sync sessions")
        XCTAssertEqual(session.messages[1].text, "on it")
        XCTAssertFalse(session.messages.contains { $0.text == "think" })
        XCTAssertFalse(session.messages.contains { $0.text == "injected context" })
        XCTAssertEqual(session.updatedAt, "2026-01-01T00:00:03.500Z")
        try? FileManager.default.removeItem(at: root)
    }

    func testDSHReaderFallsBackToFirstUserLineAsTitle() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sessionDir = root.appendingPathComponent("w").appendingPathComponent("s2")
        try FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
        let file = sessionDir.appendingPathComponent("session.v4.jsonl")
        let lines = [
            #"{"type":"session","version":4,"id":"s2","createdAt":1767225600000,"cwd":"/w"}"#,
            #"{"type":"user/message","seq":1,"time":1767225602000,"data":{"content":[{"type":"text","text":"first line\nsecond line"}],"source":{"kind":"user"}}}"#
        ]
        try lines.joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)
        let session = try DSHReader(root: root).readSession(id: "s2")
        XCTAssertEqual(session.title, "first line")
        try? FileManager.default.removeItem(at: root)
    }
}
