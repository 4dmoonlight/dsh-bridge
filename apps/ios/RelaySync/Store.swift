import Foundation
import SwiftUI

/// 全局状态:配对信息、设备与会话列表、当前打开的会话消息。
@MainActor
final class Store: ObservableObject {
  @Published private(set) var relayURL: URL?
  @Published private(set) var token: String?
  @Published var devices: [DeviceGroup] = []
  @Published var sidebarError: String?
  @Published var isLoadingDevices = false
  @Published var selectedSession: SessionSummary?
  @Published var messages: [Message] = []
  @Published var messagesError: String?
  @Published var isPairing = false
  @Published var pairingError: String?
  /// 由 DEBUG 启动参数或外部动作请求打开某个会话,由视图层消费后清空。
  @Published var pendingOpen: SessionSummary?

  private var sidebarTask: Task<Void, Never>?
  private var messagesTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var lastSeq = 0
  private var seenIds = Set<String>()

  var isPaired: Bool { relayURL != nil && (token?.isEmpty == false) }

  private var client: RelayClient? {
    guard let relayURL, let token else { return nil }
    return RelayClient(relayURL: relayURL, token: token)
  }

  private var deviceId: String {
    if let existing = Keychain.get("device_id") { return existing }
    // 用 identifierForVendor:重装应用后仍然不变,避免每次安装都在别人的侧边栏里
    // 留下一个"离线"幽灵设备。
    let fresh = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
    Keychain.set(fresh, for: "device_id")
    return fresh
  }

  private var deviceName: String {
    let name = UIDevice.current.name
    return name.isEmpty ? "iPhone" : name
  }

  // MARK: - 生命周期

  func restore() {
    #if DEBUG
    // 自动化验证用:从启动参数直接配对,免去模拟器里手工输入。
    // 只在 Debug 构建存在,不会进入发布包。
    let args = ProcessInfo.processInfo.arguments
    if let relayIndex = args.firstIndex(of: "-relayURL"), relayIndex + 1 < args.count,
       let codeIndex = args.firstIndex(of: "-pairCode"), codeIndex + 1 < args.count {
      let relay = args[relayIndex + 1]
      let code = args[codeIndex + 1]
      Task { await pair(relayText: relay, code: code) }
      return
    }
    #endif
    guard let urlString = Keychain.get("relay_url"), let url = URL(string: urlString),
          let saved = Keychain.get("relay_token"), !saved.isEmpty else { return }
    relayURL = url
    token = saved
    startLoops()
  }

  private func startLoops() {
    sidebarTask?.cancel()
    sidebarTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshSidebar()
        try? await Task.sleep(nanoseconds: 5_000_000_000)
      }
    }
    heartbeatTask?.cancel()
    heartbeatTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, let client = self.client else { return }
        await client.heartbeat(deviceId: self.deviceId, deviceName: self.deviceName)
        try? await Task.sleep(nanoseconds: 25_000_000_000)
      }
    }
  }

  // MARK: - 配对

  func pair(relayText: String, code: String) async {
    pairingError = nil
    let trimmed = relayText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), let scheme = url.scheme,
          scheme == "https" || scheme == "http" else {
      pairingError = "中继地址需要以 http:// 或 https:// 开头"
      return
    }
    guard code.count == 6, code.allSatisfy({ $0.isNumber }) else {
      pairingError = "配对码应为 6 位数字"
      return
    }
    isPairing = true
    defer { isPairing = false }
    do {
      let claim = try await RelayClient.claim(relayURL: url, code: code)
      Keychain.set(trimmed, for: "relay_url")
      Keychain.set(claim.token, for: "relay_token")
      relayURL = url
      token = claim.token
      startLoops()
      await refreshSidebar()
      #if DEBUG
      let args = ProcessInfo.processInfo.arguments
      if let idx = args.firstIndex(of: "-autoOpen"), idx + 1 < args.count {
        let target = args[idx + 1]
        for device in devices {
          if let session = device.sessions.first(where: { $0.session_id == target }) {
            pendingOpen = session
            break
          }
        }
      }
      #endif
    } catch {
      pairingError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  func unpair() {
    Keychain.remove("relay_url")
    Keychain.remove("relay_token")
    sidebarTask?.cancel(); messagesTask?.cancel(); heartbeatTask?.cancel()
    relayURL = nil
    token = nil
    devices = []
    selectedSession = nil
    messages = []
  }

  // MARK: - 数据

  func refreshSidebar() async {
    guard let client else { return }
    isLoadingDevices = true
    defer { isLoadingDevices = false }
    do {
      devices = try await client.sidebar().devices
      sidebarError = nil
    } catch {
      sidebarError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  func open(_ session: SessionSummary) {
    selectedSession = session
    messages = []
    messagesError = nil
    lastSeq = 0
    seenIds = []
    Task { await loadInitialMessages() }
    messagesTask?.cancel()
    messagesTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        if Task.isCancelled { return }
        await self?.pollNewMessages()
      }
    }
  }

  func closeSession() {
    messagesTask?.cancel()
    selectedSession = nil
    messages = []
  }

  private func loadInitialMessages() async {
    guard let client, let session = selectedSession else { return }
    do {
      let page = try await client.messages(sessionId: session.session_id, sinceSeq: 0)
      messages = page.messages
      seenIds = Set(page.messages.map(\.msg_id))
      lastSeq = page.messages.last?.seq ?? 0
      messagesError = nil
    } catch {
      messagesError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  private func pollNewMessages() async {
    guard let client, let session = selectedSession else { return }
    do {
      let page = try await client.messages(sessionId: session.session_id, sinceSeq: lastSeq)
      let fresh = page.messages.filter { !seenIds.contains($0.msg_id) }
      guard !fresh.isEmpty else { return }
      for message in fresh { seenIds.insert(message.msg_id) }
      messages.append(contentsOf: fresh)
      lastSeq = fresh.last?.seq ?? lastSeq
      messagesError = nil
    } catch {
      messagesError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }
}
