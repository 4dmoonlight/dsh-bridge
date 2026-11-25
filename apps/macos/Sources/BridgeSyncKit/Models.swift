import Foundation

public enum HubProtocol {
    public static let version = "bridge/1"
}

public struct HubMessage: Codable, Hashable, Sendable {
    public var role: String
    public var text: String
    public var createdAt: String?

    public init(role: String, text: String, createdAt: String? = nil) {
        self.role = role
        self.text = text
        self.createdAt = createdAt
    }
}

public struct HubSession: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var workspace: String
    public var engine: String
    public var createdAt: String
    public var updatedAt: String
    public var messages: [HubMessage]
    public var deviceId: String?

    public init(
        id: String,
        title: String,
        workspace: String,
        engine: String = "dsh",
        createdAt: String,
        updatedAt: String,
        messages: [HubMessage],
        deviceId: String? = nil
    ) {
        self.id = id
        self.title = title
        self.workspace = workspace
        self.engine = engine
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messages = messages
        self.deviceId = deviceId
    }

    /// Keep the hub payload bounded: the last maxMessages messages, each clipped.
    public func trimmed(maxMessages: Int = 200, maxText: Int = 8000) -> HubSession {
        var copy = self
        copy.messages = messages.suffix(maxMessages).map { message in
            var trimmed = message
            if trimmed.text.count > maxText {
                trimmed.text = String(trimmed.text.prefix(maxText)) + "\n…[truncated]"
            }
            return trimmed
        }
        return copy
    }
}

public struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var deviceId: String?
    public var title: String
    public var workspace: String
    public var engine: String
    public var createdAt: String
    public var updatedAt: String
    public var messageCount: Int
    public var revision: Int?
    public var preview: String?
}

public struct DeviceInfo: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var platform: String
    public var hostname: String?
    public var createdAt: String
    public var lastSeenAt: String
    public var online: Bool?
    public var revoked: Bool?
}

public struct RegisterResponse: Codable, Sendable {
    public var protocolVersion: String?
    public var device: DeviceInfo
    public var token: String
    public var rotated: Bool?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case device, token, rotated
    }
}

public struct SyncRequest: Codable, Sendable {
    public var protocolVersion: String = HubProtocol.version
    public var full: Bool
    public var sessions: [HubSession]
    public var deleted: [String]

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case full, sessions, deleted
    }
}

public struct SyncResponse: Codable, Sendable {
    public var ok: Bool
    public var accepted: [String]
    public var skipped: [String]
    public var removed: [String]
    public var cursor: Int
}

public struct SessionListResponse: Codable, Sendable {
    public var sessions: [SessionSummary]
    public var nextCursor: String?
    public var total: Int?
}

public struct SessionResponse: Codable, Sendable {
    public var session: HubSession
}

public struct HubFetchResponse: Codable, Sendable {
    public var source: String
    public var session: HubSession?
}

public struct HostCommand: Codable, Sendable {
    public struct Params: Codable, Sendable {
        public var sessionId: String?
    }
    public var id: String
    public var method: String
    public var params: Params?
}

public struct HostCommandEnvelope: Codable, Sendable {
    public var command: HostCommand
}

public struct SessionFetchResult: Codable, Sendable {
    public var session: HubSession
}

public struct HostResultEnvelope: Codable, Sendable {
    public var ok: Bool
    public var result: SessionFetchResult?
    public var error: HostError?
}

public struct HostError: Codable, Sendable {
    public var code: String
    public var message: String?
}

public struct ErrorEnvelope: Codable, Sendable {
    public struct Detail: Codable, Sendable {
        public var code: String
        public var message: String?
    }
    public var error: Detail
}
