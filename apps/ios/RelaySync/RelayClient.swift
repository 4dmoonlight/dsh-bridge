import Foundation

enum RelayError: LocalizedError {
  case invalidURL
  case http(Int, String)
  case decoding

  var errorDescription: String? {
    switch self {
    case .invalidURL: return "中继地址无效"
    case let .http(status, message): return "\(message)(HTTP \(status))"
    case .decoding: return "响应格式不符合预期"
    }
  }
}

/// Relay 的 /api/v1 客户端。认领配对码时不需要鉴权(此时还没有 token)。
struct RelayClient {
  let relayURL: URL
  var token: String?

  private func makeURL(_ path: String) throws -> URL {
    guard let url = URL(string: path, relativeTo: relayURL) else { throw RelayError.invalidURL }
    return url
  }

  private func send(
    _ path: String,
    method: String = "GET",
    body: Data? = nil,
    authenticated: Bool = true
  ) async throws -> Data {
    var request = URLRequest(url: try makeURL(path))
    request.httpMethod = method
    request.timeoutInterval = 20
    if authenticated, let token, !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw RelayError.decoding }
    guard (200..<300).contains(http.statusCode) else {
      let code = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error.code ?? "unknown"
      throw RelayError.http(http.statusCode, code)
    }
    return data
  }

  /// 用一次性配对码换取 token。免鉴权。
  static func claim(relayURL: URL, code: String) async throws -> PairingClaim {
    let body = try JSONEncoder().encode(PairingRequest(code: code))
    let probe = RelayClient(relayURL: relayURL, token: nil)
    let data = try await probe.send("/api/v1/pairing/claim", method: "POST", body: body, authenticated: false)
    guard let claim = try? JSONDecoder().decode(PairingClaim.self, from: data) else { throw RelayError.decoding }
    return claim
  }

  func sidebar() async throws -> SidebarResponse {
    let data = try await send("/api/v1/sidebar")
    guard let out = try? JSONDecoder().decode(SidebarResponse.self, from: data) else { throw RelayError.decoding }
    return out
  }

  func messages(sessionId: String, sinceSeq: Int, limit: Int = 200) async throws -> MessagesResponse {
    let escaped = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
    let data = try await send("/api/v1/sessions/\(escaped)/messages?since_seq=\(sinceSeq)&limit=\(limit)")
    guard let out = try? JSONDecoder().decode(MessagesResponse.self, from: data) else { throw RelayError.decoding }
    return out
  }

  func heartbeat(deviceId: String, deviceName: String) async {
    let body = try? JSONEncoder().encode(HeartbeatBody(device_id: deviceId, device_name: deviceName, platform: "ios"))
    _ = try? await send("/api/v1/devices/heartbeat", method: "POST", body: body)
  }
}
