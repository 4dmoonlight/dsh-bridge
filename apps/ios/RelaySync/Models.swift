import Foundation

/// 与 relay 的 /api/v1 契约保持一致(字段名沿用服务端的 snake_case)。

struct SidebarResponse: Codable {
  let devices: [DeviceGroup]
}

struct DeviceGroup: Codable, Identifiable {
  let device_id: String
  let device_name: String
  let platform: String
  let status: String
  let last_seen_at: String?
  let sessions: [SessionSummary]

  var id: String { device_id }
  var isOnline: Bool { status == "online" }
}

struct SessionSummary: Codable, Identifiable, Hashable {
  let session_id: String
  let title: String
  let latest_seq: Int
  let updated_at: String?

  var id: String { session_id }
}

struct MessagesResponse: Codable {
  let session_id: String?
  let latest_seq: Int?
  let messages: [Message]
  let has_more: Bool?
}

struct Message: Codable, Identifiable {
  let seq: Int
  let msg_id: String
  let device_id: String?
  let role: String
  let content: String
  let created_at: String?

  var id: String { msg_id }
  var isUser: Bool { role == "user" }
}

struct PairingClaim: Codable {
  // 服务端还会回一个 protocol 字段,但那是 Swift 关键字,且这里用不到,故不声明。
  let token: String
}

struct PairingRequest: Codable {
  let code: String
}

struct HeartbeatBody: Codable {
  let device_id: String
  let device_name: String
  let platform: String
}

struct ErrorBody: Codable {
  struct Inner: Codable {
    let code: String
    let message: String?
  }
  let error: Inner
}
