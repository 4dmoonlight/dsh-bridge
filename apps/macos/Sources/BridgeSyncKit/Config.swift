import Foundation

public struct MacConfig: Codable, Sendable {
    public var hubURL: String
    public var instanceToken: String
    public var deviceName: String
    public var deviceId: String?
    public var deviceToken: String?
    public var lastSyncAt: String?

    public init(
        hubURL: String,
        instanceToken: String,
        deviceName: String,
        deviceId: String? = nil,
        deviceToken: String? = nil,
        lastSyncAt: String? = nil
    ) {
        self.hubURL = hubURL
        self.instanceToken = instanceToken
        self.deviceName = deviceName
        self.deviceId = deviceId
        self.deviceToken = deviceToken
        self.lastSyncAt = lastSyncAt
    }

    public var tokenForSync: String { deviceToken ?? instanceToken }
}

public struct ConfigStore {
    public let path: URL

    public init(path: URL? = nil) {
        self.path = path ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh-bridge")
            .appendingPathComponent("macos.json")
    }

    public func load() throws -> MacConfig? {
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let data = try Data(contentsOf: path)
        return try JSONDecoder().decode(MacConfig.self, from: data)
    }

    public func save(_ config: MacConfig) throws {
        let directory = path.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: path, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    public func client(for config: MacConfig, timeout: TimeInterval = 30) throws -> HubClient {
        guard let url = URL(string: config.hubURL), url.scheme != nil else {
            throw HubError(status: 0, code: "bad_hub_url", message: "invalid hub URL: " + config.hubURL)
        }
        return HubClient(baseURL: url, token: config.tokenForSync, timeout: timeout)
    }
}
