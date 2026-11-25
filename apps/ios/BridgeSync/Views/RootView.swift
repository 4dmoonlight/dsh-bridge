import SwiftUI

struct RootView: View {
  @EnvironmentObject private var store: Store

  var body: some View {
    Group {
      if store.isPaired {
        MainView()
      } else {
        PairingView()
      }
    }
  }
}

/// 用 NavigationStack 而不是 NavigationSplitView:后者在 iPhone 竖屏会折叠,
/// 选中会话不会自动推进详情页(iPad 上才等价)。
struct MainView: View {
  @EnvironmentObject private var store: Store
  @State private var path: [SessionSummary] = []

  var body: some View {
    NavigationStack(path: $path) {
      DeviceList(path: $path)
        .navigationTitle("跨设备")
        .navigationDestination(for: SessionSummary.self) { session in
          SessionView(session: session)
        }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              Button("刷新") { Task { await store.refreshSidebar() } }
              Button("断开并重新配对", role: .destructive) { store.unpair() }
            } label: {
              Image(systemName: "ellipsis.circle")
            }
          }
        }
    }
    .onChange(of: store.pendingOpen) { _, target in
      guard let target else { return }
      path = [target]
      store.pendingOpen = nil
    }
  }
}

struct DeviceList: View {
  @EnvironmentObject private var store: Store
  @Binding var path: [SessionSummary]

  var body: some View {
    List {
      if let err = store.sidebarError {
        Section {
          Text(err).font(.footnote).foregroundStyle(.red)
        }
      }
      ForEach(store.devices) { device in
        Section {
          if device.sessions.isEmpty {
            Text("暂无会话").font(.footnote).foregroundStyle(.secondary)
          } else {
            ForEach(device.sessions) { session in
              NavigationLink(value: session) {
                VStack(alignment: .leading, spacing: 2) {
                  Text(session.title.isEmpty ? session.session_id : session.title)
                    .lineLimit(1)
                    .font(.subheadline)
                  Text("\(session.latest_seq) 条 · \(shortDate(session.updated_at))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
              }
            }
          }
        } header: {
          HStack(spacing: 6) {
            Circle()
              .fill(device.isOnline ? Color.green : Color.secondary)
              .frame(width: 7, height: 7)
            Text(device.device_name)
            Text(device.isOnline ? "在线" : "离线")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
      }
    }
    .refreshable { await store.refreshSidebar() }
    .overlay {
      if store.devices.isEmpty && !store.isLoadingDevices && store.sidebarError == nil {
        ContentUnavailableView("暂无设备", systemImage: "laptopcomputer.and.iphone")
      }
    }
  }

  private func shortDate(_ iso: String?) -> String {
    guard let iso else { return "-" }
    return String(iso.prefix(16)).replacingOccurrences(of: "T", with: " ")
  }
}
