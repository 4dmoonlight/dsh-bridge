import SwiftUI

@main
struct RelaySyncApp: App {
  @StateObject private var store = Store()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(store)
        .task { store.restore() }
    }
  }
}
