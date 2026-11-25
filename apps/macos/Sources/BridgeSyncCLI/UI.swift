import AppKit
import Combine
import SwiftUI
import BridgeSyncKit

@MainActor
final class SessionModel: ObservableObject {
    @Published var sessions: [SessionSummary] = []
    @Published var selectedID: String? { didSet { if selectedID != oldValue { Task { await loadDetail() } } } }
    @Published var detail: HubSession?
    @Published var status = "not configured"
    @Published var hubURL = ""
    @Published var instanceToken = ""
    @Published var deviceName = ""
    @Published var busy = false
    @Published var showSettings = false

    let configStore: ConfigStore
    let sessionsRoot: String?
    private var config: MacConfig?
    private var client: HubClient?

    init(configStore: ConfigStore, sessionsRoot: String?) {
        self.configStore = configStore
        self.sessionsRoot = sessionsRoot
    }

    func bootstrap() async {
        let loaded = (try? configStore.load()) ?? nil
        guard let config = loaded else {
            status = "no config — open Settings and pair this Mac"
            return
        }
        self.config = config
        hubURL = config.hubURL
        instanceToken = config.instanceToken
        deviceName = config.deviceName
        do {
            client = try configStore.client(for: config)
            await refresh()
        } catch {
            status = "bad config: " + String(describing: error)
        }
    }

    func refresh() async {
        guard let client else { return }
        busy = true
        defer { busy = false }
        do {
            let response = try await client.listSessions(limit: 100)
            sessions = response.sessions
            status = response.sessions.isEmpty
                ? "hub reachable, no sessions yet"
                : "\(response.sessions.count) session(s)"
        } catch {
            status = "refresh failed: " + String(describing: error)
        }
    }

    func loadDetail() async {
        guard let client, let id = selectedID else { detail = nil; return }
        do {
            detail = try await client.session(id: id)
        } catch {
            status = "load failed: " + String(describing: error)
        }
    }

    func saveSettings() async {
        var config = self.config ?? MacConfig(hubURL: hubURL, instanceToken: instanceToken, deviceName: deviceName)
        config.hubURL = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        config.instanceToken = instanceToken.trimmingCharacters(in: .whitespacesAndNewlines)
        config.deviceName = deviceName
        do {
            try configStore.save(config)
            self.config = config
            client = try configStore.client(for: config)
            showSettings = false
            await refresh()
        } catch {
            status = "save failed: " + String(describing: error)
        }
    }

    func registerDevice() async {
        let urlString = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = instanceToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: urlString) else { status = "invalid hub URL"; return }
        busy = true
        defer { busy = false }
        do {
            let response = try await HubClient(baseURL: url, token: token)
                .register(name: deviceName.isEmpty ? "mac" : deviceName, platform: "macos", hostname: ProcessInfo.processInfo.hostName)
            var config = MacConfig(hubURL: urlString, instanceToken: token, deviceName: deviceName)
            config.deviceId = response.device.id
            config.deviceToken = response.token
            try configStore.save(config)
            self.config = config
            client = try configStore.client(for: config)
            status = "paired as " + response.device.id
            await refresh()
        } catch {
            status = "pair failed: " + String(describing: error)
        }
    }

    func pushNow() async {
        guard let client else { return }
        busy = true
        defer { busy = false }
        let root = sessionsRoot ?? DSHReader.defaultRoot().path
        let engine = SyncEngine(reader: DSHReader(root: URL(fileURLWithPath: (root as NSString).expandingTildeInPath)), client: client)
        do {
            let report = try await engine.push(limit: 50)
            status = "pushed \(report.pushed), skipped \(report.skipped), scanned \(report.scanned)"
            await refresh()
        } catch {
            status = "push failed: " + String(describing: error)
        }
    }
}

struct SessionListView: View {
    @ObservedObject var model: SessionModel

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack {
                    Text("Synced sessions").font(.headline)
                    Spacer()
                    Button("Push") { Task { await model.pushNow() } }
                        .disabled(model.busy)
                    Button("Refresh") { Task { await model.refresh() } }
                        .disabled(model.busy)
                    Button("Settings") { model.showSettings = true }
                }
                .padding(10)
                Divider()
                List(selection: $model.selectedID) {
                    ForEach(model.sessions) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                            Text(item.workspace).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                            Text(item.updatedAt).font(.system(size: 10)).foregroundStyle(.tertiary)
                        }
                        .tag(item.id)
                        .padding(.vertical, 3)
                    }
                }
            }
            .frame(minWidth: 320, idealWidth: 340, maxWidth: 420)

            Divider()

            VStack(alignment: .leading, spacing: 0) {
                if let detail = model.detail {
                    Text(detail.title).font(.title3).bold().padding([.horizontal, .top], 12)
                    Text(detail.workspace + " · " + detail.updatedAt)
                        .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12)
                    Divider().padding(.vertical, 8)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(detail.messages.enumerated()), id: \.offset) { _, message in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(message.role.uppercased())
                                        .font(.system(size: 10, weight: .bold))
                                        .foregroundStyle(message.role == "user" ? Color.accentColor : Color.secondary)
                                    Text(message.text).font(.system(size: 12)).textSelection(.enabled)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(12)
                    }
                } else {
                    VStack(spacing: 8) {
                        Text("Select a synced session").font(.title3)
                        Text("The left list is served by your hub; contents stay whatever your Mac pushed.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .overlay(alignment: .bottom) {
            Text(model.status)
                .font(.caption)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity)
                .background(.bar)
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView(model: model)
        }
        .task { await model.bootstrap() }
    }
}

struct SettingsView: View {
    @ObservedObject var model: SessionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Hub settings").font(.headline)
            Text("Instance token is the hub-wide secret; the device token is issued by Register.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Hub URL (http://127.0.0.1:8787)", text: $model.hubURL)
                .textFieldStyle(.roundedBorder)
            TextField("Instance token", text: $model.instanceToken)
                .textFieldStyle(.roundedBorder)
            TextField("Device name", text: $model.deviceName)
                .textFieldStyle(.roundedBorder)
            Divider()
            HStack {
                Button("Save") { Task { await model.saveSettings() } }
                Button("Register device") { Task { await model.registerDevice() } }
                Spacer()
                Button("Close") { model.showSettings = false }
            }
        }
        .padding(18)
        .frame(width: 480)
    }
}

@MainActor
func runUI(configStore: ConfigStore, sessionsRoot: String?) {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)

    let model = SessionModel(configStore: configStore, sessionsRoot: sessionsRoot)
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
    )
    window.title = "Hub Sync"
    window.center()
    window.contentView = NSHostingView(rootView: SessionListView(model: model))
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)

    let mainMenu = NSMenu()
    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit Hub Sync", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu
    app.mainMenu = mainMenu

    app.run()
}
