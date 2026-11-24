import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct RelayError: Error, CustomStringConvertible, Sendable {
    public var status: Int
    public var code: String
    public var message: String

    public init(status: Int, code: String, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    public var description: String { "relay error \(status) \(code): \(message)" }
}

public final class RelayClient: @unchecked Sendable {
    public let baseURL: URL
    private let token: String
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(baseURL: URL, token: String, timeout: TimeInterval = 30) {
        self.baseURL = baseURL
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout + 10
        configuration.waitsForConnectivity = false
        self.session = URLSession(configuration: configuration)
    }

    public func health() async throws -> [String: Any] {
        let data = try await rawRequest(method: "GET", path: "/healthz")
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    public func register(name: String, platform: String = "macos", hostname: String? = nil) async throws -> RegisterResponse {
        struct Body: Encodable { var name: String; var platform: String; var hostname: String? }
        return try await request(
            method: "POST",
            path: "/v1/devices/register",
            body: Body(name: name, platform: platform, hostname: hostname)
        )
    }

    public func sync(sessions: [RelaySession], full: Bool = false, deleted: [String] = []) async throws -> SyncResponse {
        try await request(
            method: "POST",
            path: "/v1/sessions/sync",
            body: SyncRequest(full: full, sessions: sessions, deleted: deleted)
        )
    }

    public func listSessions(limit: Int = 50, query: String? = nil, deviceId: String? = nil) async throws -> SessionListResponse {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let deviceId, !deviceId.isEmpty { items.append(URLQueryItem(name: "device", value: deviceId)) }
        return try await request(method: "GET", path: "/v1/sessions", query: items)
    }

    public func session(id: String) async throws -> RelaySession {
        let response: SessionResponse = try await request(method: "GET", path: "/v1/sessions/" + escaped(id))
        return response.session
    }

    public func devices() async throws -> [DeviceInfo] {
        struct Envelope: Decodable { var devices: [DeviceInfo] }
        let envelope: Envelope = try await request(method: "GET", path: "/v1/devices")
        return envelope.devices
    }

    /// Ask the relay to fetch a session from an online host; can fall back to the stored copy.
    public func relayFetch(sessionId: String, deviceId: String, fallbackStored: Bool = true) async throws -> RelayFetchResponse {
        struct Body: Encodable { var deviceId: String; var fallback: String?; var timeoutMs: Int }
        return try await request(
            method: "POST",
            path: "/v1/relay/sessions/" + escaped(sessionId) + "/fetch",
            body: Body(deviceId: deviceId, fallback: fallbackStored ? "stored" : nil, timeoutMs: 5000)
        )
    }

    /// Park one host command poll. Returns nil when the relay has nothing within waitSeconds.
    public func pollHostCommand(waitSeconds: Int = 20) async throws -> HostCommand? {
        var request = makeRequest(
            method: "GET",
            path: "/v1/host/commands",
            query: [URLQueryItem(name: "wait", value: String(waitSeconds))]
        )
        request.timeoutInterval = TimeInterval(waitSeconds + 15)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        guard let http = response as? HTTPURLResponse, http.statusCode != 204, !data.isEmpty else { return nil }
        return try decoder.decode(HostCommandEnvelope.self, from: data).command
    }

    public func reportHostResult(commandId: String, session: RelaySession?) async throws {
        let envelope = HostResultEnvelope(
            ok: session != nil,
            result: session.map { SessionFetchResult(session: $0) },
            error: session == nil ? HostError(code: "session_not_found", message: "host could not read the session") : nil
        )
        _ = try await rawRequest(
            method: "POST",
            path: "/v1/host/commands/" + escaped(commandId) + "/result",
            bodyData: try encoder.encode(envelope)
        )
    }

    // MARK: - Transport

    private func request<Response: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = []
    ) async throws -> Response {
        let data = try await rawRequest(method: method, path: path, query: query)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw RelayError(status: 0, code: "decode_failed", message: String(describing: error))
        }
    }

    private func request<Response: Decodable>(
        method: String,
        path: String,
        body: some Encodable
    ) async throws -> Response {
        let data = try await rawRequest(method: method, path: path, bodyData: try encoder.encode(body))
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw RelayError(status: 0, code: "decode_failed", message: String(describing: error))
        }
    }

    private func rawRequest(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        bodyData: Data? = nil
    ) async throws -> Data {
        var request = makeRequest(method: method, path: path, query: query)
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return data
    }

    private func makeRequest(method: String, path: String, query: [URLQueryItem] = []) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("Bearer " + token, forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("relay-sync-macos/" + RelayProtocol.version, forHTTPHeaderField: "user-agent")
        return request
    }

    private func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw RelayError(status: 0, code: "no_response", message: "not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let envelope = try? decoder.decode(ErrorEnvelope.self, from: data) {
                throw RelayError(status: http.statusCode, code: envelope.error.code, message: envelope.error.message ?? "")
            }
            throw RelayError(status: http.statusCode, code: "http_error", message: "HTTP " + String(http.statusCode))
        }
    }

    private func escaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
