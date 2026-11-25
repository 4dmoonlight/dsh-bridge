import SwiftUI

@main
struct BridgeSyncApp: App {
  @StateObject private var store = Store()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(store)
        .task { store.restore() }
    }
  }
}
